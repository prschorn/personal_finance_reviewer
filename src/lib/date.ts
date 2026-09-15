/**
 * Date handling for Pluggy payloads.
 *
 * Pluggy returns transaction dates as ISO8601 UTC. For Brazilian institutions the
 * value is, in practice, `2026-03-01T00:00:00.000Z` — midnight UTC standing in for a
 * *local calendar date*, not a real instant. Converting that naively to
 * America/Sao_Paulo (UTC-3) yields 2026-02-28 21:00, which would file a March
 * transaction under February and corrupt every figure in the monthly matrix.
 *
 * So: exact midnight UTC is treated as a floating local date and passed through
 * verbatim; anything else is a genuine timestamp and is converted to Sao Paulo time.
 * That rule is correct under both interpretations of the field.
 */

export const TIMEZONE = 'America/Sao_Paulo';

/** `YYYY-MM-DD`. Sorts lexicographically, which is also chronologically. */
export type Ymd = string;
/** `YYYY-MM`. */
export type Ym = string;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Matches an ISO string whose time component is exactly midnight UTC. */
const MIDNIGHT_UTC_RE = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?(?:Z|\+00:00))?$/;

// en-CA formats as YYYY-MM-DD, which is exactly what we want to store.
const SP_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function isYmd(value: string): boolean {
  return YMD_RE.test(value);
}

/**
 * Convert a Pluggy ISO8601 date into the local calendar date it belongs to.
 * Throws on unparseable input — a wrong date is worse than a loud failure.
 */
export function toLocalDate(iso: string): Ymd {
  const midnight = MIDNIGHT_UTC_RE.exec(iso);
  if (midnight) return midnight[1]!;

  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Unparseable date from Pluggy: ${JSON.stringify(iso)}`);
  return SP_FORMATTER.format(new Date(ms));
}

export function toMonth(ymd: Ymd): Ym {
  return ymd.slice(0, 7);
}

export function monthsOfYear(year: number): Ym[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** Add (or subtract) whole days. Uses UTC arithmetic so it can't drift on a DST boundary. */
export function addDays(ymd: Ymd, days: number): Ymd {
  if (!isYmd(ymd)) throw new Error(`Expected YYYY-MM-DD, got ${JSON.stringify(ymd)}`);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Today's calendar date in Sao Paulo — the user's "now", not the server's. */
export function today(now: Date = new Date()): Ymd {
  return SP_FORMATTER.format(now);
}

const YM_RE = /^\d{4}-\d{2}$/;

/** Step a month forward or back. Pure arithmetic on the year/month pair. */
export function addMonths(ym: Ym, months: number): Ym {
  if (!YM_RE.test(ym)) throw new Error(`Expected YYYY-MM, got ${JSON.stringify(ym)}`);
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const zeroBased = y * 12 + (m - 1) + months;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

export function daysInMonth(ym: Ym): number {
  if (!YM_RE.test(ym)) throw new Error(`Expected YYYY-MM, got ${JSON.stringify(ym)}`);
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A date within a month, clamped to the month's last day.
 *
 * Card cycles are identified by a day of the month, and a card that bills on the
 * 31st still bills in November — on the 30th. Clamping here is what stops that
 * becoming `2026-11-31`.
 */
export function dateInMonth(ym: Ym, day: number): Ymd {
  const clamped = Math.min(day, daysInMonth(ym));
  return `${ym}-${String(clamped).padStart(2, '0')}`;
}

export function dayOfMonth(ymd: Ymd): number {
  if (!isYmd(ymd)) throw new Error(`Expected YYYY-MM-DD, got ${JSON.stringify(ymd)}`);
  return Number(ymd.slice(8, 10));
}

/** Signed whole-day difference, `a − b`. */
export function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/** Signed whole-month difference, `b − a`. */
export function monthsBetween(a: Ym, b: Ym): number {
  const at = a.split('-').map(Number) as [number, number];
  const bt = b.split('-').map(Number) as [number, number];
  return (bt[0] - at[0]) * 12 + (bt[1] - at[1]);
}

/** The `count` months ending at `ym`, oldest first. */
export function recentMonths(ym: Ym, count: number): Ym[] {
  return Array.from({ length: count }, (_, i) => addMonths(ym, i - count + 1));
}
