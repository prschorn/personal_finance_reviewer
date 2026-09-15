import { describe, it, expect, vi } from 'vitest';
import { PluggyClient, PluggyError, buildTransactionsPath, resolveNextPage } from './client';

interface Stub { status?: number; body?: unknown; headers?: Record<string, string> }

/** A fetch double that replays a scripted sequence and records what it was called with. */
function scriptedFetch(stubs: Stub[]) {
  const calls: { url: string; method: string; apiKey?: string }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? 'GET', apiKey: headers['X-API-KEY'] });
    const stub = stubs[Math.min(i++, stubs.length - 1)]!;
    const status = stub.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => stub.headers?.[k] ?? null },
      text: async () => (stub.body === undefined ? '' : JSON.stringify(stub.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const AUTH_OK: Stub = { body: { apiKey: 'key-1' } };

function makeClient(stubs: Stub[], over: Partial<ConstructorParameters<typeof PluggyClient>[0]> = {}) {
  const { impl, calls } = scriptedFetch(stubs);
  const client = new PluggyClient({
    clientId: 'cid', clientSecret: 'secret', fetchImpl: impl,
    sleep: async () => {}, ...over,
  });
  return { client, calls };
}

describe('authentication', () => {
  it('authenticates once and reuses the key across requests', async () => {
    const { client, calls } = makeClient([AUTH_OK, { body: { results: [] } }, { body: { results: [] } }]);
    await client.listItems();
    await client.listItems();
    expect(calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(1);
    expect(calls[1]!.apiKey).toBe('key-1');
  });

  it('re-authenticates after the 2h key expires', async () => {
    let clock = 0;
    const { client, calls } = makeClient(
      [AUTH_OK, { body: { results: [] } }, { body: { apiKey: 'key-2' } }, { body: { results: [] } }],
      { now: () => clock },
    );
    await client.listItems();
    clock += 2 * 60 * 60 * 1000; // past TTL minus skew
    await client.listItems();
    expect(calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(2);
    expect(calls.at(-1)!.apiKey).toBe('key-2');
  });

  it('does not stampede /auth under concurrent callers', async () => {
    const { client, calls } = makeClient([AUTH_OK, { body: { results: [] } }]);
    await Promise.all([client.listItems(), client.listItems(), client.listItems()]);
    expect(calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(1);
  });

  it('surfaces bad credentials rather than retrying forever', async () => {
    const { client } = makeClient([{ status: 401, body: { message: 'bad creds' } }]);
    await expect(client.listItems()).rejects.toThrow(/authentication failed \(401\)/);
  });
});

describe('403 handling', () => {
  // The free "Meu Pluggy" tier 403s some endpoints permanently. One retry, then stop.
  it('refreshes the key and retries exactly once, then gives up', async () => {
    const { client, calls } = makeClient([
      AUTH_OK,
      { status: 403, body: { message: 'forbidden' } },
      { body: { apiKey: 'key-2' } },
      { status: 403, body: { message: 'forbidden' } },
    ]);
    const err = await client.listItems().catch((e) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect(err.isForbidden).toBe(true);
    expect(calls.filter((c) => c.url.includes('/items'))).toHaveLength(2);
  });

  it('treats a persistent 401 on a data endpoint as unavailable, not a crash', async () => {
    const { client } = makeClient([
      AUTH_OK,
      { status: 401 },
      { body: { apiKey: 'key-2' } },
      { status: 401 },
    ]);
    const err = await client.listItems().catch((e) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect(err.isForbidden).toBe(true);
  });

  it('succeeds when the 403 really was just an expired key', async () => {
    const { client } = makeClient([
      AUTH_OK,
      { status: 401 },
      { body: { apiKey: 'key-2' } },
      { body: { results: [{ id: 'item-1' }] } },
    ]);
    await expect(client.listItems()).resolves.toHaveLength(1);
  });
});

describe('retry policy', () => {
  it('retries 429 and 5xx with backoff', async () => {
    const sleeps: number[] = [];
    const { client, calls } = makeClient(
      [AUTH_OK, { status: 429 }, { status: 503 }, { body: { results: [{ id: 'a' }] } }],
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    await expect(client.listItems()).resolves.toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/items'))).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('honours Retry-After', async () => {
    const sleeps: number[] = [];
    const { client } = makeClient(
      [AUTH_OK, { status: 429, headers: { 'Retry-After': '60' } }, { body: { results: [] } }],
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    await client.listItems();
    expect(sleeps).toEqual([60_000]);
  });

  it('gives up after maxRetries', async () => {
    const { client } = makeClient([AUTH_OK, { status: 500 }], { maxRetries: 2 });
    await expect(client.listItems()).rejects.toThrow(/failed \(500\)/);
  });

  it('does not retry a 404', async () => {
    const { client, calls } = makeClient([AUTH_OK, { status: 404 }]);
    await expect(client.getItem('nope')).rejects.toThrow(/failed \(404\)/);
    expect(calls.filter((c) => c.url.includes('/items/'))).toHaveLength(1);
  });
});

describe('resolveNextPage', () => {
  // Pluggy hands back a bare query string. Treating it as a path produces
  // "/?accountId=…", which silently drops /v2/transactions and 403s.
  it('appends a bare query string to the endpoint path', () => {
    expect(resolveNextPage('?accountId=a&after=CUR')).toBe('/v2/transactions?accountId=a&after=CUR');
    expect(resolveNextPage('accountId=a&after=CUR')).toBe('/v2/transactions?accountId=a&after=CUR');
  });

  it('passes through an absolute URL or a full path', () => {
    expect(resolveNextPage('https://api.pluggy.ai/v2/transactions?after=X')).toBe('https://api.pluggy.ai/v2/transactions?after=X');
    expect(resolveNextPage('/v2/transactions?after=X')).toBe('/v2/transactions?after=X');
  });
});

describe('listTransactions pagination', () => {
  it('follows a bare query-string cursor without losing the endpoint path', async () => {
    const { client, calls } = makeClient([
      AUTH_OK,
      { body: { results: [{ id: 't1' }, { id: 't2' }], next: '?accountId=a&after=CUR1' } },
      { body: { results: [{ id: 't3' }], next: null } },
    ]);
    const pages: string[][] = [];
    for await (const page of client.listTransactions({ accountId: 'a' })) {
      pages.push(page.map((t) => t.id));
    }
    expect(pages).toEqual([['t1', 't2'], ['t3']]);
    expect(calls.at(-1)!.url).toContain('/v2/transactions?accountId=a&after=CUR1');
  });

  it('stops on a page with no next', async () => {
    const { client } = makeClient([AUTH_OK, { body: { results: [{ id: 't1' }] } }]);
    const pages = [];
    for await (const page of client.listTransactions({ accountId: 'a' })) pages.push(page);
    expect(pages).toHaveLength(1);
  });
});

describe('buildTransactionsPath', () => {
  // The unversioned /transactions endpoint returns 410 ENDPOINT_DEPRECATED.
  it('targets the v2 cursor-paginated endpoint', () => {
    expect(buildTransactionsPath({ accountId: 'a' })).toMatch(/^\/v2\/transactions\?/);
  });

  // v2 rejects pageSize outright; the cursor controls paging.
  it('never sends pageSize to the API', () => {
    expect(buildTransactionsPath({ accountId: 'a', pageSize: 2 })).not.toContain('pageSize');
  });

  it('always sends accountId', () => {
    expect(buildTransactionsPath({ accountId: 'a' })).toBe('/v2/transactions?accountId=a');
  });

  it('supports each window independently', () => {
    expect(buildTransactionsPath({ accountId: 'a', dateFrom: '2026-01-01', dateTo: '2026-03-01' })).toBe(
      '/v2/transactions?accountId=a&dateFrom=2026-01-01&dateTo=2026-03-01',
    );
    expect(buildTransactionsPath({ accountId: 'a', createdAtFrom: '2026-01-01T00:00:00.000Z' })).toContain(
      'createdAtFrom=2026-01-01T00%3A00%3A00.000Z',
    );
  });

  // Pluggy rejects this combination; fail locally with a clear message instead.
  it('refuses to combine createdAtFrom with dateFrom', () => {
    expect(() => buildTransactionsPath({ accountId: 'a', createdAtFrom: 'x', dateFrom: 'y' })).toThrow(
      /cannot|rejects/i,
    );
  });
});
