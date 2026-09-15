import { describe, it, expect } from 'vitest';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { accounts, bills, items, transactions } from '../db/schema';
import { detectInternal, BILL_AMOUNT_TOLERANCE_CENTS } from './internal';
import { buildSearchText } from '../lib/text';
import type { OwnIdentifiers } from '../config/own';

const NO_OWN: OwnIdentifiers = { documents: [], pixKeys: [], nameFragments: [] };

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  db.insert(items).values({ id: 'item-1' }).run();
  db.insert(accounts).values({ id: 'acc-bank', itemId: 'item-1', type: 'BANK' }).run();
  db.insert(accounts).values({ id: 'acc-bank2', itemId: 'item-1', type: 'BANK' }).run();
  db.insert(accounts).values({ id: 'acc-card', itemId: 'item-1', type: 'CREDIT' }).run();
  return db;
}

let n = 0;
function addTx(db: DB, o: {
  accountId?: string; signedCents: number; postedOn?: string; description?: string;
  paymentMethod?: string; payerDocument?: string; receiverDocument?: string;
  payerName?: string; receiverName?: string; pluggyCategory?: string;
}) {
  const id = `tx-${++n}`;
  const description = o.description ?? 'MOVIMENTO';
  db.insert(transactions)
    .values({
      id, accountId: o.accountId ?? 'acc-bank', fingerprint: `fp-${id}`,
      dateUtc: `${o.postedOn ?? '2026-03-10'}T00:00:00.000Z`,
      postedOn: o.postedOn ?? '2026-03-10',
      description, searchText: buildSearchText({ description }),
      amountCents: Math.abs(o.signedCents), signedCents: o.signedCents,
      status: 'POSTED', firstSeenAt: 'now', lastSeenRunId: 1, rawJson: '{}',
      paymentMethod: o.paymentMethod ?? null,
      payerDocument: o.payerDocument ?? null, receiverDocument: o.receiverDocument ?? null,
      payerName: o.payerName ?? null, receiverName: o.receiverName ?? null,
      pluggyCategory: o.pluggyCategory ?? null,
    })
    .run();
  return id;
}

function addBill(db: DB, totalAmountCents: number, dueDate: string, id = 'bill-1') {
  db.insert(bills).values({ id, accountId: 'acc-card', totalAmountCents, dueDate }).run();
}

describe('card bill payment detection', () => {
  it('matches a bank debit against a bill of the same amount near its due date', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const payment = addTx(db, { signedCents: -120000, postedOn: '2026-03-20', description: 'PAGTO' });

    const { findings, stats } = detectInternal(db, NO_OWN);

    expect(findings.get(payment)).toMatchObject({ isInternal: true, reason: 'card_payment', pairId: 'bill:bill-1' });
    expect(stats.cardPayments).toBe(1);
  });

  it('tolerates a small difference from the bill total', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const within = addTx(db, { signedCents: -(120000 + BILL_AMOUNT_TOLERANCE_CENTS), postedOn: '2026-03-20' });
    expect(detectInternal(db, NO_OWN).findings.has(within)).toBe(true);
  });

  it('rejects an amount outside tolerance', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const outside = addTx(db, { signedCents: -(120000 + BILL_AMOUNT_TOLERANCE_CENTS + 1), postedOn: '2026-03-20' });
    expect(detectInternal(db, NO_OWN).findings.has(outside)).toBe(false);
  });

  it('rejects a coincidental match far from the due date', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const far = addTx(db, { signedCents: -120000, postedOn: '2026-02-01' });
    expect(detectInternal(db, NO_OWN).findings.has(far)).toBe(false);
  });

  it('ignores money coming IN of the same amount', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const inbound = addTx(db, { signedCents: 120000, postedOn: '2026-03-20' });
    expect(detectInternal(db, NO_OWN).findings.has(inbound)).toBe(false);
  });

  it('finds nothing at all when bills are unavailable', () => {
    const db = freshDb();
    const payment = addTx(db, { signedCents: -120000, postedOn: '2026-03-20', description: 'PAGTO FATURA' });
    // No bills stored (free tier). The description rule handles this case instead.
    expect(detectInternal(db, NO_OWN).findings.has(payment)).toBe(false);
  });
});

