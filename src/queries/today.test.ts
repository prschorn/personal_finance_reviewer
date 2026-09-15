import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { accounts, bills, transactions } from '../db/schema';
import { freshDb as makeDb, addTx as insertTx } from '../db/testing';
import {
  deriveCycleShape,
  projectCycles,
  getBalances,
  getCardHeadroom,
  getCommitted,
  getCommittedTransactions,
  getToday,
  type UnbilledRow,
  type CycleShape,
} from './today';

const TODAY = '2026-09-15';

/** The live shape: bills due on the 3rd, closing 7 days earlier. */
const ITAU: CycleShape = { dueDay: 3, closingOffsetDays: 7 };
const shapes = new Map([['card', ITAU]]);

function row(over: Partial<UnbilledRow> = {}): UnbilledRow {
  return { accountId: 'card', postedOn: TODAY, cents: 1000, description: null, ...over };
}

describe('deriveCycleShape', () => {
  it('takes the due day from the newest bill and the closing offset from the median gap', () => {
    const shape = deriveCycleShape([
      { dueDate: '2026-07-03', closingDate: '2026-06-26T00:00:00.000Z' },
      { dueDate: '2026-08-03', closingDate: '2026-07-27T00:00:00.000Z' },
      { dueDate: '2026-09-03', closingDate: '2026-08-27T00:00:00.000Z' },
    ]);
    expect(shape).toEqual({ dueDay: 3, closingOffsetDays: 7 });
  });

  it('works from a single bill', () => {
    expect(deriveCycleShape([{ dueDate: '2026-09-10', closingDate: '2026-09-01T00:00:00.000Z' }])).toEqual({
      dueDay: 10,
      closingOffsetDays: 9,
    });
  });

  // Pluggy sends billClosingDate inside raw_json and is not obliged to keep doing so.
  it('falls back to a default offset when no closing date is available', () => {
    const shape = deriveCycleShape([{ dueDate: '2026-09-03', closingDate: null }]);
    expect(shape).toEqual({ dueDay: 3, closingOffsetDays: 7 });
  });

  // accounts.balance_due_date points at the LAST CLOSED bill, so it is in the past —
  // useful only for the day of the month it lands on.
  it('falls back to the account due date when there are no bills at all', () => {
    expect(deriveCycleShape([], '2026-09-03')).toEqual({ dueDay: 3, closingOffsetDays: 7 });
  });

  it('returns null when nothing establishes a due day', () => {
    expect(deriveCycleShape([])).toBeNull();
    expect(deriveCycleShape([{ dueDate: null, closingDate: null }])).toBeNull();
  });
});

