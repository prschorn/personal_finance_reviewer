import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { seedRules } from './seed-rules';
import { accounts, categories, items, rules, transactions } from '../db/schema';
import {
  categorySnapshot, countMoved, deleteUserRule, findShadowingRule,
  learnCategoryFromTransaction, matchKeyFor, setRuleEnabled, USER_RULE_PRIORITY,
} from './learn';
import { recategorizeAll, setOverride } from './recategorize';
import { buildSearchText } from '../lib/text';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  seedRules(db);
  db.insert(items).values({ id: 'item-1' }).run();
  db.insert(accounts).values({ id: 'acc-1', itemId: 'item-1', type: 'CREDIT' }).run();
  return db;
}

let n = 0;
function addTx(
  db: DB, description: string, postedOn: string, signedCents = -15640,
  merchantName: string | null = null, installments?: [number, number],
) {
  const id = `tx-${++n}`;
  db.insert(transactions)
    .values({
      id, accountId: 'acc-1', fingerprint: `fp-${id}`,
      dateUtc: `${postedOn}T12:00:00.000Z`, postedOn,
      description, merchantName,
      searchText: buildSearchText({ description, merchantName }),
      amountCents: Math.abs(signedCents), signedCents,
      status: 'POSTED', firstSeenAt: 'now', lastSeenRunId: 1, rawJson: '{}',
      ccInstallmentNumber: installments?.[0] ?? null,
      ccTotalInstallments: installments?.[1] ?? null,
    })
    .run();
  return id;
}

const catId = (db: DB, name: string) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
const categoryOf = (db: DB, id: string) =>
  db.select({ name: categories.name }).from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.id, id)).get()?.name ?? null;

describe('matchKeyFor', () => {
  it('uses the merchant name when present, else the description', () => {
    expect(matchKeyFor({ description: 'COMPRA 123', merchantName: 'iFood' })).toBe('IFOOD');
    expect(matchKeyFor({ description: 'EST COMERCIAL LTDA 4471', merchantName: null })).toBe('EST COMERCIAL LTDA 4471');
  });

  it('strips volatile digit runs so an auth code does not make each purchase unique', () => {
    expect(matchKeyFor({ description: 'PADARIA NSU 998877665', merchantName: null })).toBe('PADARIA NSU');
  });

  it('refuses a key too short to be safe as a rule', () => {
    expect(matchKeyFor({ description: 'PIX', merchantName: null })).toBeNull();
    expect(matchKeyFor({ description: '', merchantName: null })).toBeNull();
  });
});

