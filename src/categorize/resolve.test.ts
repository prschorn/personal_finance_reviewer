import { describe, it, expect } from 'vitest';
import { resolve, ruleMatches, type ResolvableTransaction, type ResolveContext, type StructuralFinding } from './resolve';
import type { Rule, TransactionOverride } from '../db/schema';
import { PLUGGY_CATEGORY_MAP, PLUGGY_CATEGORY_UNMAPPED, PLUGGY_INTERNAL_CATEGORIES } from './pluggy-categories';

const OUTROS = 900, RECEITAS = 901, INTERNAL = 902;
const MERCADO = 15, RESTAURANTE = 14;

function tx(over: Partial<ResolvableTransaction> = {}): ResolvableTransaction {
  return {
    id: 'tx-1', fingerprint: 'fp-1', accountId: 'acc-bank', accountType: 'BANK',
    signedCents: -5000, searchText: 'MERCADO EXTRA', description: 'Mercado Extra',
    descriptionRaw: 'MERCADO EXTRA 123', merchantName: 'Extra', ...over,
  };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 1, priority: 100, enabled: true, name: 'r', matchField: 'search_text',
    matchType: 'contains', matchValue: 'MERCADO', accountId: null, accountType: null,
    direction: null, minCents: null, maxCents: null, setCategoryId: MERCADO,
    setInternal: null, ...over,
  };
}

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    overrides: new Map(), rules: [], structural: new Map(),
    pluggyCategoryIds: new Map(),
    defaults: { outrosId: OUTROS, receitasId: RECEITAS, internalId: INTERNAL },
    ...over,
  };
}

function override(over: Partial<TransactionOverride> = {}): TransactionOverride {
  return { fingerprint: 'fp-1', categoryId: null, isInternal: null, note: null, migratedFrom: null, updatedAt: 'now', ...over };
}

const internal: StructuralFinding = { isInternal: true, reason: 'card_payment' };

describe('default fallback', () => {
  it('sends unmatched money-out to Outros', () => {
    expect(resolve(tx(), ctx())).toMatchObject({ categoryId: OUTROS, categorySource: 'default', isInternal: false });
  });

  it('sends unmatched money-in to Receitas', () => {
    expect(resolve(tx({ signedCents: 500000 }), ctx())).toMatchObject({ categoryId: RECEITAS, categorySource: 'default' });
  });
});

describe('rules', () => {
  it('assigns the matching rule category', () => {
    expect(resolve(tx(), ctx({ rules: [rule()] }))).toMatchObject({ categoryId: MERCADO, categorySource: 'rule' });
  });

  it('takes the first match in priority order', () => {
    const rules = [
      rule({ id: 1, priority: 10, matchValue: 'MERCADO', setCategoryId: MERCADO }),
      rule({ id: 2, priority: 20, matchValue: 'EXTRA', setCategoryId: RESTAURANTE }),
    ];
    expect(resolve(tx(), ctx({ rules })).categoryId).toBe(MERCADO);
    expect(resolve(tx(), ctx({ rules: [...rules].reverse().map((r, i) => ({ ...r, priority: (i + 1) * 10 })) })).categoryId).toBe(RESTAURANTE);
  });

  it('skips disabled rules', () => {
    expect(resolve(tx(), ctx({ rules: [rule({ enabled: false })] })).categorySource).toBe('default');
  });

  it('can mark a transaction internal', () => {
    const r = rule({ matchValue: 'APLICACAO', setInternal: true, setCategoryId: null });
    const res = resolve(tx({ searchText: 'APLICACAO AUTOMATICA' }), ctx({ rules: [r] }));
    expect(res).toMatchObject({ isInternal: true, internalReason: 'rule', categoryId: INTERNAL });
  });

  it('survives a malformed regex without derailing everything else', () => {
    const bad = rule({ id: 1, priority: 10, matchType: 'regex', matchValue: '([unclosed' });
    const good = rule({ id: 2, priority: 20, matchValue: 'MERCADO' });
    expect(resolve(tx(), ctx({ rules: [bad, good] })).categoryId).toBe(MERCADO);
  });
});