describe('projectCycles', () => {
  it('returns nothing for no charges', () => {
    expect(projectCycles([], shapes, TODAY)).toEqual([]);
  });

  // Installments 2..N are dated on the due date of the bill that will carry them.
  // That convention makes the assignment exact rather than inferred.
  it('puts a future installment on the due date it is already dated for', () => {
    const [bill] = projectCycles([row({ postedOn: '2026-10-03', cents: 33062 })], shapes, TODAY);
    expect(bill!.dueDate).toBe('2026-10-03');
    expect(bill!.chargedCents).toBe(33062);
    expect(bill!.count).toBe(1);
  });

  it('puts a charge made today on the next cycle that has not closed', () => {
    const [bill] = projectCycles([row({ postedOn: TODAY })], shapes, TODAY);
    expect(bill!.dueDate).toBe('2026-10-03');
    expect(bill!.closesOn).toBe('2026-09-26');
  });

  it('rolls a charge made after the close into the following cycle', () => {
    const [bill] = projectCycles([row({ postedOn: '2026-09-30' })], shapes, TODAY);
    expect(bill!.dueDate).toBe('2026-11-03');
    expect(bill!.closesOn).toBe('2026-10-27');
  });

  it('sums charges that share a cycle', () => {
    const bills = projectCycles(
      [row({ postedOn: TODAY, cents: 1000 }), row({ postedOn: '2026-09-20', cents: 2500 })],
      shapes,
      TODAY,
    );
    expect(bills).toHaveLength(1);
    expect(bills[0]!.chargedCents).toBe(3500);
    expect(bills[0]!.count).toBe(2);
  });

  it('orders cycles by due date', () => {
    const bills = projectCycles(
      [row({ postedOn: '2027-01-03' }), row({ postedOn: '2026-10-03' }), row({ postedOn: '2026-11-03' })],
      shapes,
      TODAY,
    );
    expect(bills.map((b) => b.dueDate)).toEqual(['2026-10-03', '2026-11-03', '2027-01-03']);
  });

  // Only the cycle still accumulating will grow; the rest are scheduled installments
  // and the figure shown for them is final.
  it('marks only the cycle that has not closed as open', () => {
    const bills = projectCycles([row({ postedOn: TODAY }), row({ postedOn: '2026-11-03' })], shapes, TODAY);
    expect(bills.map((b) => [b.dueDate, b.open])).toEqual([
      ['2026-10-03', true],
      ['2026-11-03', false],
    ]);
  });

  it('counts the days until each bill lands', () => {
    const [bill] = projectCycles([row({ postedOn: '2026-10-03' })], shapes, TODAY);
    expect(bill!.daysAway).toBe(18);
  });

  it('keeps cards apart', () => {
    const two = new Map([
      ['card', ITAU],
      ['other', { dueDay: 20, closingOffsetDays: 5 }],
    ]);
    const bills = projectCycles([row({ postedOn: TODAY }), row({ accountId: 'other', postedOn: TODAY })], two, TODAY);
    expect(bills).toHaveLength(2);
    expect(bills.map((b) => [b.accountId, b.dueDate]).sort()).toEqual([
      ['card', '2026-10-03'],
      ['other', '2026-09-20'],
    ]);
  });

  // Inventing a due date would make an estimate look like a fact.
  it('reports charges with no derivable cycle in a bucket with no date', () => {
    const [bill] = projectCycles([row({ cents: 4200 })], new Map(), TODAY);
    expect(bill!.dueDate).toBeNull();
    expect(bill!.closesOn).toBeNull();
    expect(bill!.chargedCents).toBe(4200);
    expect(bill!.open).toBe(true);
  });

  it('clamps a due day past the end of a short month', () => {
    const endOfMonth = new Map([['card', { dueDay: 31, closingOffsetDays: 7 }]]);
    const [bill] = projectCycles([row({ postedOn: '2026-11-01' })], endOfMonth, TODAY);
    expect(bill!.dueDate).toBe('2026-11-30');
  });
});

// --- DB-backed ---------------------------------------------------------------

const NOW = new Date('2026-09-15T12:00:00.000Z');

/** The live card: a limit the bank reports used, and a due date already past. */
function freshDb(): DB {
  return makeDb({
    accounts: [
      { id: 'conta', type: 'BANK', name: 'Conta', balanceCents: 19405 },
      {
        id: 'card',
        type: 'CREDIT',
        name: 'Black',
        cardBrand: 'Mastercard',
        balanceCents: 1820595,
        creditLimitCents: 2500000,
        availableCreditLimitCents: 679405,
        balanceDueDate: '2026-09-03',
      },
    ],
  });
}

function addTx(
  db: DB,
  o: { accountId: string; postedOn: string; signedCents: number; billId?: string; isInternal?: boolean; deleted?: boolean },
) {
  return insertTx(db, o);
}

describe('getBalances', () => {
  it('reports bank accounts only', () => {
    const db = freshDb();
    const balances = getBalances(db);
    expect(balances.map((b) => b.accountId)).toEqual(['conta']);
    expect(balances[0]!.cents).toBe(19405);
  });
});

describe('getCardHeadroom', () => {
  // accounts.balance_cents on a credit card is POSITIVE = owed, the opposite of
  // transactions.signed_cents. Getting this backwards would show the limit as free.
  it('passes the bank figures through without renegotiating the sign', () => {
    const db = freshDb();
    const [card] = getCardHeadroom(db);
    expect(card!.usedCents).toBe(1820595);
    expect(card!.limitCents).toBe(2500000);
    expect(card!.availableCents).toBe(679405);
    expect(card!.freeShare).toBeCloseTo(0.2718, 4);
  });

  it('leaves the free share null when no limit is known', () => {
    const db = freshDb();
    db.insert(accounts).values({ id: 'other', itemId: 'item-1', type: 'CREDIT', name: 'Sem limite' }).run();
    const other = getCardHeadroom(db).find((c) => c.accountId === 'other');
    expect(other!.freeShare).toBeNull();
  });
});