describe('categorizing one transaction teaches the rest', () => {
  // The core of the request: fixing September must fix January and October too.
  it('applies to the same merchant across every month, past and future', () => {
    const db = freshDb();
    const jan = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-01-17');
    const sep = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-17');
    const oct = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-10-17');
    recategorizeAll(db);
    expect(categoryOf(db, jan)).toBe('Outros');

    const res = learnCategoryFromTransaction(db, `fp-${sep}`, catId(db, 'Compras'));
    recategorizeAll(db);

    expect(res.ok).toBe(true);
    expect(res.matched).toBe(3);
    expect(categoryOf(db, jan)).toBe('Compras');
    expect(categoryOf(db, sep)).toBe('Compras');
    expect(categoryOf(db, oct)).toBe('Compras');
  });

  it('leaves other merchants alone', () => {
    const db = freshDb();
    const target = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-17');
    const other = addTx(db, 'ZZZ ESTABELECIMENTO QUALQUER', '2026-09-18');

    learnCategoryFromTransaction(db, `fp-${target}`, catId(db, 'Compras'));
    recategorizeAll(db);

    expect(categoryOf(db, target)).toBe('Compras');
    expect(categoryOf(db, other)).toBe('Outros');
  });

  it('beats the shipped rules, because an explicit choice beats a guess', () => {
    const db = freshDb();
    const id = addTx(db, 'IFOOD *SUSHI YAMA', '2026-09-10');
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Restaurante'); // from the seed rule

    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Marmitas'));
    recategorizeAll(db);

    expect(categoryOf(db, id)).toBe('Marmitas');
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).get()?.priority).toBe(USER_RULE_PRIORITY);
  });

  it('updates its own rule instead of stacking a second one', () => {
    const db = freshDb();
    const id = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-17');

    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Compras'));
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Mercado'));
    recategorizeAll(db);

    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(1);
    expect(categoryOf(db, id)).toBe('Mercado');
  });

  it('removes the rule when the category is cleared', () => {
    const db = freshDb();
    const id = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-17');
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Compras'));
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(1);

    learnCategoryFromTransaction(db, `fp-${id}`, null);
    recategorizeAll(db);

    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(0);
    expect(categoryOf(db, id)).toBe('Outros');
  });

  it('reports a description too generic to make a rule from', () => {
    const db = freshDb();
    const id = addTx(db, 'PIX', '2026-09-17');
    const res = learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Compras'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/curta demais/);
  });

  it('matches on the merchant name when descriptions vary', () => {
    const db = freshDb();
    const a = addTx(db, 'UBER *TRIP 8842', '2026-03-01', -3000, 'Uber');
    const b = addTx(db, 'UBER *TRIP 9971', '2026-07-01', -4500, 'Uber');

    learnCategoryFromTransaction(db, `fp-${a}`, catId(db, 'Viagem'));
    recategorizeAll(db);

    expect(categoryOf(db, a)).toBe('Viagem');
    expect(categoryOf(db, b)).toBe('Viagem');
  });
});

describe('a manual override still wins over the rule it created', () => {
  it('keeps one transaction pinned while the rest follow the rule', () => {
    const db = freshDb();
    const a = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-03-01');
    const b = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-01');

    learnCategoryFromTransaction(db, `fp-${a}`, catId(db, 'Compras'));
    setOverride(db, `fp-${b}`, { categoryId: catId(db, 'Viagem') });
    recategorizeAll(db);

    expect(categoryOf(db, a)).toBe('Compras');
    expect(categoryOf(db, b)).toBe('Viagem');
  });
});

describe('surviving a sync', () => {
  // Point of the whole design: rules re-run over everything, so new months arrive
  // already categorized and old months stay corrected.
  it('categorizes transactions that arrive later', () => {
    const db = freshDb();
    const first = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-09-17');
    learnCategoryFromTransaction(db, `fp-${first}`, catId(db, 'Compras'));
    recategorizeAll(db);

    const arrivedLater = addTx(db, 'EST COMERCIAL LTDA 4471', '2026-10-17');
    recategorizeAll(db);

    expect(categoryOf(db, arrivedLater)).toBe('Compras');
  });
});

