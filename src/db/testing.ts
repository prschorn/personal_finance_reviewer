import { eq } from 'drizzle-orm';
import { createTestDb, type DB } from './client';
import { runMigrations } from './migrate';
import { seedCategories } from './seed-categories';
import { seedRules } from '../categorize/seed-rules';
import { accounts, categories, items, transactions } from './schema';
import { buildSearchText } from '../lib/text';

/**
 * Fixtures for database-backed tests.
 *
 * NOT named `*.test.ts`: the vitest `include` glob is `src/**\/*.test.ts` and would
 * collect this file as a suite with no tests in it.
 *
 * Every test here builds a real in-memory database and runs the real migrations —
 * there is no mocking anywhere in this codebase, which is what the `db: DB = getDb()`
 * first-parameter convention exists to make possible.
 */

export interface TestAccount {
  id: string;
  type: 'BANK' | 'CREDIT';
  name?: string;
  cardBrand?: string;
  balanceCents?: number;
  creditLimitCents?: number;
  availableCreditLimitCents?: number;
  balanceDueDate?: string;
}

export interface FreshDbOptions {
  /** Defaults to one bank account and one card. */
  accounts?: TestAccount[];
  /** Seed the shipped rules. Off by default, so a test's own rules are the only ones. */
  withRules?: boolean;
}

const DEFAULT_ACCOUNTS: TestAccount[] = [
  { id: 'acc-bank', type: 'BANK', name: 'Conta' },
  { id: 'acc-card', type: 'CREDIT', name: 'Cartão' },
];

export function freshDb(opts: FreshDbOptions = {}): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  if (opts.withRules) seedRules(db);

  db.insert(items).values({ id: 'item-1' }).run();
  for (const account of opts.accounts ?? DEFAULT_ACCOUNTS) {
    db.insert(accounts).values({ ...account, itemId: 'item-1' }).run();
  }

  return db;
}

export function catId(db: DB, name: string): number {
  return db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

export interface TxSpec {
  postedOn?: string;
  signedCents?: number;
  accountId?: string;
  description?: string;
  merchantName?: string | null;
  /** Category by NAME, resolved against the seeded list. */
  category?: string;
  categorySource?: string;
  status?: string;
  isInternal?: boolean;
  deleted?: boolean;
  firstSeenAt?: string;
  /** Pin it to build a duplicate; otherwise every row gets its own. */
  fingerprint?: string;
  /** Pluggy's own label, which resolve() consults as a hint below your rules. */
  pluggyCategory?: string;
  billId?: string;
  installments?: [number, number];
  purchaseDate?: string;
}

let sequence = 0;

/** Reset the id counter, for a test that asserts on generated ids. */
export function resetTxSequence(): void {
  sequence = 0;
}

export function addTx(db: DB, spec: TxSpec = {}): string {
  const id = `tx-${++sequence}`;
  const postedOn = spec.postedOn ?? '2026-03-01';
  const signedCents = spec.signedCents ?? -1000;
  const description = spec.description ?? 'COMPRA';

  db.insert(transactions)
    .values({
      id,
      accountId: spec.accountId ?? 'acc-bank',
      fingerprint: spec.fingerprint ?? `fp-${id}`,
      dateUtc: `${postedOn}T00:00:00.000Z`,
      postedOn,
      description,
      merchantName: spec.merchantName ?? null,
      // Built the way the sync builds it, or rule matching in tests is a fiction.
      searchText: buildSearchText({ description, merchantName: spec.merchantName ?? undefined }),
      amountCents: Math.abs(signedCents),
      signedCents,
      status: spec.status ?? 'POSTED',
      firstSeenAt: spec.firstSeenAt ?? 'now',
      lastSeenRunId: 1,
      rawJson: '{}',
      categoryId: spec.category ? catId(db, spec.category) : null,
      categorySource: spec.categorySource ?? 'rule',
      pluggyCategory: spec.pluggyCategory ?? null,
      isInternal: spec.isInternal ?? false,
      deletedAt: spec.deleted ? 'now' : null,
      ccBillId: spec.billId ?? null,
      ccInstallmentNumber: spec.installments?.[0] ?? null,
      ccTotalInstallments: spec.installments?.[1] ?? null,
      ccPurchaseDate: spec.purchaseDate ?? null,
    })
    .run();

  return id;
}
