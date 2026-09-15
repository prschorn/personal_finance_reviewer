import { PluggyError } from './client';
import { buildTransactionsPath } from './client';
import type {
  PluggyApi, PluggyItem, PluggyAccount, PluggyBill, PluggyTransaction,
  TransactionQuery, ItemStatus, ExecutionStatus,
} from './types';

/**
 * In-memory Pluggy double for tests.
 *
 * It honours dateFrom / dateTo / createdAtFrom / pageSize / cursor FOR REAL, so the
 * two-window sync logic is genuinely exercised rather than stubbed past. Its
 * mutation API models the behaviours actually observed from Pluggy — in particular
 * delete-and-recreate, which is what makes reconciliation hard.
 */

interface StoredTransaction extends PluggyTransaction {
  /** Server-side creation instant, what createdAtFrom filters on. */
  _createdAt: string;
}

export interface FakePluggyOptions {
  /** Simulate the free "Meu Pluggy" tier, where GET /items is forbidden. */
  forbidListItems?: boolean;
  forbidBills?: boolean;
  /** Default page size when a query doesn't specify one. */
  defaultPageSize?: number;
  startTime?: string;
}

export class FakePluggy implements PluggyApi {
  readonly items = new Map<string, PluggyItem>();
  readonly accounts = new Map<string, PluggyAccount>();
  readonly bills = new Map<string, PluggyBill[]>();
  private readonly txs = new Map<string, StoredTransaction>();

  /** Every request the sync layer made, for asserting on call patterns. */
  readonly calls: { method: string; query?: TransactionQuery; path?: string }[] = [];

  private clock: number;
  private seq = 0;

  constructor(private readonly opts: FakePluggyOptions = {}) {
    this.clock = Date.parse(opts.startTime ?? '2026-03-15T12:00:00.000Z');
  }

  // -- clock ---------------------------------------------------------------

  now(): string {
    return new Date(this.clock).toISOString();
  }

  advanceDays(days: number): this {
    this.clock += days * 86_400_000;
    return this;
  }

  advanceMs(ms: number): this {
    this.clock += ms;
    return this;
  }

  // -- fixture construction ------------------------------------------------

  addItem(item: Partial<PluggyItem> & { id: string }): PluggyItem {
    const full: PluggyItem = {
      status: 'UPDATED',
      executionStatus: 'SUCCESS',
      lastUpdatedAt: this.now(),
      connector: { id: 200, name: 'Meu Pluggy' },
      ...item,
    };
    this.items.set(full.id, full);
    return full;
  }

  addAccount(account: Partial<PluggyAccount> & { id: string; itemId: string }): PluggyAccount {
    const full: PluggyAccount = {
      type: 'BANK',
      subtype: 'CHECKING_ACCOUNT',
      name: 'Conta',
      number: '0001',
      balance: 0,
      currencyCode: 'BRL',
      ...account,
    };
    this.accounts.set(full.id, full);
    return full;
  }

  addBills(accountId: string, bills: PluggyBill[]): void {
    // Appends: GET /bills returns every bill an account has, not just the newest.
    this.bills.set(accountId, [...(this.bills.get(accountId) ?? []), ...bills]);
  }

  /** Create a transaction as of the fake clock's current instant. */
  add(tx: Partial<PluggyTransaction> & { accountId: string; amount: number; date: string }): PluggyTransaction {
    const full: StoredTransaction = {
      id: tx.id ?? `tx-${++this.seq}`,
      description: 'COMPRA',
      currencyCode: 'BRL',
      type: tx.amount < 0 ? 'DEBIT' : 'CREDIT',
      status: 'POSTED',
      ...tx,
      _createdAt: this.now(),
    } as StoredTransaction;
    this.txs.set(full.id, full);
    return full;
  }

  /** Settle a pending transaction IN PLACE — same id, changed fields. */
  post(id: string, changes: Partial<PluggyTransaction> = {}): void {
    const tx = this.expect(id);
    Object.assign(tx, changes, { status: 'POSTED' as const, _createdAt: this.now() });
  }

