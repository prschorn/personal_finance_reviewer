import { describe, it, expect } from 'vitest';
import { FakePluggy } from './fake';
import { PluggyError } from './client';

function setup() {
  const fake = new FakePluggy({ startTime: '2026-03-01T00:00:00.000Z' });
  fake.addItem({ id: 'item-1' });
  fake.addAccount({ id: 'acc-1', itemId: 'item-1' });
  return fake;
}

async function collect(fake: FakePluggy, query: Parameters<FakePluggy['listTransactions']>[0]) {
  const out = [];
  for await (const page of fake.listTransactions(query)) out.push(...page);
  return out;
}

describe('date filtering', () => {
  it('honours dateFrom and dateTo against the transaction date', async () => {
    const fake = setup();
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-01-15T00:00:00.000Z' });
    fake.add({ id: 'b', accountId: 'acc-1', amount: -20, date: '2026-02-15T00:00:00.000Z' });
    fake.add({ id: 'c', accountId: 'acc-1', amount: -30, date: '2026-03-15T00:00:00.000Z' });

    expect((await collect(fake, { accountId: 'acc-1', dateFrom: '2026-02-01' })).map((t) => t.id)).toEqual(['b', 'c']);
    expect((await collect(fake, { accountId: 'acc-1', dateTo: '2026-02-28' })).map((t) => t.id)).toEqual(['a', 'b']);
    expect(
      (await collect(fake, { accountId: 'acc-1', dateFrom: '2026-02-01', dateTo: '2026-02-28' })).map((t) => t.id),
    ).toEqual(['b']);
  });

  it('scopes to the requested account', async () => {
    const fake = setup();
    fake.addAccount({ id: 'acc-2', itemId: 'item-1' });
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-03-01T00:00:00.000Z' });
    fake.add({ id: 'b', accountId: 'acc-2', amount: -10, date: '2026-03-01T00:00:00.000Z' });
    expect((await collect(fake, { accountId: 'acc-1' })).map((t) => t.id)).toEqual(['a']);
  });
});

describe('createdAtFrom', () => {
  // Window A's entire purpose: surface rows created recently but dated long ago.
  it('filters on creation instant, not on transaction date', async () => {
    const fake = new FakePluggy({ startTime: '2026-01-05T00:00:00.000Z' });
    fake.addItem({ id: 'item-1' });
    fake.addAccount({ id: 'acc-1', itemId: 'item-1' });
    fake.add({ id: 'old', accountId: 'acc-1', amount: -10, date: '2026-01-05T00:00:00.000Z' });
    fake.advanceDays(60);
    // A January-dated transaction that Pluggy only just discovered.
    fake.add({ id: 'late', accountId: 'acc-1', amount: -20, date: '2026-01-06T00:00:00.000Z' });

    const recent = await collect(fake, { accountId: 'acc-1', createdAtFrom: '2026-02-01T00:00:00.000Z' });
    expect(recent.map((t) => t.id)).toEqual(['late']);
  });

  it('rejects being combined with dateFrom, as Pluggy does', async () => {
    const fake = setup();
    await expect(collect(fake, { accountId: 'acc-1', createdAtFrom: 'x', dateFrom: 'y' })).rejects.toThrow(
      PluggyError,
    );
  });
});

describe('pagination', () => {
  it('pages at the requested size and returns every row exactly once', async () => {
    const fake = setup();
    for (let i = 0; i < 7; i++) {
      fake.add({ id: `t${i}`, accountId: 'acc-1', amount: -1, date: `2026-03-0${i + 1}T00:00:00.000Z` });
    }
    const pages: string[][] = [];
    for await (const page of fake.listTransactions({ accountId: 'acc-1', pageSize: 2 })) {
      pages.push(page.map((t) => t.id));
    }
    expect(pages).toEqual([['t0', 't1'], ['t2', 't3'], ['t4', 't5'], ['t6']]);
  });

  it('yields a single empty page when nothing matches', async () => {
    const fake = setup();
    const pages = [];
    for await (const page of fake.listTransactions({ accountId: 'acc-1' })) pages.push(page);
    expect(pages).toEqual([[]]);
  });
});

describe('mutation API models real Pluggy behaviour', () => {
  it('post() settles in place, keeping the id', async () => {
    const fake = setup();
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-03-01T00:00:00.000Z', status: 'PENDING' });
    fake.post('a', { amount: -12 });
    const [tx] = await collect(fake, { accountId: 'acc-1' });
    expect(tx).toMatchObject({ id: 'a', status: 'POSTED', amount: -12 });
  });

  it('deleteAndRecreate() swaps in a new id, as Pluggy does on a material change', async () => {
    const fake = setup();
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-03-01T00:00:00.000Z', status: 'PENDING' });
    const recreated = fake.deleteAndRecreate('a', { status: 'POSTED', amount: -11 });
    expect(recreated.id).not.toBe('a');
    const live = await collect(fake, { accountId: 'acc-1' });
    expect(live.map((t) => t.id)).toEqual([recreated.id]);
  });

  it('a recreated row surfaces via createdAtFrom even though its date is old', async () => {
    const fake = new FakePluggy({ startTime: '2026-01-10T00:00:00.000Z' });
    fake.addItem({ id: 'item-1' });
    fake.addAccount({ id: 'acc-1', itemId: 'item-1' });
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-01-10T00:00:00.000Z' });
    fake.advanceDays(60);
    const recreated = fake.deleteAndRecreate('a', { amount: -11 });
    const recent = await collect(fake, { accountId: 'acc-1', createdAtFrom: '2026-02-20T00:00:00.000Z' });
    expect(recent.map((t) => t.id)).toEqual([recreated.id]);
  });

  it('remove() deletes outright', async () => {
    const fake = setup();
    fake.add({ id: 'a', accountId: 'acc-1', amount: -10, date: '2026-03-01T00:00:00.000Z' });
    fake.remove('a');
    expect(await collect(fake, { accountId: 'acc-1' })).toEqual([]);
  });
});

describe('free-tier simulation', () => {
  it('403s GET /items when configured to', async () => {
    const fake = new FakePluggy({ forbidListItems: true });
    const err = await fake.listItems().catch((e) => e);
    expect(err).toBeInstanceOf(PluggyError);
    expect(err.isForbidden).toBe(true);
  });

  it('still serves GET /items/{id} when listing is forbidden', async () => {
    const fake = new FakePluggy({ forbidListItems: true });
    fake.addItem({ id: 'item-1' });
    await expect(fake.getItem('item-1')).resolves.toMatchObject({ id: 'item-1' });
  });

  it('403s bills when configured to', async () => {
    const fake = new FakePluggy({ forbidBills: true });
    await expect(fake.listBills('acc-1')).rejects.toThrow(PluggyError);
  });
});