describe('installment plans', () => {
  /** One purchase as the statement shows it: truncated name plus NN/NN. */
  function portoSeguro(db: DB) {
    return Array.from({ length: 10 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return addTx(db, `PORTO SEGURO CIA S${n}/10`, `2026-${String(i + 3).padStart(2, '0')}-03`, -48990, null, [i + 1, 10]);
    });
  }

  // The request: categorizing S06/10 must also settle S07/10, S08/10 and the rest.
  it('categorizes every installment of the purchase from any one of them', () => {
    const db = freshDb();
    const ids = portoSeguro(db);
    recategorizeAll(db);

    const res = learnCategoryFromTransaction(db, `fp-${ids[5]}`, catId(db, 'Carro'));
    recategorizeAll(db);

    expect(res.key).toBe('PORTO SEGURO CIA S');
    expect(res.matched).toBe(10);
    for (const id of ids) expect(categoryOf(db, id)).toBe('Carro');
  });

  it('works from the first or the last installment', () => {
    for (const pick of [0, 9]) {
      const db = freshDb();
      const ids = portoSeguro(db);
      learnCategoryFromTransaction(db, `fp-${ids[pick]}`, catId(db, 'Carro'));
      recategorizeAll(db);
      expect(ids.every((id) => categoryOf(db, id) === 'Carro')).toBe(true);
    }
  });

  // Future-dated installments already sit in the database; they must follow too.
  it('covers installments dated in a later year', () => {
    const db = freshDb();
    const now = addTx(db, 'PORTO SEGURO CIA S09/10', '2026-12-03', -48990, null, [9, 10]);
    const later = addTx(db, 'PORTO SEGURO CIA S10/10', '2027-01-03', -48990, null, [10, 10]);

    learnCategoryFromTransaction(db, `fp-${now}`, catId(db, 'Carro'));
    recategorizeAll(db);

    expect(categoryOf(db, later)).toBe('Carro');
  });

  // Rules made one-per-installment before the key ignored the marker would
  // otherwise linger and, at equal priority, match ahead of the broader rule.
  it('absorbs narrower rules made one installment at a time', () => {
    const db = freshDb();
    const ids = portoSeguro(db);

    // Simulate the old behaviour: a separate rule for three of the installments.
    for (const pick of [6, 7, 8]) {
      db.insert(rules).values({
        priority: 1, name: `PORTO SEGURO CIA S0${pick + 1}/10`, matchField: 'search_text',
        matchType: 'contains', matchValue: `PORTO SEGURO CIA S0${pick + 1}/10`,
        setCategoryId: catId(db, 'Carro'), origin: 'user',
      }).run();
    }
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(3);

    const res = learnCategoryFromTransaction(db, `fp-${ids[0]}`, catId(db, 'Carro'));
    recategorizeAll(db);

    expect(res.superseded).toHaveLength(3);
    const remaining = db.select().from(rules).where(eq(rules.origin, 'user')).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.matchValue).toBe('PORTO SEGURO CIA S');
    expect(ids.every((id) => categoryOf(db, id) === 'Carro')).toBe(true);
  });

  it('leaves unrelated user rules alone when absorbing', () => {
    const db = freshDb();
    const ids = portoSeguro(db);
    db.insert(rules).values({
      priority: 1, name: 'CARRO DEZ', matchField: 'search_text', matchType: 'contains',
      matchValue: 'CARRO DEZ CONCESSIONARIA', setCategoryId: catId(db, 'Carro'), origin: 'user',
    }).run();

    const res = learnCategoryFromTransaction(db, `fp-${ids[0]}`, catId(db, 'Carro'));

    expect(res.superseded).toHaveLength(0);
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(2);
  });

  it('creates a single rule for the whole plan', () => {
    const db = freshDb();
    const ids = portoSeguro(db);
    learnCategoryFromTransaction(db, `fp-${ids[2]}`, catId(db, 'Carro'));
    learnCategoryFromTransaction(db, `fp-${ids[7]}`, catId(db, 'Carro'));
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(1);
  });

  it('does not bleed into a different merchant that also pays in installments', () => {
    const db = freshDb();
    const porto = addTx(db, 'PORTO SEGURO CIA S03/10', '2026-05-03', -48990, null, [3, 10]);
    const latam = addTx(db, 'LATAM AIR*SORNVZ  02/04', '2026-05-10', -120000, null, [2, 4]);

    learnCategoryFromTransaction(db, `fp-${porto}`, catId(db, 'Carro'));
    recategorizeAll(db);

    expect(categoryOf(db, porto)).toBe('Carro');
    expect(categoryOf(db, latam)).toBe('Viagem'); // still the seed rule for airlines
  });

  it('leaves a one-off purchase from the same merchant matching too', () => {
    const db = freshDb();
    const plan = addTx(db, 'PORTO SEGURO CIA S02/10', '2026-04-03', -48990, null, [2, 10]);
    const single = addTx(db, 'PORTO SEGURO CIA SEGUROS', '2026-06-01', -30000);

    learnCategoryFromTransaction(db, `fp-${plan}`, catId(db, 'Carro'));
    recategorizeAll(db);

    // "PORTO SEGURO CIA S" is a prefix of both, which is the desirable outcome:
    // the same merchant keeps the same category.
    expect(categoryOf(db, single)).toBe('Carro');
  });
});