describe('getCommitted', () => {
  it('groups future card charges by month', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -33062 });
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -10000 });
    addTx(db, { accountId: 'card', postedOn: '2026-11-03', signedCents: -33062 });

    expect(getCommitted(db, NOW)).toEqual([
      { month: '2026-10', cents: 43062, count: 2 },
      { month: '2026-11', cents: 33062, count: 1 },
    ]);
  });

  it('excludes anything already billed, already posted, internal, deleted, or from a bank', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -100, billId: 'bill-1' });
    addTx(db, { accountId: 'card', postedOn: '2026-09-01', signedCents: -200 });
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -300, isInternal: true });
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -400, deleted: true });
    addTx(db, { accountId: 'conta', postedOn: '2026-10-03', signedCents: -500 });

    expect(getCommitted(db, NOW)).toEqual([]);
  });
});

describe('getToday', () => {
  // `committed` and `upcoming` are two readings of the same rows, not two pots of
  // money: an installment dated 2026-10-03 really is billed on the 2026-10-03 bill,
  // alongside whatever else this cycle collects. unbilledTotalCents is the only
  // figure that may be presented as a total; adding the other two would double count.
  it('bills a near-future installment with the cycle it falls in, and totals each row once', () => {
    const db = freshDb();
    db.insert(bills)
      .values({ id: 'b1', accountId: 'card', dueDate: '2026-09-03', totalAmountCents: 948780, rawJson: '{"billClosingDate":"2026-08-27T00:00:00.000Z"}' })
      .run();
    addTx(db, { accountId: 'card', postedOn: '2026-09-10', signedCents: -5000 }); // open cycle
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -33062 }); // scheduled

    const view = getToday(db, NOW);

    expect(view.committedTotalCents).toBe(33062);
    expect(view.unbilledTotalCents).toBe(38062);
    const open = view.upcoming.find((b) => b.open);
    expect(open!.dueDate).toBe('2026-10-03');
    expect(open!.chargedCents).toBe(38062);
    expect(open!.count).toBe(2);
    // Every unbilled row lands in exactly one cycle, so the cycles sum to the total.
    expect(view.upcoming.reduce((s, b) => s + b.chargedCents, 0)).toBe(view.unbilledTotalCents);
  });

  it('reports the bank own used-limit figure alongside our itemized sum', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2026-09-10', signedCents: -5000 });

    const view = getToday(db, NOW);

    expect(view.unbilledTotalCents).toBe(5000);
    expect(view.reportedUsedCents).toBe(1820595);
  });

  it('names the furthest month it has commitments for', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2027-01-03', signedCents: -52917 });
    expect(getToday(db, NOW).horizonMonth).toBe('2027-01');
  });

  it('has no horizon when nothing is scheduled', () => {
    expect(getToday(freshDb(), NOW).horizonMonth).toBeNull();
  });
});

describe('getCommittedTransactions', () => {
  it('returns the rows behind one committed month, and nothing else', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -33062 });
    addTx(db, { accountId: 'card', postedOn: '2026-11-03', signedCents: -33062 });
    addTx(db, { accountId: 'card', postedOn: '2026-09-01', signedCents: -900 });

    const rows = getCommittedTransactions(db, { month: '2026-10' }, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cents).toBe(33062);
    expect(rows[0]!.postedOn).toBe('2026-10-03');
  });

  // The rows must add up to the figure that was clicked, or the page is lying.
  it('adds up to the month total it drills into', () => {
    const db = freshDb();
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -33062 });
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -12000 });
    addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -400, billId: 'b1' });

    const month = getCommitted(db, NOW).find((c) => c.month === '2026-10')!;
    const rows = getCommittedTransactions(db, { month: '2026-10' }, NOW);

    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(month.cents);
  });

  it('shows the installment marker', () => {
    const db = freshDb();
    const id = addTx(db, { accountId: 'card', postedOn: '2026-10-03', signedCents: -33062 });
    db.update(transactions).set({ ccInstallmentNumber: 7, ccTotalInstallments: 10 }).where(eq(transactions.id, id)).run();

    expect(getCommittedTransactions(db, { month: '2026-10' }, NOW)[0]!.installment).toBe('7/10');
  });
});
