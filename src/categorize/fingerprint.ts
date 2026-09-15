import { createHash } from 'node:crypto';
import { toLocalDate } from '../lib/date';
import { stripVolatileDigits } from '../lib/text';

/**
 * A stable synthetic identity for a transaction.
 *
 * Pluggy transaction ids are NOT stable: when date, description or amount shift
 * materially between syncs — which is exactly what happens on PENDING -> POSTED —
 * Pluggy deletes the row and recreates it under a new id. Keying the user's manual
 * categorizations on the Pluggy id would therefore throw them away every month.
 *
 * The fingerprint is built only from fields that survive that transition.
 */

export interface FingerprintInput {
  accountId: string;
  /** Local YYYY-MM-DD. */
  postedOn: string;
  /** Raw creditCardMetadata.purchaseDate, if any. */
  ccPurchaseDate?: string | null;
  /** Raw Pluggy amount in cents — NOT the sign-normalized value. */
  amountCents: number;
  /** Normalized search text (see lib/text.ts). */
  searchText: string;
  /** creditCardMetadata.installmentNumber, if any. */
  ccInstallmentNumber?: number | null;
}

/**
 * For card purchases the merchant-set purchase date is stable, while the posting
 * date is the very field that moves when the transaction is recreated. Anchoring
 * on purchaseDate is what lets a card override survive PENDING -> POSTED.
 */
export function anchorDate(input: Pick<FingerprintInput, 'postedOn' | 'ccPurchaseDate'>): string {
  if (!input.ccPurchaseDate) return input.postedOn;
  try {
    return toLocalDate(input.ccPurchaseDate);
  } catch {
    return input.postedOn;
  }
}

export function descriptionKey(searchText: string): string {
  return stripVolatileDigits(searchText);
}

export function fingerprint(input: FingerprintInput): string {
  const parts = [
    input.accountId,
    anchorDate(input),
    String(input.amountCents),
    descriptionKey(input.searchText),
    // Every installment of one purchase shares account, purchase date, amount and
    // description, so without this they would all collapse to a single identity —
    // and an override on one would silently apply to all of them. The installment
    // number is assigned by the issuer and does not change on a recreate, so it
    // disambiguates without costing stability.
    input.ccInstallmentNumber ? `i${input.ccInstallmentNumber}` : '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
