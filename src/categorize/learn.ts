import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { rules, transactions } from '../db/schema';
import { normalize, stripInstallmentSuffix, stripVolatileDigits } from '../lib/text';

/**
 * Turn "this one is Mercado" into "everything like this is Mercado".
 *
 * A per-transaction override is keyed to one exact transaction — same account,
 * date, amount and description — so it cannot reach the same merchant in another
 * month. A RULE can, and rules are re-evaluated over every transaction after every
 * sync, so a correction made in September also fixes January and keeps applying in
 * October. That is why categorizing creates a rule by default.
 */

/** Rules created this way outrank the shipped ones: an explicit choice beats a guess. */
export const USER_RULE_PRIORITY = 1;

/** Below this, a match value is too generic to make a rule from safely. */
const MIN_KEY_LENGTH = 4;

export interface LearnResult {
  ok: boolean;
  /** The text the rule matches on. */
  key?: string;
  /** How many transactions the rule now covers. */
  matched?: number;
  /** Set when the transaction was one installment of a split purchase. */
  totalInstallments?: number | null;
  /** Narrower rules this one absorbed, e.g. one-per-installment rules made earlier. */
  superseded?: string[];
  /** True when an existing rule for the same text was repointed, not created. */
  updatedExisting?: boolean;
  reason?: string;
}

export interface MatchKeySource {
  description: string | null;
  merchantName: string | null;
  /** Pluggy's totalInstallments, when the purchase was split. */
  ccTotalInstallments?: number | null;
}

/**
 * The text a rule should match on.
 *
 * Normalized, with two things removed:
 *  - volatile digit runs, so an authorization code can't make every purchase
 *    look like a different merchant;
 *  - the trailing installment marker, so the ten rows of one split purchase
 *    ("…S01/10" through "…S10/10") share a single key and one category choice
 *    covers the whole plan.
 */
export function matchKeyFor(tx: MatchKeySource): string | null {
  const source = tx.merchantName?.trim() ? tx.merchantName : tx.description;
  const withoutInstallment = stripInstallmentSuffix(normalize(source), tx.ccTotalInstallments);
  const key = stripVolatileDigits(withoutInstallment);
  return key.length >= MIN_KEY_LENGTH ? key : null;
}

/** How many live transactions actually carry a category, for honest reporting. */
export function countWithCategory(db: DB, key: string, categoryId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(
        and(
          isNull(transactions.deletedAt),
          eq(transactions.categoryId, categoryId),
          sql`${transactions.searchText} LIKE ${'%' + key + '%'}`,
        ),
      )
      .get()?.n ?? 0
  );
}

/** Count what a prospective rule would capture, so the UI can say so before/after. */
export function countMatching(db: DB, key: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(transactions)
      .where(and(isNull(transactions.deletedAt), sql`${transactions.searchText} LIKE ${'%' + key + '%'}`))
      .get()?.n ?? 0
  );
}

/**
 * Create or update the user rule for a transaction's merchant.
 *
 * Idempotent on the match key: re-categorizing the same merchant updates the
 * existing rule instead of stacking a second one that shadows it.
 */
export function learnCategoryFromTransaction(
  db: DB = getDb(),
  fingerprint: string,
  categoryId: number | null,
  now = new Date().toISOString(),
): LearnResult {
  const tx = db
    .select({
      description: transactions.description,
      merchantName: transactions.merchantName,
      ccTotalInstallments: transactions.ccTotalInstallments,
    })
    .from(transactions)
    .where(eq(transactions.fingerprint, fingerprint))
    .get();
  if (!tx) return { ok: false, reason: 'Transação não encontrada' };

  const key = matchKeyFor(tx);
  if (!key) {
    return { ok: false, reason: 'A descrição é curta demais para virar regra. Use "só esta".' };
  }

  const existing = db
    .select()
    .from(rules)
    .where(and(eq(rules.origin, 'user'), eq(rules.matchValue, key)))
    .get();

  const totalInstallments = tx.ccTotalInstallments && tx.ccTotalInstallments > 1 ? tx.ccTotalInstallments : null;

  if (categoryId == null) {
    // Clearing the category removes the rule rather than leaving a rule that does nothing.
    if (existing) db.delete(rules).where(eq(rules.id, existing.id)).run();
    return { ok: true, key, matched: countMatching(db, key), totalInstallments };
  }

  // Absorb any narrower user rule this one now covers. Categorizing installments
  // one at a time (before the key learned to ignore the "NN/NN" marker) leaves a
  // rule per installment; they are redundant once a single rule covers the plan,
  // and at equal priority the older ones would match first and shadow this one.
  const superseded = db
    .select({ id: rules.id, matchValue: rules.matchValue })
    .from(rules)
    .where(eq(rules.origin, 'user'))
    .all()
    .filter((r) => r.matchValue !== key && r.matchValue.includes(key));

  for (const stale of superseded) {
    db.delete(rules).where(eq(rules.id, stale.id)).run();
  }

  if (existing) {
    db.update(rules).set({ setCategoryId: categoryId, enabled: true, setInternal: null }).where(eq(rules.id, existing.id)).run();
  } else {
    db.insert(rules)
      .values({
        priority: USER_RULE_PRIORITY,
        name: key,
        matchField: 'search_text',
        matchType: 'contains',
        matchValue: key,
        setCategoryId: categoryId,
        origin: 'user',
        createdAt: now,
      })
      .run();
  }

  return {
    ok: true,
    key,
    matched: countMatching(db, key),
    totalInstallments,
    superseded: superseded.map((r) => r.matchValue),
    updatedExisting: !!existing,
  };
}

