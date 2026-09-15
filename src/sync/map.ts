import { toLocalDate } from '../lib/date';
import { toCents } from '../lib/money';
import { buildSearchText, normalize } from '../lib/text';
import { fingerprint } from '../categorize/fingerprint';
import type { NewTransaction } from '../db/schema';
import type { PluggyAccount, PluggyTransaction, PluggyBill, AccountType } from '../pluggy/types';

/**
 * Pure mapping from Pluggy payloads to database rows.
 *
 * Deliberately knows nothing about categories or internal-transfer detection —
 * those are written by a later pass, so a re-sync can never clobber a user's
 * manual decision.
 */

/**
 * Normalize Pluggy's account-type-dependent sign into one convention:
 * NEGATIVE always means money left the user.
 *
 * On CREDIT accounts a positive amount is a purchase (money out); on BANK accounts
 * a positive amount is money in.
 */
export function normalizeSign(amountCents: number, accountType: AccountType): number {
  return accountType === 'CREDIT' ? -amountCents : amountCents;
}

/**
 * Does the normalized sign agree with Pluggy's own DEBIT/CREDIT flag?
 *
 * This is a cheap early-warning system for the highest-consequence assumption in
 * the app. Disagreements are counted into the sync stats rather than thrown, so a
 * handful of odd rows don't abort a sync — but a large count means normalizeSign
 * is wrong and every figure downstream is too.
 */
export function signAgreesWithType(signedCents: number, type: string | null | undefined): boolean {
  if (!type || signedCents === 0) return true;
  const expected = type === 'DEBIT' ? -1 : 1;
  return Math.sign(signedCents) === expected;
}

export function mapTransaction(
  tx: PluggyTransaction,
  account: Pick<PluggyAccount, 'id' | 'type'>,
  ctx: { runId: number; now: string },
): NewTransaction {
  const postedOn = toLocalDate(tx.date);
  const amountCents = toCents(tx.amount);
  const signedCents = normalizeSign(amountCents, account.type);
  const cc = tx.creditCardMetadata ?? null;

  const searchText = buildSearchText({
    description: tx.description,
    descriptionRaw: tx.descriptionRaw,
    merchantName: tx.merchant?.name ?? tx.merchant?.businessName ?? null,
  });

  return {
    id: tx.id,
    accountId: account.id,
    fingerprint: fingerprint({
      accountId: account.id,
      postedOn,
      ccPurchaseDate: cc?.purchaseDate ?? null,
      amountCents,
      searchText,
      ccInstallmentNumber: cc?.installmentNumber ?? null,
    }),

    dateUtc: tx.date,
    postedOn,

    description: tx.description ?? null,
    descriptionRaw: tx.descriptionRaw ?? null,
    searchText,

    amountCents,
    signedCents,
    currencyCode: tx.currencyCode ?? 'BRL',
    type: tx.type ?? null,
    // Pluggy omits `status` on some connectors; an absent status means settled.
    status: tx.status ?? 'POSTED',
    balanceCents: tx.balance == null ? null : toCents(tx.balance),
    providerCode: tx.providerCode ?? null,

    merchantName: tx.merchant?.name ?? tx.merchant?.businessName ?? null,
    merchantCnpj: digitsOnly(tx.merchant?.cnpj),

    pluggyCategory: tx.category ?? null,

    paymentMethod: normalize(tx.paymentData?.paymentMethod) || null,
    payerName: tx.paymentData?.payer?.name ?? null,
    payerDocument: digitsOnly(tx.paymentData?.payer?.documentNumber?.value),
    receiverName: tx.paymentData?.receiver?.name ?? null,
    receiverDocument: digitsOnly(tx.paymentData?.receiver?.documentNumber?.value),

    ccInstallmentNumber: cc?.installmentNumber ?? null,
    ccTotalInstallments: cc?.totalInstallments ?? null,
    ccTotalAmountCents: cc?.totalAmount == null ? null : toCents(cc.totalAmount),
    ccPurchaseDate: cc?.purchaseDate ? toLocalDate(cc.purchaseDate) : null,
    ccBillId: cc?.billId ?? null,

    firstSeenAt: ctx.now,
    lastSeenRunId: ctx.runId,
    deletedAt: null,

    rawJson: JSON.stringify(tx),
  };
}

export function mapAccount(account: PluggyAccount) {
  const credit = account.creditData ?? null;
  return {
    id: account.id,
    itemId: account.itemId,
    type: account.type,
    subtype: account.subtype ?? null,
    name: account.name ?? null,
    number: account.number ?? null,
    balanceCents: account.balance == null ? null : toCents(account.balance),
    currencyCode: account.currencyCode ?? 'BRL',
    creditLimitCents: credit?.creditLimit == null ? null : toCents(credit.creditLimit),
    availableCreditLimitCents:
      credit?.availableCreditLimit == null ? null : toCents(credit.availableCreditLimit),
    balanceCloseDate: credit?.balanceCloseDate ? toLocalDate(credit.balanceCloseDate) : null,
    balanceDueDate: credit?.balanceDueDate ? toLocalDate(credit.balanceDueDate) : null,
    cardBrand: credit?.brand ?? null,
    cardLevel: credit?.level ?? null,
    rawJson: JSON.stringify(account),
  };
}

export function mapBill(bill: PluggyBill, accountId: string) {
  return {
    id: bill.id,
    accountId,
    // Pluggy returns this as a full ISO timestamp ("2026-09-03T00:00:00.000Z"),
    // not a plain date. Normalize like every other date so it renders and compares
    // consistently with postedOn.
    dueDate: bill.dueDate ? toLocalDate(bill.dueDate) : null,
    totalAmountCents: bill.totalAmount == null ? null : toCents(bill.totalAmount),
    minimumPaymentCents:
      bill.minimumPaymentAmount == null ? null : toCents(bill.minimumPaymentAmount),
    allowsInstallments: bill.allowsInstallments ?? null,
    rawJson: JSON.stringify(bill),
  };
}

/** Documents arrive formatted inconsistently (123.456.789-01 vs 12345678901). */
function digitsOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits || null;
}