describe('rule narrowing', () => {
  it('matches on each text field', () => {
    expect(ruleMatches(rule({ matchField: 'merchant_name', matchValue: 'EXTRA' }), tx())).toBe(true);
    expect(ruleMatches(rule({ matchField: 'merchant_name', matchValue: 'MERCADO' }), tx())).toBe(false);
    expect(ruleMatches(rule({ matchField: 'description', matchValue: 'MERCADO' }), tx())).toBe(true);
  });

  it('supports each match type', () => {
    expect(ruleMatches(rule({ matchType: 'equals', matchValue: 'MERCADO EXTRA' }), tx())).toBe(true);
    expect(ruleMatches(rule({ matchType: 'equals', matchValue: 'MERCADO' }), tx())).toBe(false);
    expect(ruleMatches(rule({ matchType: 'startsWith', matchValue: 'MERCADO' }), tx())).toBe(true);
    expect(ruleMatches(rule({ matchType: 'regex', matchValue: 'MERC.DO' }), tx())).toBe(true);
  });

  it('narrows by account and account type', () => {
    expect(ruleMatches(rule({ accountId: 'acc-bank' }), tx())).toBe(true);
    expect(ruleMatches(rule({ accountId: 'acc-card' }), tx())).toBe(false);
    expect(ruleMatches(rule({ accountType: 'CREDIT' }), tx())).toBe(false);
    expect(ruleMatches(rule({ accountType: 'BANK' }), tx())).toBe(true);
  });

  it('narrows by direction', () => {
    expect(ruleMatches(rule({ direction: 'out' }), tx({ signedCents: -100 }))).toBe(true);
    expect(ruleMatches(rule({ direction: 'out' }), tx({ signedCents: 100 }))).toBe(false);
    expect(ruleMatches(rule({ direction: 'in' }), tx({ signedCents: 100 }))).toBe(true);
  });

  it('narrows by magnitude, ignoring sign', () => {
    expect(ruleMatches(rule({ minCents: 1000 }), tx({ signedCents: -5000 }))).toBe(true);
    expect(ruleMatches(rule({ minCents: 10000 }), tx({ signedCents: -5000 }))).toBe(false);
    expect(ruleMatches(rule({ maxCents: 1000 }), tx({ signedCents: -5000 }))).toBe(false);
    expect(ruleMatches(rule({ minCents: 1000, maxCents: 10000 }), tx({ signedCents: -5000 }))).toBe(true);
  });
});

describe('structural internal detection', () => {
  it('marks a detected card bill payment internal', () => {
    const res = resolve(tx(), ctx({ structural: new Map([['tx-1', internal]]) }));
    expect(res).toMatchObject({ isInternal: true, internalReason: 'card_payment', categorySource: 'structural', categoryId: INTERNAL });
  });

  it('beats a rule', () => {
    const res = resolve(tx(), ctx({ rules: [rule()], structural: new Map([['tx-1', internal]]) }));
    expect(res.isInternal).toBe(true);
    expect(res.categoryId).toBe(INTERNAL);
  });

  it('carries the pair id through', () => {
    const paired: StructuralFinding = { isInternal: true, reason: 'own_transfer', pairId: 'pair-7' };
    expect(resolve(tx(), ctx({ structural: new Map([['tx-1', paired]]) })).internalPairId).toBe('pair-7');
  });
});

