import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, bills, transactions } from '../db/schema';
import { addMonths, addDays, dateInMonth, dayOfMonth, daysBetween, toMonth, today as todayIn, type Ym, type Ymd } from '../lib/date';
import { median } from '../lib/stats';
import type { DrillDownRow } from './matrix';

/**
 * What is true right now, and what is already committed.
 *
 * Everything else in this app looks backwards. This looks at the balances as the
 * bank last reported them, at what has been charged to a card but not yet billed,
 * and at the installments already dated into months that have not happened.
 *
 * Amounts are POSITIVE magnitudes of spending, as in queries/matrix.ts — except
 * `CardHeadroom`, which passes the bank's own figures through unchanged and is
 * documented where it differs.
 *
 * NOTHING HERE IS EVER WRITTEN TO THE `bills` TABLE. detectCardBillPayments
 * (sync/internal.ts) marks any bank outflow internal when it lands within ±50
 * centavos and ±5 days of a stored bill's due date, so a projected bill row would
 * silently erase a real payment from every total in the app. The projection lives
 * in projectCycles and nowhere else.
 */

/** Bank accounts only. Positive = money you have. */
export interface AccountBalance {
  accountId: string;
  name: string | null;
  cents: number;
}

export interface CardHeadroom {
  accountId: string;
  name: string | null;
  brand: string | null;
  /**
   * As the bank reports it: POSITIVE = owed. This is the opposite convention to
   * transactions.signed_cents, and the two must never be mixed without negating.
   */
  usedCents: number | null;
  limitCents: number | null;
  availableCents: number | null;
  /** available / limit, 0..1. Null when the limit is unknown. */
  freeShare: number | null;
}

/**
 * Derived, not stored. Pluggy returns only CLOSED bills, so there is no `bills`
 * row for any of these — `dueDate` is null when nothing establishes one.
 */
export interface UpcomingBill {
  accountId: string;
  accountName: string | null;
  dueDate: Ymd | null;
  closesOn: Ymd | null;
  daysAway: number | null;
  chargedCents: number;
  count: number;
  /** The cycle still accumulating: its figure will grow. The rest are final. */
  open: boolean;
}

export interface CommittedMonth {
  month: Ym;
  cents: number;
  count: number;
}

export interface Today {
  asOf: Ymd;
  balances: AccountBalance[];
  balanceTotalCents: number;
  cards: CardHeadroom[];
  upcoming: UpcomingBill[];
  committed: CommittedMonth[];
  committedTotalCents: number;
  /** Every unbilled charge, ours. Compare against reportedUsedCents, the bank's. */
  unbilledTotalCents: number;
  reportedUsedCents: number | null;
  /** The furthest month anything is scheduled into. Null when nothing is. */
  horizonMonth: Ym | null;
}

export interface UnbilledRow {
  accountId: string;
  postedOn: Ymd;
  cents: number;
  description: string | null;
}

export interface CycleShape {
  dueDay: number;
  closingOffsetDays: number;
}

/** When Pluggy stops sending billClosingDate, this is what the offset falls back to. */
export const DEFAULT_CLOSING_OFFSET_DAYS = 7;

/**
 * The shape of a card's billing cycle, read off its own history.
 *
 * `accounts.balance_due_date` points at the LAST CLOSED bill and is therefore in
 * the past — it is useful only for the day of the month it lands on, which is why
 * it is a fallback for `dueDay` and never a date in its own right.
 */
export function deriveCycleShape(
  bills: readonly { dueDate: string | null; closingDate: string | null }[],
  fallbackDueDate?: string | null,
): CycleShape | null {
  const dated = bills.filter((b): b is { dueDate: string; closingDate: string | null } => !!b.dueDate);
  const newest = dated.map((b) => b.dueDate).sort().at(-1) ?? fallbackDueDate ?? null;
  if (!newest) return null;

  const offsets = dated
    .filter((b) => b.closingDate)
    .map((b) => Math.round(daysBetween(b.dueDate, b.closingDate!)))
    .filter((d) => d > 0);

  return {
    dueDay: dayOfMonth(newest.slice(0, 10)),
    closingOffsetDays: median(offsets) ?? DEFAULT_CLOSING_OFFSET_DAYS,
  };
}

