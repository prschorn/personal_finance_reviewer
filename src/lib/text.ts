/**
 * Text normalization for rule matching, UI search and fingerprinting.
 *
 * Bank descriptions arrive with inconsistent case, accents and spacing, so every
 * comparison in the app runs against a normalized form rather than the raw string.
 */

export function normalize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchTextSource {
  description?: string | null;
  descriptionRaw?: string | null;
  merchantName?: string | null;
}

/**
 * The single text blob that rules match against and the transactions list searches.
 * Duplicates are dropped so a rule can't match the same phrase twice.
 */
export function buildSearchText(src: SearchTextSource): string {
  const parts = [src.description, src.descriptionRaw, src.merchantName]
    .map(normalize)
    .filter(Boolean);
  return [...new Set(parts)].join(' ');
}

/**
 * Drop runs of 6+ digits — NSU numbers, authorization codes, masked card numbers.
 * These change between syncs for what is otherwise the same transaction, so
 * including them would break fingerprint stability.
 */
export function stripVolatileDigits(value: string): string {
  return value.replace(/\d{6,}/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Remove the trailing installment marker a card statement glues onto a purchase.
 *
 * Itaú truncates the description to a fixed width and appends `NN/NN`, so one
 * purchase appears as "PORTO SEGURO CIA S01/10", "…S02/10" and so on. The text
 * before the marker is identical across the whole plan, which makes it the right
 * thing to match a category rule on.
 *
 * `knownTotal` is Pluggy's own totalInstallments when we have it: requiring the
 * marker's second number to equal it removes any doubt about what is being
 * stripped. Without it, fall back to "reads like N of M" — which still declines to
 * strip something like "15/03", where 15 cannot be an installment out of 3.
 */
const INSTALLMENT_SUFFIX = /\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;

export function stripInstallmentSuffix(text: string, knownTotal?: number | null): string {
  const match = INSTALLMENT_SUFFIX.exec(text);
  if (!match) return text;

  const current = Number(match[1]);
  const total = Number(match[2]);

  if (knownTotal != null && knownTotal > 1) {
    if (total !== knownTotal) return text;
  } else if (!(total > 1 && current >= 1 && current <= total)) {
    return text;
  }

  return text.slice(0, match.index).trimEnd();
}