describe('manual override precedence', () => {
  it('beats a rule', () => {
    const res = resolve(tx(), ctx({ rules: [rule()], overrides: new Map([['fp-1', override({ categoryId: RESTAURANTE })]]) }));
    expect(res).toMatchObject({ categoryId: RESTAURANTE, categorySource: 'manual' });
  });

  it('beats structural detection when the user says it is NOT internal', () => {
    const res = resolve(
      tx(),
      ctx({ structural: new Map([['tx-1', internal]]), overrides: new Map([['fp-1', override({ isInternal: false, categoryId: MERCADO })]]) }),
    );
    expect(res).toMatchObject({ isInternal: false, categoryId: MERCADO, categorySource: 'manual' });
  });

  it('can mark something internal that nothing detected', () => {
    const res = resolve(tx(), ctx({ overrides: new Map([['fp-1', override({ isInternal: true })]]) }));
    expect(res).toMatchObject({ isInternal: true, internalReason: 'manual', categoryId: INTERNAL });
  });

  // Tri-state: a category-only override must not assert anything about internality.
  it('does not suppress structural detection when it has no opinion on internality', () => {
    const res = resolve(
      tx(),
      ctx({ structural: new Map([['tx-1', internal]]), overrides: new Map([['fp-1', override({ categoryId: MERCADO, isInternal: null })]]) }),
    );
    expect(res.isInternal).toBe(true);
    expect(res.categoryId).toBe(MERCADO); // the user's category still wins
  });

  it('overrules a rule that wanted to mark it internal', () => {
    const r = rule({ matchValue: 'MERCADO', setInternal: true, setCategoryId: null });
    const res = resolve(tx(), ctx({ rules: [r], overrides: new Map([['fp-1', override({ isInternal: false })]]) }));
    expect(res.isInternal).toBe(false);
  });

  it('applies to a different transaction sharing the fingerprint, by design', () => {
    const c = ctx({ overrides: new Map([['fp-1', override({ categoryId: RESTAURANTE })]]) });
    expect(resolve(tx({ id: 'tx-2' }), c).categoryId).toBe(RESTAURANTE);
  });
});

describe('purity', () => {
  it('returns an equal result for equal input and mutates nothing', () => {
    const t = tx();
    const c = ctx({ rules: [rule()] });
    const before = JSON.stringify(t);
    expect(resolve(t, c)).toEqual(resolve(t, c));
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('Pluggy category hint', () => {
  const hints = new Map([['Eating out', RESTAURANTE], ['Groceries', MERCADO]]);

  it('fills in where no local rule matched', () => {
    const res = resolve(tx({ searchText: 'ALGO OBSCURO', pluggyCategory: 'Eating out' }), ctx({ pluggyCategoryIds: hints }));
    expect(res).toMatchObject({ categoryId: RESTAURANTE, categorySource: 'pluggy' });
  });

  // Generic by nature: it must never beat a rule the user wrote for their own life.
  it('never beats a local rule', () => {
    const res = resolve(
      tx({ pluggyCategory: 'Eating out' }),
      ctx({ rules: [rule({ matchValue: 'MERCADO', setCategoryId: MERCADO })], pluggyCategoryIds: hints }),
    );
    expect(res).toMatchObject({ categoryId: MERCADO, categorySource: 'rule' });
  });

  it('never beats a manual choice', () => {
    const res = resolve(
      tx({ pluggyCategory: 'Eating out' }),
      ctx({ overrides: new Map([['fp-1', override({ categoryId: MERCADO })]]), pluggyCategoryIds: hints }),
    );
    expect(res.categorySource).toBe('manual');
  });

  // Vague Pluggy categories are deliberately unmapped so they surface for review
  // rather than being filed somewhere plausible but wrong.
  it('falls through to Outros for an unmapped category', () => {
    const res = resolve(tx({ searchText: 'XYZ', pluggyCategory: 'Services' }), ctx({ pluggyCategoryIds: hints }));
    expect(res).toMatchObject({ categoryId: OUTROS, categorySource: 'default' });
  });
});

describe('Pluggy hint restraint', () => {
  // Regression: 'Automotive' was mapped to Manutenção and filed a R$50.000 car
  // purchase as car servicing, making it the largest expense category of the year.
  it('leaves over-broad Pluggy labels unmapped', () => {
    for (const label of Object.keys(PLUGGY_CATEGORY_UNMAPPED)) {
      expect(PLUGGY_CATEGORY_MAP[label]).toBeUndefined();
    }
  });

  it('never maps a label to both a category and the unmapped list', () => {
    for (const label of Object.keys(PLUGGY_INTERNAL_CATEGORIES)) {
      expect(PLUGGY_CATEGORY_MAP[label]).toBeUndefined();
      expect(PLUGGY_CATEGORY_UNMAPPED[label]).toBeUndefined();
    }
  });
});