/** The due dates of this card's cycles, from the current month forward. */
function cyclesFrom(shape: CycleShape, fromMonth: Ym, count: number): { dueDate: Ymd; closesOn: Ymd }[] {
  return Array.from({ length: count }, (_, i) => {
    const dueDate = dateInMonth(addMonths(fromMonth, i), shape.dueDay);
    return { dueDate, closesOn: addDays(dueDate, -shape.closingOffsetDays) };
  });
}

/**
 * Assign every unbilled charge to the bill cycle that will carry it.
 *
 * Two rules, because card installments follow a convention worth exploiting:
 * an installment after the first is DATED ON the due date of the bill that will
 * carry it, so its cycle is not inferred at all. Everything else belongs to the
 * first cycle that had not yet closed when it was charged.
 */
export function projectCycles(
  rows: readonly UnbilledRow[],
  shapes: ReadonlyMap<string, CycleShape>,
  today: Ymd,
): UpcomingBill[] {
  const buckets = new Map<string, UpcomingBill>();

  for (const row of rows) {
    const shape = shapes.get(row.accountId);
    let dueDate: Ymd | null = null;
    let closesOn: Ymd | null = null;

    if (shape) {
      // Enough cycles to reach the furthest charge, plus slack.
      const cycles = cyclesFrom(shape, toMonth(today), 26);
      const dated =
        row.postedOn > today && dayOfMonth(row.postedOn) === shape.dueDay
          ? cycles.find((c) => c.dueDate === row.postedOn)
          : cycles.find((c) => c.closesOn >= row.postedOn && c.dueDate > today);
      dueDate = dated?.dueDate ?? null;
      closesOn = dated?.closesOn ?? null;
    }

    const key = `${row.accountId}|${dueDate ?? ''}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.chargedCents += row.cents;
      bucket.count += 1;
      continue;
    }
    buckets.set(key, {
      accountId: row.accountId,
      accountName: null,
      dueDate,
      closesOn,
      daysAway: dueDate ? Math.round(daysBetween(dueDate, today)) : null,
      chargedCents: row.cents,
      count: 1,
      open: false,
    });
  }

  const ordered = [...buckets.values()].sort((a, b) =>
    (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
  );

  // Exactly one cycle per card is accumulating: the earliest that has not closed.
  // Later ones hold scheduled installments, and their figures are already final.
  const claimed = new Set<string>();
  for (const bill of ordered) {
    if (claimed.has(bill.accountId)) continue;
    if (bill.closesOn && bill.closesOn < today) continue;
    bill.open = true;
    claimed.add(bill.accountId);
  }

  return ordered;
}

// --- Database ----------------------------------------------------------------

export function getBalances(db: DB = getDb()): AccountBalance[] {
  return db
    .select({ accountId: accounts.id, name: accounts.name, cents: accounts.balanceCents })
    .from(accounts)
    .where(eq(accounts.type, 'BANK'))
    .orderBy(accounts.name)
    .all()
    .map((r) => ({ ...r, cents: r.cents ?? 0 }));
}

export function getCardHeadroom(db: DB = getDb()): CardHeadroom[] {
  return db
    .select({
      accountId: accounts.id,
      name: accounts.name,
      brand: accounts.cardBrand,
      usedCents: accounts.balanceCents,
      limitCents: accounts.creditLimitCents,
      availableCents: accounts.availableCreditLimitCents,
    })
    .from(accounts)
    .where(eq(accounts.type, 'CREDIT'))
    .orderBy(accounts.name)
    .all()
    .map((r) => ({
      ...r,
      freeShare: r.limitCents && r.availableCents !== null ? r.availableCents / r.limitCents : null,
    }));
}

/** Predicate shared by every unbilled figure, so they can never disagree. */
const unbilledCardScope = and(
  isNull(transactions.deletedAt),
  eq(transactions.isInternal, false),
  eq(accounts.type, 'CREDIT'),
  isNull(transactions.ccBillId),
);

/**
 * Card charges already dated into months that have not happened.
 *
 * These are installments: the bank has scheduled them and they will be billed
 * whether or not anything else is spent. They are ALSO already in getMatrix, which
 * has no date ceiling — so this is a different reading of the same rows, never an
 * addition to them.
 */
export function getCommitted(db: DB = getDb(), now: Date = new Date()): CommittedMonth[] {
  return db
    .select({
      month: transactions.month,
      cents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(unbilledCardScope, gt(transactions.postedOn, todayIn(now))))
    .groupBy(transactions.month)
    .orderBy(transactions.month)
    .all()
    .map((r) => ({ month: r.month, cents: -r.cents, count: r.count }));
}

/**
 * The rows behind one committed month.
 *
 * Built from the SAME predicate as getCommitted, so the rows always add up to the
 * figure that was clicked. If these two ever diverge, the page is lying.
 */
export function getCommittedTransactions(
  db: DB = getDb(),
  params: { month: Ym },
  now: Date = new Date(),
): DrillDownRow[] {
  return db
    .select({
      id: transactions.id,
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      merchantName: transactions.merchantName,
      signedCents: transactions.signedCents,
      accountName: accounts.name,
      accountType: accounts.type,
      status: transactions.status,
      categorySource: transactions.categorySource,
      ccInstallmentNumber: transactions.ccInstallmentNumber,
      ccTotalInstallments: transactions.ccTotalInstallments,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(unbilledCardScope, gt(transactions.postedOn, todayIn(now)), eq(transactions.month, params.month)),
    )
    .orderBy(asc(transactions.postedOn), desc(transactions.signedCents))
    .all()
    .map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      postedOn: r.postedOn,
      description: r.description,
      merchantName: r.merchantName,
      cents: -r.signedCents,
      accountName: r.accountName,
      accountType: r.accountType,
      status: r.status,
      categorySource: r.categorySource,
      installment:
        r.ccTotalInstallments && r.ccTotalInstallments > 1
          ? `${r.ccInstallmentNumber ?? '?'}/${r.ccTotalInstallments}`
          : null,
    }));
}

function unbilledRows(db: DB, upTo?: Ymd): UnbilledRow[] {
  return db
    .select({
      accountId: transactions.accountId,
      postedOn: transactions.postedOn,
      cents: sql<number>`-${transactions.signedCents}`,
      description: transactions.description,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(upTo ? and(unbilledCardScope, lte(transactions.postedOn, upTo)) : unbilledCardScope)
    .all();
}

function cycleShapes(db: DB): Map<string, CycleShape> {
  const cards = db
    .select({ id: accounts.id, dueDate: accounts.balanceDueDate })
    .from(accounts)
    .where(eq(accounts.type, 'CREDIT'))
    .all();

  const billRows = db
    .select({
      accountId: bills.accountId,
      dueDate: bills.dueDate,
      // Pluggy sends billClosingDate but PluggyBill does not declare it, so it only
      // ever reaches us inside raw_json. Reading it here beats a column that would
      // be null for every bill already stored.
      closingDate: sql<string | null>`json_extract(${bills.rawJson}, '$.billClosingDate')`,
    })
    .from(bills)
    .all();

  const shapes = new Map<string, CycleShape>();
  for (const card of cards) {
    const own = billRows.filter((b) => b.accountId === card.id);
    const shape = deriveCycleShape(own, card.dueDate);
    if (shape) shapes.set(card.id, shape);
  }
  return shapes;
}

export function getToday(db: DB = getDb(), now: Date = new Date()): Today {
  const asOf = todayIn(now);
  const balances = getBalances(db);
  const cards = getCardHeadroom(db);
  const committed = getCommitted(db, now);

  const names = new Map(cards.map((c) => [c.accountId, c.name]));
  const upcoming = projectCycles(unbilledRows(db), cycleShapes(db), asOf).map((b) => ({
    ...b,
    accountName: names.get(b.accountId) ?? null,
  }));

  return {
    asOf,
    balances,
    balanceTotalCents: balances.reduce((sum, b) => sum + b.cents, 0),
    cards,
    upcoming,
    committed,
    committedTotalCents: committed.reduce((sum, m) => sum + m.cents, 0),
    unbilledTotalCents: upcoming.reduce((sum, b) => sum + b.chargedCents, 0),
    reportedUsedCents: cards.reduce<number | null>(
      (sum, c) => (c.usedCents === null ? sum : (sum ?? 0) + c.usedCents),
      null,
    ),
    horizonMonth: committed.at(-1)?.month ?? null,
  };
}
