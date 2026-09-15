import type { PluggyItem, PluggyAccount, PluggyBill, PluggyTransaction, Paged, TransactionQuery, PluggyApi } from './types';

export const PLUGGY_BASE_URL = 'https://api.pluggy.ai';

/** API keys are valid for 2 hours; refresh a little early to avoid a race at the edge. */
const API_KEY_TTL_MS = 2 * 60 * 60 * 1000;
const API_KEY_SKEW_MS = 5 * 60 * 1000;

export class PluggyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'PluggyError';
  }

  /**
   * On a restricted plan some endpoints are permanently unavailable, answering
   * 403 or 401 even with a valid API key. Callers degrade gracefully instead of
   * treating it as a transport failure. Genuinely bad credentials fail earlier,
   * inside authenticate(), with a different message.
   */
  get isForbidden(): boolean {
    return this.status === 403 || this.status === 401;
  }
}

export interface PluggyClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests so retry backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PluggyClient implements PluggyApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;

  private apiKey: string | null = null;
  private apiKeyExpiresAt = 0;
  /** Single in-flight auth so concurrent callers don't stampede POST /auth. */
  private authInFlight: Promise<string> | null = null;

  constructor(private readonly opts: PluggyClientOptions) {
    this.baseUrl = opts.baseUrl ?? PLUGGY_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  // -- auth ----------------------------------------------------------------

  private async getApiKey(): Promise<string> {
    if (this.apiKey && this.now() < this.apiKeyExpiresAt) return this.apiKey;
    this.authInFlight ??= this.authenticate().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async authenticate(): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: this.opts.clientId, clientSecret: this.opts.clientSecret }),
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new PluggyError(`Pluggy authentication failed (${res.status})`, res.status, '/auth', body);
    }
    const key = (body as { apiKey?: string }).apiKey;
    if (!key) throw new PluggyError('Pluggy /auth returned no apiKey', 500, '/auth', body);
    this.apiKey = key;
    this.apiKeyExpiresAt = this.now() + API_KEY_TTL_MS - API_KEY_SKEW_MS;
    return key;
  }

  private invalidateApiKey(): void {
    this.apiKey = null;
    this.apiKeyExpiresAt = 0;
  }

  // -- transport -----------------------------------------------------------

  async request<T>(path: string, init: RequestInit = {}, opts: { retryAuth?: boolean } = {}): Promise<T> {
    const retryAuth = opts.retryAuth ?? true;
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const method = init.method ?? 'GET';

    for (let attempt = 0; ; attempt++) {
      const apiKey = await this.getApiKey();
      const started = this.now();
      const res = await this.fetchImpl(url, {
        ...init,
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json', ...(init.headers ?? {}) },
      });
      this.opts.onRequest?.({ method, path, status: res.status, ms: this.now() - started });

      if (res.ok) return (await readJson(res)) as T;

      const body = await readJson(res);

      // An expired key looks like 401/403. Refresh and retry EXACTLY once — a
      // permanent free-tier 403 must not become an infinite loop.
      if ((res.status === 401 || res.status === 403) && retryAuth) {
        this.invalidateApiKey();
        return this.request<T>(path, init, { retryAuth: false });
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
        await this.sleep(delay);
        continue;
      }

      throw new PluggyError(
        `Pluggy ${method} ${path} failed (${res.status})`,
        res.status,
        path,
        body,
      );
    }
  }

  // -- endpoints -----------------------------------------------------------

  async listItems(): Promise<PluggyItem[]> {
    const res = await this.request<Paged<PluggyItem>>('/items');
    return res.results ?? [];
  }

  getItem(itemId: string): Promise<PluggyItem> {
    return this.request<PluggyItem>(`/items/${itemId}`);
  }

  /** Triggers a fresh collection at the institution. Rate-limited by Pluggy to 20/min. */
  patchItem(itemId: string): Promise<PluggyItem> {
    return this.request<PluggyItem>(`/items/${itemId}`, { method: 'PATCH' });
  }

  async listAccounts(itemId: string): Promise<PluggyAccount[]> {
    const res = await this.request<Paged<PluggyAccount>>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    return res.results ?? [];
  }

  async listBills(accountId: string): Promise<PluggyBill[]> {
    const res = await this.request<Paged<PluggyBill>>(`/bills?accountId=${encodeURIComponent(accountId)}`);
    return res.results ?? [];
  }

  /**
   * Yields pages rather than a flat array so a large backfill never has to be held
   * in memory at once, and so the caller can commit page by page.
   */
  async *listTransactions(query: TransactionQuery): AsyncIterable<PluggyTransaction[]> {
    let path = buildTransactionsPath(query);
    let guard = 0;
    while (path) {
      const res = await this.request<Paged<PluggyTransaction>>(path);
      yield res.results ?? [];
      const next = res.next;
      if (!next) return;
      path = resolveNextPage(next);
      // Defensive: a malformed `next` that never terminates would otherwise hang the sync.
      if (++guard > 500) throw new Error(`Pluggy transactions pagination exceeded 500 pages for ${query.accountId}`);
    }
  }
}

/** v1 /transactions returns 410 ENDPOINT_DEPRECATED; v2 is the cursor-paginated one. */
export const TRANSACTIONS_PATH = '/v2/transactions';

/**
 * Turn a `next` cursor into a request path.
 *
 * Pluggy returns it as a bare QUERY STRING to append to the endpoint path
 * ("?accountId=…&after=…"), not as a path. Treating it as one yields "/?accountId=…",
 * which drops /v2/transactions and 403s.
 */
export function resolveNextPage(next: string, basePath: string = TRANSACTIONS_PATH): string {
  if (next.startsWith('http')) return next;
  if (next.startsWith('?')) return `${basePath}${next}`;
  if (next.startsWith('/')) return next;
  return `${basePath}?${next}`;
}

export function buildTransactionsPath(query: TransactionQuery): string {
  const p = new URLSearchParams({ accountId: query.accountId });
  if (query.createdAtFrom && query.dateFrom) {
    throw new Error('Pluggy rejects createdAtFrom combined with dateFrom');
  }
  if (query.createdAtFrom) p.set('createdAtFrom', query.createdAtFrom);
  if (query.dateFrom) p.set('dateFrom', query.dateFrom);
  if (query.dateTo) p.set('dateTo', query.dateTo);
  if (query.ids?.length) p.set('ids', query.ids.join(','));
  // No pageSize: v2 rejects it ("property pageSize should not exist") because the
  // cursor controls paging. query.pageSize survives only as a knob for FakePluggy,
  // so tests can exercise the cursor loop without 500-row fixtures.
  return `${TRANSACTIONS_PATH}?${p.toString()}`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Builds a client from the environment. Throws early with an actionable message. */
export function clientFromEnv(overrides: Partial<PluggyClientOptions> = {}): PluggyClient {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET. Create them at https://dashboard.pluggy.ai and put them in .env.local',
    );
  }
  return new PluggyClient({ clientId, clientSecret, ...overrides });
}