/**
 * Find the rule that is winning over the one we just made, so the UI can name it.
 *
 * Applies the same ordering the categorizer uses — priority, then specificity,
 * then age — and returns the first rule that matches the key and would assign a
 * different category.
 */
export function findShadowingRule(
  db: DB,
  key: string,
  intendedCategoryId: number,
): { id: number; name: string } | null {
  const ordered = db
    .select()
    .from(rules)
    .orderBy(asc(rules.priority), desc(sql`length(${rules.matchValue})`), asc(rules.id))
    .all();

  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (!ruleCouldMatch(rule, key)) continue;
    if (rule.setInternal) return { id: rule.id, name: rule.name };
    if (rule.setCategoryId != null && rule.setCategoryId !== intendedCategoryId) {
      return { id: rule.id, name: rule.name };
    }
    if (rule.setCategoryId === intendedCategoryId) return null; // ours won
  }
  return null;
}

/** Approximate: does this rule's pattern hit the key text? */
function ruleCouldMatch(rule: { matchType: string; matchValue: string }, key: string): boolean {
  const haystack = key.toUpperCase();
  const needle = rule.matchValue.toUpperCase();
  switch (rule.matchType) {
    case 'equals':
      return haystack === needle;
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'regex':
      try {
        return new RegExp(rule.matchValue, 'i').test(key);
      } catch {
        return false;
      }
    default:
      return haystack.includes(needle);
  }
}

export interface RuleChangeResult {
  ok: boolean;
  /** Rule name, for the confirmation message. */
  name?: string;
  /** How many transactions changed category as a result. */
  moved?: number;
  reason?: string;
}

/**
 * Delete a rule you created.
 *
 * Only user rules can be deleted. Deleting a shipped rule would not stick —
 * seedRules() re-inserts anything missing by name on the next boot — so those are
 * disabled instead, which does persist because seeding skips names already present.
 */
export function deleteUserRule(db: DB, id: number): RuleChangeResult {
  const rule = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!rule) return { ok: false, reason: 'Regra não encontrada' };
  if (rule.origin !== 'user') {
    return { ok: false, reason: 'Regras que vêm com o app não podem ser removidas, só desativadas.' };
  }
  db.delete(rules).where(eq(rules.id, id)).run();
  return { ok: true, name: rule.name };
}

/** Turn a rule off (or back on) without deleting it. Works for shipped rules too. */
export function setRuleEnabled(db: DB, id: number, enabled: boolean): RuleChangeResult {
  const rule = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!rule) return { ok: false, reason: 'Regra não encontrada' };
  db.update(rules).set({ enabled }).where(eq(rules.id, id)).run();
  return { ok: true, name: rule.name };
}

/** Snapshot of every live transaction's category, to measure what a change moved. */
export function categorySnapshot(db: DB): Map<string, number | null> {
  return new Map(
    db
      .select({ id: transactions.id, categoryId: transactions.categoryId })
      .from(transactions)
      .where(isNull(transactions.deletedAt))
      .all()
      .map((r) => [r.id, r.categoryId]),
  );
}

export function countMoved(before: Map<string, number | null>, after: Map<string, number | null>): number {
  let moved = 0;
  for (const [id, categoryId] of after) {
    if (before.get(id) !== categoryId) moved++;
  }
  return moved;
}
