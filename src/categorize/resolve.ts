import type { Rule, TransactionOverride } from '../db/schema';

/**
 * The single decision function for "what category is this, and is it internal?".
 *
 * PURE: plain objects in, plain object out. No database, no IO, no clock. That is
 * what makes it cheap to test exhaustively and safe to re-run over every row.
 *
 * Precedence, first hit wins:
 *   1. manual override   — the user's explicit decision always wins
 *   2. structural        — detected card bill payments and own-account transfers
 *   3. rules             — by priority, then id
 *   4. pluggy            — Pluggy's own category, where it maps unambiguously
 *   5. default           — Outros (money out) / Receitas (money in)
 */

export type CategorySource = 'manual' | 'rule' | 'structural' | 'pluggy' | 'default';

export interface ResolvableTransaction {
  id: string;
  fingerprint: string;
  accountId: string;
  accountType: string; // BANK | CREDIT
  signedCents: number; // negative = money left
  searchText: string;
  description: string | null;
  descriptionRaw: string | null;
  merchantName: string | null;
  /** Pluggy's own classification, if any. Consulted only below local rules. */
  pluggyCategory?: string | null;
}

/** Output of the structural internal-movement detector (sync/internal.ts). */
export interface StructuralFinding {
  isInternal: true;
  reason: string; // card_payment | own_transfer
  pairId?: string | null;
}

export interface ResolveContext {
  overrides: ReadonlyMap<string, TransactionOverride>;
  /** Pre-sorted by priority ASC, id ASC. */
  rules: readonly Rule[];
  structural: ReadonlyMap<string, StructuralFinding>;
  /** Pluggy category name -> local category id. See categorize/pluggy-categories.ts. */
  pluggyCategoryIds: ReadonlyMap<string, number>;
  defaults: {
    outrosId: number;
    receitasId: number;
    internalId: number;
  };
}

export interface Resolution {
  categoryId: number | null;
  categorySource: CategorySource;
  isInternal: boolean;
  internalReason: string | null;
  internalPairId: string | null;
}

export function resolve(tx: ResolvableTransaction, ctx: ResolveContext): Resolution {
  const override = ctx.overrides.get(tx.fingerprint);

  // 1. Manual override. isInternal is tri-state: NULL means "no opinion", so the
  //    user can pin a category without also asserting anything about internality.
  if (override?.isInternal === true) {
    return {
      categoryId: override.categoryId ?? ctx.defaults.internalId,
      categorySource: 'manual',
      isInternal: true,
      internalReason: 'manual',
      internalPairId: null,
    };
  }
  const userSaysNotInternal = override?.isInternal === false;

  // 2. Structural detection — unless the user explicitly overruled it.
  const structural = ctx.structural.get(tx.id);
  if (structural && !userSaysNotInternal) {
    return {
      categoryId: override?.categoryId ?? ctx.defaults.internalId,
      categorySource: override?.categoryId ? 'manual' : 'structural',
      isInternal: true,
      internalReason: structural.reason,
      internalPairId: structural.pairId ?? null,
    };
  }

  if (override?.categoryId != null) {
    return {
      categoryId: override.categoryId,
      categorySource: 'manual',
      isInternal: false,
      internalReason: null,
      internalPairId: null,
    };
  }

  // 3. Rules.
  for (const rule of ctx.rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, tx)) continue;

    if (rule.setInternal && !userSaysNotInternal) {
      return {
        categoryId: rule.setCategoryId ?? ctx.defaults.internalId,
        categorySource: 'rule',
        isInternal: true,
        internalReason: 'rule',
        internalPairId: null,
      };
    }
    if (rule.setCategoryId != null) {
      return {
        categoryId: rule.setCategoryId,
        categorySource: 'rule',
        isInternal: false,
        internalReason: null,
        internalPairId: null,
      };
    }
  }

  // 4. Pluggy's own classification, where we trust the mapping. Generic by nature,
  //    so it never gets to overrule a rule the user wrote.
  const hinted = tx.pluggyCategory ? ctx.pluggyCategoryIds.get(tx.pluggyCategory) : undefined;
  if (hinted != null) {
    return {
      categoryId: hinted,
      categorySource: 'pluggy',
      isInternal: false,
      internalReason: null,
      internalPairId: null,
    };
  }

  // 5. Default.
  return {
    categoryId: tx.signedCents > 0 ? ctx.defaults.receitasId : ctx.defaults.outrosId,
    categorySource: 'default',
    isInternal: false,
    internalReason: null,
    internalPairId: null,
  };
}

export function ruleMatches(rule: Rule, tx: ResolvableTransaction): boolean {
  if (rule.accountId && rule.accountId !== tx.accountId) return false;
  if (rule.accountType && rule.accountType !== tx.accountType) return false;

  if (rule.direction === 'in' && tx.signedCents <= 0) return false;
  if (rule.direction === 'out' && tx.signedCents >= 0) return false;

  const magnitude = Math.abs(tx.signedCents);
  if (rule.minCents != null && magnitude < rule.minCents) return false;
  if (rule.maxCents != null && magnitude > rule.maxCents) return false;

  return textMatches(rule, fieldValue(rule.matchField, tx));
}

function fieldValue(field: string, tx: ResolvableTransaction): string {
  switch (field) {
    case 'description':
      return tx.description ?? '';
    case 'description_raw':
      return tx.descriptionRaw ?? '';
    case 'merchant_name':
      return tx.merchantName ?? '';
    case 'search_text':
    default:
      return tx.searchText;
  }
}

function textMatches(rule: Rule, value: string): boolean {
  // Rule values are authored already normalized (uppercase, unaccented); compare
  // case-insensitively anyway so a hand-typed rule still works.
  const haystack = value.toUpperCase();
  const needle = rule.matchValue.toUpperCase();

  switch (rule.matchType) {
    case 'equals':
      return haystack === needle;
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'regex':
      try {
        return new RegExp(rule.matchValue, 'i').test(value);
      } catch {
        // A malformed regex must never abort categorization of everything else.
        return false;
      }
    case 'contains':
    default:
      return haystack.includes(needle);
  }
}
