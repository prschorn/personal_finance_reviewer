import { isNull, eq, and } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, bills, transactions } from '../db/schema';
import type { StructuralFinding } from '../categorize/resolve';
import { getOwnIdentifiers, type OwnIdentifiers } from '../config/own';
import { PLUGGY_INTERNAL_CATEGORIES } from '../categorize/pluggy-categories';

/**
 * Detect movements between the user's own accounts, so they don't count as spending.
 *
 * Scope note: this module handles only what RULES CANNOT — decisions that require
 * looking at OTHER rows (matching a payment against a bill, pairing two sides of a
 * transfer). Single-row description matching, such as "PAGAMENTO" on the card side,
 * lives in the rules engine where it belongs (see categorize/seed-rules.ts).
 *
 * The worst failure this app can have is silently excluding real spending, so every
 * finding here is reviewable and overridable on /internal.
 */

/** A bank payment may differ from the bill total by rounding or a small adjustment. */
export const BILL_AMOUNT_TOLERANCE_CENTS = 50;
/** How far the payment may sit from the bill's due date. */
export const BILL_DUE_DATE_WINDOW_DAYS = 5;
/** The two sides of an own-account transfer post within a couple of days. */
export const TRANSFER_PAIR_WINDOW_DAYS = 2;

const TRANSFER_METHODS = new Set(['PIX', 'TED', 'DOC']);

export interface InternalDetectionStats {
  cardPayments: number;
  ownTransfers: number;
  /** Found via Pluggy's own classification rather than our heuristics. */
  fromPluggyCategory: number;
}

export interface DetectInternalResult {
  findings: Map<string, StructuralFinding>;
  stats: InternalDetectionStats;
}

interface Candidate {
  id: string;
  accountId: string;
  accountType: string;
  signedCents: number;
  amountCents: number;
  postedOn: string;
  searchText: string;
  pluggyCategory: string | null;
  paymentMethod: string | null;
  payerDocument: string | null;
  receiverDocument: string | null;
  payerName: string | null;
  receiverName: string | null;
}

export function detectInternal(
  db: DB = getDb(),
  own: OwnIdentifiers = getOwnIdentifiers(db),
): DetectInternalResult {
  const findings = new Map<string, StructuralFinding>();
  const stats: InternalDetectionStats = { cardPayments: 0, ownTransfers: 0, fromPluggyCategory: 0 };

  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountType: accounts.type,
      signedCents: transactions.signedCents,
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
      searchText: transactions.searchText,
      pluggyCategory: transactions.pluggyCategory,
      paymentMethod: transactions.paymentMethod,
      payerDocument: transactions.payerDocument,
      receiverDocument: transactions.receiverDocument,
      payerName: transactions.payerName,
      receiverName: transactions.receiverName,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(isNull(transactions.deletedAt))
    .all();

  // Pluggy's own labels first: "Credit card payment" and "Same person transfer"
  // are unambiguous and far more reliable than matching description text.
  detectByPluggyCategory(rows, findings, stats);
  detectCardBillPayments(db, rows, findings, stats);
  detectOwnTransfers(rows, own, findings, stats);

  return { findings, stats };
}

/**
 * Pluggy's own classification, where it is unambiguous.
 *
 * The probe found `category` populated on ~98% of transactions on this account,
 * including "Credit card payment" and "Same person transfer" — exactly the two
 * things the heuristics below try to infer from description text. When Pluggy has
 * already said so, believe it.
 */
function detectByPluggyCategory(
  rows: Candidate[],
  findings: Map<string, StructuralFinding>,
  stats: InternalDetectionStats,
): void {
  for (const row of rows) {
    if (!row.pluggyCategory) continue;
    const reason = PLUGGY_INTERNAL_CATEGORIES[row.pluggyCategory];
    if (!reason) continue;
    findings.set(row.id, { isInternal: true, reason, pairId: null });
    stats.fromPluggyCategory++;
  }
}

/**
 * A. Bank-side credit card bill payment.
 *
 * The strong signal is an exact-ish match against a bill we actually hold: same
 * amount within tolerance, posted near that bill's due date. Requires cross-row
 * lookup, which is why it lives here rather than in a rule.
 *
 * When bills are unavailable (the free tier may forbid them) this finds nothing
 * and the description-based rule carries the load instead.
 */
