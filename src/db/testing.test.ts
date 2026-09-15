import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, rules, transactions } from './schema';
import { freshDb, catId, addTx } from './testing';

describe('freshDb', () => {
  it('gives a migrated database with categories and one of each account', () => {
    const db = freshDb();
    expect(db.select().from(accounts).all().map((a) => a.id).sort()).toEqual(['acc-bank', 'acc-card']);
    expect(catId(db, 'Mercado')).toBeGreaterThan(0);
  });

  // Most tests want an empty rule table so their own rules are the only ones.
  it('ships no rules unless asked', () => {
    expect(freshDb().select().from(rules).all()).toEqual([]);
    expect(freshDb({ withRules: true }).select().from(rules).all().length).toBeGreaterThan(0);
  });

  it('takes its own accounts when the defaults do not fit', () => {
    const db = freshDb({ accounts: [{ id: 'nubank', type: 'CREDIT', creditLimitCents: 1000000 }] });
    const [account] = db.select().from(accounts).all();
    expect(account!.id).toBe('nubank');
    expect(account!.creditLimitCents).toBe(1000000);
  });

  it('is isolated between calls', () => {
    const a = freshDb();
    addTx(a, { signedCents: -500 });
    expect(freshDb().select().from(transactions).all()).toEqual([]);
  });
});

describe('addTx', () => {
  it('fills in everything a test did not care about', () => {
    const db = freshDb();
    const id = addTx(db, { signedCents: -1234 });

    const row = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(row.signedCents).toBe(-1234);
    expect(row.amountCents).toBe(1234);
    expect(row.accountId).toBe('acc-bank');
    expect(row.deletedAt).toBeNull();
    expect(row.isInternal).toBe(false);
  });

  it('gives every row a distinct id and fingerprint', () => {
    const db = freshDb();
    const ids = [addTx(db, {}), addTx(db, {}), addTx(db, {})];
    expect(new Set(ids).size).toBe(3);
    expect(new Set(db.select().from(transactions).all().map((t) => t.fingerprint)).size).toBe(3);
  });

  it('keeps a fingerprint the caller pinned, so duplicates can be built', () => {
    const db = freshDb();
    addTx(db, { fingerprint: 'fp-same' });
    addTx(db, { fingerprint: 'fp-same' });
    expect(db.select().from(transactions).all().every((t) => t.fingerprint === 'fp-same')).toBe(true);
  });

  // Rule matching runs off search_text, so it has to be built the way sync builds it.
  it('normalizes search text the way the sync does', () => {
    const db = freshDb();
    const id = addTx(db, { description: 'Padaria Açaí' });
    expect(db.select().from(transactions).where(eq(transactions.id, id)).get()!.searchText).toBe('PADARIA ACAI');
  });

  it('resolves a category by name', () => {
    const db = freshDb();
    const id = addTx(db, { category: 'Mercado' });
    expect(db.select().from(transactions).where(eq(transactions.id, id)).get()!.categoryId).toBe(catId(db, 'Mercado'));
  });

  it('writes the installment marker as a pair', () => {
    const db = freshDb();
    const id = addTx(db, { installments: [3, 10] });
    const row = db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect([row.ccInstallmentNumber, row.ccTotalInstallments]).toEqual([3, 10]);
  });

  it('soft-deletes on request', () => {
    const db = freshDb();
    const id = addTx(db, { deleted: true });
    expect(db.select().from(transactions).where(eq(transactions.id, id)).get()!.deletedAt).not.toBeNull();
  });

  it('derives the month from the posting date', () => {
    const db = freshDb();
    const id = addTx(db, { postedOn: '2026-07-14' });
    expect(db.select().from(transactions).where(eq(transactions.id, id)).get()!.month).toBe('2026-07');
  });
});