describe('a broad earlier rule must not shadow a precise later one', () => {
  /** The real case: a generic transfer rule made first, a precise one made later. */
  function withBroadRule(db: DB) {
    db.insert(rules).values({
      priority: USER_RULE_PRIORITY, name: 'TRANSFERENCIA RECEBIDA', matchField: 'search_text',
      matchType: 'contains', matchValue: 'TRANSFERENCIA RECEBIDA',
      setCategoryId: catId(db, 'Transferências internas'), origin: 'user',
    }).run();
  }

  it('lets the more specific rule win even though it was created later', () => {
    const db = freshDb();
    withBroadRule(db);
    const id = addTx(db, 'Transferência Recebida|SCHORN CONSULTORIA DE TECNOLOGIA DA INFORMACAO LTDA', '2026-09-05', 2250000);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Transferências internas'); // the broad rule, before the fix

    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'PJ'));
    recategorizeAll(db);

    expect(categoryOf(db, id)).toBe('PJ');
  });

  it('leaves the broad rule working for everything else', () => {
    const db = freshDb();
    withBroadRule(db);
    const schorn = addTx(db, 'Transferência Recebida|SCHORN CONSULTORIA DE TECNOLOGIA DA INFORMACAO LTDA', '2026-09-05', 2250000);
    const other = addTx(db, 'Transferência Recebida|FULANO DE TAL', '2026-09-06', 50000);

    learnCategoryFromTransaction(db, `fp-${schorn}`, catId(db, 'PJ'));
    recategorizeAll(db);

    expect(categoryOf(db, schorn)).toBe('PJ');
    expect(categoryOf(db, other)).toBe('Transferências internas');
  });

  it('keeps both rules rather than deleting the broad one', () => {
    const db = freshDb();
    withBroadRule(db);
    const id = addTx(db, 'Transferência Recebida|SCHORN CONSULTORIA DE TECNOLOGIA DA INFORMACAO LTDA', '2026-09-05', 2250000);
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'PJ'));
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(2);
  });
});

describe('findShadowingRule', () => {
  it('names the rule standing in the way', () => {
    const db = freshDb();
    db.insert(rules).values({
      priority: 1, name: 'Regra ampla', matchField: 'search_text', matchType: 'contains',
      matchValue: 'PADARIA', setCategoryId: catId(db, 'Restaurante'), origin: 'user',
    }).run();

    const blocker = findShadowingRule(db, 'PADARIA', catId(db, 'Mercado'));

    expect(blocker?.name).toBe('Regra ampla');
  });

  it('reports nothing when our own rule wins', () => {
    const db = freshDb();
    const id = addTx(db, 'ZZZ LOJA UNICA', '2026-09-05');
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Compras'));
    expect(findShadowingRule(db, 'ZZZ LOJA UNICA', catId(db, 'Compras'))).toBeNull();
  });

  it('flags a rule that marks the transaction as a transfer', () => {
    const db = freshDb();
    const blocker = findShadowingRule(db, 'PAGAMENTO FATURA CARTAO', catId(db, 'Compras'));
    expect(blocker).not.toBeNull();
  });
});