function detectCardBillPayments(
  db: DB,
  rows: Candidate[],
  findings: Map<string, StructuralFinding>,
  stats: InternalDetectionStats,
): void {
  const ownBills = db
    .select({
      id: bills.id,
      totalAmountCents: bills.totalAmountCents,
      dueDate: bills.dueDate,
    })
    .from(bills)
    .innerJoin(accounts, eq(accounts.id, bills.accountId))
    .where(eq(accounts.type, 'CREDIT'))
    .all()
    .filter((b): b is { id: string; totalAmountCents: number; dueDate: string } =>
      b.totalAmountCents != null && b.dueDate != null);

  if (!ownBills.length) return;

  for (const row of rows) {
    if (findings.has(row.id)) continue;
    // A bill payment leaves a BANK account.
    if (row.accountType !== 'BANK' || row.signedCents >= 0) continue;

    const magnitude = Math.abs(row.signedCents);
    const match = ownBills.find(
      (b) =>
        Math.abs(b.totalAmountCents - magnitude) <= BILL_AMOUNT_TOLERANCE_CENTS &&
        Math.abs(daysBetween(row.postedOn, b.dueDate)) <= BILL_DUE_DATE_WINDOW_DAYS,
    );
    if (!match) continue;

    findings.set(row.id, { isInternal: true, reason: 'card_payment', pairId: `bill:${match.id}` });
    stats.cardPayments++;
  }
}

/**
 * C. Transfers between the user's own accounts.
 *
 * Both legs are in our data, so they can be paired: opposite signs, identical
 * magnitude, different accounts, a couple of days apart. Bucketed by magnitude so
 * the scan is O(n) rather than O(n^2).
 *
 * Requires corroboration — a transfer payment method or a counterparty that is
 * demonstrably the user — so two unrelated R$ 50 movements aren't paired by luck.
 */
function detectOwnTransfers(
  rows: Candidate[],
  own: OwnIdentifiers,
  findings: Map<string, StructuralFinding>,
  stats: InternalDetectionStats,
): void {
  const byMagnitude = new Map<number, Candidate[]>();
  for (const row of rows) {
    if (findings.has(row.id) || row.signedCents === 0) continue;
    const key = Math.abs(row.signedCents);
    const bucket = byMagnitude.get(key);
    if (bucket) bucket.push(row);
    else byMagnitude.set(key, [row]);
  }

  const paired = new Set<string>();

  for (const bucket of byMagnitude.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => a.postedOn.localeCompare(b.postedOn));

    for (let i = 0; i < sorted.length; i++) {
      const out = sorted[i]!;
      if (paired.has(out.id) || out.signedCents >= 0) continue;

      for (let j = 0; j < sorted.length; j++) {
        const inbound = sorted[j]!;
        if (i === j || paired.has(inbound.id)) continue;
        if (inbound.signedCents <= 0) continue;
        if (inbound.accountId === out.accountId) continue;
        if (Math.abs(daysBetween(out.postedOn, inbound.postedOn)) > TRANSFER_PAIR_WINDOW_DAYS) continue;
        if (!looksLikeTransfer(out, own) && !looksLikeTransfer(inbound, own)) continue;

        const pairId = `pair:${out.id}:${inbound.id}`;
        findings.set(out.id, { isInternal: true, reason: 'own_transfer', pairId });
        findings.set(inbound.id, { isInternal: true, reason: 'own_transfer', pairId });
        paired.add(out.id);
        paired.add(inbound.id);
        stats.ownTransfers += 2;
        break;
      }
    }
  }
}

/** Corroborating evidence that a movement is the user's own money moving sideways. */
function looksLikeTransfer(row: Candidate, own: OwnIdentifiers): boolean {
  if (row.paymentMethod && TRANSFER_METHODS.has(row.paymentMethod)) return true;

  for (const doc of own.documents) {
    if (row.payerDocument === doc || row.receiverDocument === doc) return true;
  }
  for (const fragment of own.nameFragments) {
    if (!fragment) continue;
    if (row.payerName?.toUpperCase().includes(fragment)) return true;
    if (row.receiverName?.toUpperCase().includes(fragment)) return true;
  }
  return /\b(TRANSFERENCIA|TRANSF ENTRE|TED|DOC|PIX)\b/.test(row.searchText);
}

/** Every transaction the app excluded as internal, for the /internal review page. */
export function listInternal(db: DB = getDb()) {
  return db
    .select({
      id: transactions.id,
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      signedCents: transactions.signedCents,
      internalReason: transactions.internalReason,
      internalPairId: transactions.internalPairId,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.isInternal, true)))
    .orderBy(transactions.postedOn)
    .all();
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86_400_000;
}
