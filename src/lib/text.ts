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