  /**
   * The behaviour that makes reconciliation hard: Pluggy drops the row and
   * recreates it under a NEW id when details shift materially.
   */
  deleteAndRecreate(oldId: string, changes: Partial<PluggyTransaction> = {}): PluggyTransaction {
    const old = this.expect(oldId);
    this.txs.delete(oldId);
    const { _createdAt: _ignored, ...rest } = old;
    return this.add({ ...rest, ...changes, id: changes.id ?? `tx-${++this.seq}` } as StoredTransaction);
  }

  /** A genuine server-side deletion. */
  remove(id: string): void {
    this.expect(id);
    this.txs.delete(id);
  }

  setItemStatus(itemId: string, status: ItemStatus, executionStatus?: ExecutionStatus): void {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`No such item: ${itemId}`);
    item.status = status;
    if (executionStatus) item.executionStatus = executionStatus;
  }

  /** Every live transaction, for assertions. */
  allTransactions(): PluggyTransaction[] {
    return [...this.txs.values()].map(strip);
  }

  private expect(id: string): StoredTransaction {
    const tx = this.txs.get(id);
    if (!tx) throw new Error(`FakePluggy: no such transaction ${id}`);
    return tx;
  }

  // -- PluggyApi -----------------------------------------------------------

  async listItems(): Promise<PluggyItem[]> {
    this.calls.push({ method: 'listItems' });
    if (this.opts.forbidListItems) {
      throw new PluggyError('Forbidden', 403, '/items');
    }
    return [...this.items.values()];
  }

  async getItem(itemId: string): Promise<PluggyItem> {
    this.calls.push({ method: 'getItem', path: itemId });
    const item = this.items.get(itemId);
    if (!item) throw new PluggyError('Not found', 404, `/items/${itemId}`);
    return { ...item };
  }

  async patchItem(itemId: string): Promise<PluggyItem> {
    this.calls.push({ method: 'patchItem', path: itemId });
    const item = await this.getItem(itemId);
    item.status = 'UPDATING';
    this.items.set(itemId, item);
    return item;
  }

  async listAccounts(itemId: string): Promise<PluggyAccount[]> {
    this.calls.push({ method: 'listAccounts', path: itemId });
    return [...this.accounts.values()].filter((a) => a.itemId === itemId);
  }

  async listBills(accountId: string): Promise<PluggyBill[]> {
    this.calls.push({ method: 'listBills', path: accountId });
    if (this.opts.forbidBills) throw new PluggyError('Forbidden', 403, '/bills');
    return this.bills.get(accountId) ?? [];
  }

  async *listTransactions(query: TransactionQuery): AsyncIterable<PluggyTransaction[]> {
    if (query.createdAtFrom && query.dateFrom) {
      throw new PluggyError('createdAtFrom cannot be combined with dateFrom', 400, '/transactions');
    }
    this.calls.push({ method: 'listTransactions', query, path: buildTransactionsPath(query) });

    const matched = [...this.txs.values()]
      .filter((t) => t.accountId === query.accountId)
      .filter((t) => !query.ids?.length || query.ids.includes(t.id))
      // dateFrom/dateTo compare against the transaction's DATE...
      .filter((t) => !query.dateFrom || t.date.slice(0, 10) >= query.dateFrom)
      .filter((t) => !query.dateTo || t.date.slice(0, 10) <= query.dateTo)
      // ...while createdAtFrom compares against its server-side CREATION instant,
      // which is exactly why Window A can surface an old-dated recreated row.
      .filter((t) => !query.createdAtFrom || t._createdAt >= query.createdAtFrom)
      .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

    const pageSize = query.pageSize ?? this.opts.defaultPageSize ?? 500;
    if (matched.length === 0) {
      yield [];
      return;
    }
    for (let offset = 0; offset < matched.length; offset += pageSize) {
      yield matched.slice(offset, offset + pageSize).map(strip);
    }
  }
}

function strip(tx: StoredTransaction): PluggyTransaction {
  const { _createdAt: _ignored, ...rest } = tx;
  return { ...rest };
}