describe('removing and disabling rules', () => {
  it('removes a rule you created, and the transactions fall back', () => {
    const db = freshDb();
    const id = addTx(db, 'ZZZ LOJA DESCONHECIDA', '2026-09-05');
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'Compras'));
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Compras');

    const rule = db.select().from(rules).where(eq(rules.origin, 'user')).get()!;
    const res = deleteUserRule(db, rule.id);
    recategorizeAll(db);

    expect(res.ok).toBe(true);
    expect(db.select().from(rules).where(eq(rules.origin, 'user')).all()).toHaveLength(0);
    expect(categoryOf(db, id)).toBe('Outros');
  });

  // Deleting one would not stick: seedRules() re-inserts anything missing by name.
  it('refuses to delete a rule shipped with the app', () => {
    const db = freshDb();
    const seeded = db.select().from(rules).where(eq(rules.origin, 'seed')).get()!;
    const res = deleteUserRule(db, seeded.id);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/desativadas/);
    expect(db.select().from(rules).where(eq(rules.id, seeded.id)).get()).toBeDefined();
  });

  it('disables a shipped rule instead, and that does stick through re-seeding', () => {
    const db = freshDb();
    const id = addTx(db, 'IFOOD *PEDIDO', '2026-09-05');
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Restaurante');

    const delivery = db.select().from(rules).where(eq(rules.name, 'Delivery')).get()!;
    setRuleEnabled(db, delivery.id, false);
    recategorizeAll(db);
    expect(categoryOf(db, id)).not.toBe('Restaurante');

    seedRules(db); // as happens on every boot
    expect(db.select().from(rules).where(eq(rules.id, delivery.id)).get()?.enabled).toBe(false);
  });

  it('re-enables a rule', () => {
    const db = freshDb();
    const id = addTx(db, 'IFOOD *PEDIDO', '2026-09-05');
    const delivery = db.select().from(rules).where(eq(rules.name, 'Delivery')).get()!;

    setRuleEnabled(db, delivery.id, false);
    recategorizeAll(db);
    setRuleEnabled(db, delivery.id, true);
    recategorizeAll(db);

    expect(categoryOf(db, id)).toBe('Restaurante');
  });

  it('reports a rule that does not exist rather than failing silently', () => {
    const db = freshDb();
    expect(deleteUserRule(db, 99999).ok).toBe(false);
    expect(setRuleEnabled(db, 99999, false).ok).toBe(false);
  });

  it('measures how many transactions a change moves', () => {
    const db = freshDb();
    const a = addTx(db, 'ZZZ LOJA DESCONHECIDA', '2026-03-05');
    const b = addTx(db, 'ZZZ LOJA DESCONHECIDA', '2026-09-05');
    learnCategoryFromTransaction(db, `fp-${a}`, catId(db, 'Compras'));
    recategorizeAll(db);

    const before = categorySnapshot(db);
    const rule = db.select().from(rules).where(eq(rules.origin, 'user')).get()!;
    deleteUserRule(db, rule.id);
    recategorizeAll(db);

    expect(countMoved(before, categorySnapshot(db))).toBe(2);
    expect(categoryOf(db, b)).toBe('Outros');
  });

  // Removing a specific rule should expose whatever was underneath it.
  it('falls back to the broader rule that was being shadowed', () => {
    const db = freshDb();
    db.insert(rules).values({
      priority: USER_RULE_PRIORITY, name: 'TRANSFERENCIA RECEBIDA', matchField: 'search_text',
      matchType: 'contains', matchValue: 'TRANSFERENCIA RECEBIDA',
      setCategoryId: catId(db, 'Transferências internas'), origin: 'user',
    }).run();
    const id = addTx(db, 'Transferência Recebida|SCHORN CONSULTORIA DE TECNOLOGIA', '2026-09-05', 2250000);
    learnCategoryFromTransaction(db, `fp-${id}`, catId(db, 'PJ'));
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('PJ');

    const specific = db.select().from(rules)
      .where(and(eq(rules.origin, 'user'), eq(rules.matchValue, 'TRANSFERENCIA RECEBIDA|SCHORN CONSULTORIA DE TECNOLOGIA'))).get()!;
    deleteUserRule(db, specific.id);
    recategorizeAll(db);

    expect(categoryOf(db, id)).toBe('Transferências internas');
  });
});