describe('own transfer pairing', () => {
  it('pairs two legs of a PIX between the user own accounts', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });
    const into = addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });

    const { findings, stats } = detectInternal(db, NO_OWN);

    expect(findings.get(out)?.reason).toBe('own_transfer');
    expect(findings.get(into)?.reason).toBe('own_transfer');
    expect(findings.get(out)?.pairId).toBe(findings.get(into)?.pairId);
    expect(stats.ownTransfers).toBe(2);
  });

  it('pairs on a matching own document even without a transfer method', () => {
    const db = freshDb();
    const own: OwnIdentifiers = { documents: ['12345678901'], pixKeys: [], nameFragments: [] };
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, description: 'ENVIO', receiverDocument: '12345678901' });
    const into = addTx(db, { accountId: 'acc-bank2', signedCents: 50000, description: 'ENTRADA' });
    expect(detectInternal(db, own).findings.has(out)).toBe(true);
    expect(detectInternal(db, own).findings.has(into)).toBe(true);
  });

  it('pairs on the user own name appearing as the counterparty', () => {
    const db = freshDb();
    const own: OwnIdentifiers = { documents: [], pixKeys: [], nameFragments: ['PAULO'] };
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, description: 'ENVIO', receiverName: 'Paulo Schorn' });
    addTx(db, { accountId: 'acc-bank2', signedCents: 50000, description: 'ENTRADA' });
    expect(detectInternal(db, own).findings.has(out)).toBe(true);
  });

  it('spans a couple of days', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, postedOn: '2026-03-10', paymentMethod: 'TED' });
    const into = addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-12', paymentMethod: 'TED' });
    expect(detectInternal(db, NO_OWN).findings.has(out)).toBe(true);
    expect(detectInternal(db, NO_OWN).findings.has(into)).toBe(true);
  });

  it('does not pair legs too far apart in time', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, postedOn: '2026-03-01', paymentMethod: 'PIX' });
    addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-20', paymentMethod: 'PIX' });
    expect(detectInternal(db, NO_OWN).findings.has(out)).toBe(false);
  });

  it('does not pair within the same account', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, paymentMethod: 'PIX' });
    addTx(db, { accountId: 'acc-bank', signedCents: 50000, paymentMethod: 'PIX' });
    expect(detectInternal(db, NO_OWN).findings.has(out)).toBe(false);
  });

  // The crucial false-positive guard: real spending must not vanish because an
  // unrelated deposit happened to be the same amount.
  it('does not pair two unrelated same-amount movements without corroboration', () => {
    const db = freshDb();
    const spend = addTx(db, { accountId: 'acc-bank', signedCents: -5000, description: 'PADARIA DO ZE' });
    const refund = addTx(db, { accountId: 'acc-bank2', signedCents: 5000, description: 'CASHBACK LOJA' });
    const { findings } = detectInternal(db, NO_OWN);
    expect(findings.has(spend)).toBe(false);
    expect(findings.has(refund)).toBe(false);
  });

  it('does not pair amounts that merely look close', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -5000, paymentMethod: 'PIX' });
    addTx(db, { accountId: 'acc-bank2', signedCents: 5001, paymentMethod: 'PIX' });
    expect(detectInternal(db, NO_OWN).findings.has(out)).toBe(false);
  });

  it('never double-pairs one leg against two counterparts', () => {
    const db = freshDb();
    const out = addTx(db, { accountId: 'acc-bank', signedCents: -50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });
    const in1 = addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });
    const in2 = addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-11', paymentMethod: 'PIX' });

    const { findings, stats } = detectInternal(db, NO_OWN);

    expect(stats.ownTransfers).toBe(2);
    expect(findings.has(out)).toBe(true);
    expect([in1, in2].filter((id) => findings.has(id))).toHaveLength(1);
  });

  it('is deterministic across runs', () => {
    const db = freshDb();
    addTx(db, { accountId: 'acc-bank', signedCents: -50000, paymentMethod: 'PIX' });
    addTx(db, { accountId: 'acc-bank2', signedCents: 50000, paymentMethod: 'PIX' });
    const a = [...detectInternal(db, NO_OWN).findings.entries()].sort();
    const b = [...detectInternal(db, NO_OWN).findings.entries()].sort();
    expect(a).toEqual(b);
  });
});

describe('precedence between detectors', () => {
  it('does not re-pair a transaction already claimed as a card payment', () => {
    const db = freshDb();
    addBill(db, 50000, '2026-03-10');
    const payment = addTx(db, { accountId: 'acc-bank', signedCents: -50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });
    addTx(db, { accountId: 'acc-bank2', signedCents: 50000, postedOn: '2026-03-10', paymentMethod: 'PIX' });

    const { findings } = detectInternal(db, NO_OWN);
    expect(findings.get(payment)?.reason).toBe('card_payment');
  });
});

describe('soft-deleted rows', () => {
  it('are ignored', () => {
    const db = freshDb();
    addBill(db, 120000, '2026-03-20');
    const payment = addTx(db, { signedCents: -120000, postedOn: '2026-03-20' });
    db.update(transactions).set({ deletedAt: 'now' }).run();
    expect(detectInternal(db, NO_OWN).findings.has(payment)).toBe(false);
  });
});

describe('Pluggy category as a signal', () => {
  // Far more reliable than matching description text, which varies per bank.
  it('trusts "Credit card payment"', () => {
    const db = freshDb();
    const id = addTx(db, { signedCents: -120000, description: 'DEBITO AUTOMATICO PERS BLACK', pluggyCategory: 'Credit card payment' });
    const { findings, stats } = detectInternal(db, NO_OWN);
    expect(findings.get(id)).toMatchObject({ isInternal: true, reason: 'card_payment' });
    expect(stats.fromPluggyCategory).toBe(1);
  });

  it('trusts "Same person transfer"', () => {
    const db = freshDb();
    const id = addTx(db, { signedCents: -50000, description: 'PIX ENVIADO', pluggyCategory: 'Same person transfer' });
    expect(detectInternal(db, NO_OWN).findings.get(id)?.reason).toBe('own_transfer');
  });

  // A description-only match would be wrong here; the category disambiguates.
  it('leaves ordinary spending alone', () => {
    const db = freshDb();
    const id = addTx(db, { signedCents: -8000, description: 'RESTAURANTE', pluggyCategory: 'Eating out' });
    expect(detectInternal(db, NO_OWN).findings.has(id)).toBe(false);
  });

  it('does not require a counterpart leg, unlike transfer pairing', () => {
    const db = freshDb();
    const id = addTx(db, { signedCents: -50000, pluggyCategory: 'Same person transfer' });
    expect(detectInternal(db, NO_OWN).findings.has(id)).toBe(true);
  });
});
