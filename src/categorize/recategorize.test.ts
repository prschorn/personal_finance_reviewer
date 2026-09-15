import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { categories, transactions, accounts, items } from '../db/schema';
import { seedRules, SEED_RULES } from './seed-rules';
import { recategorizeAll, setOverride, clearOverride } from './recategorize';
import { buildSearchText } from '../lib/text';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  seedRules(db);
  db.insert(items).values({ id: 'item-1' }).run();
  db.insert(accounts).values({ id: 'acc-bank', itemId: 'item-1', type: 'BANK' }).run();
  db.insert(accounts).values({ id: 'acc-card', itemId: 'item-1', type: 'CREDIT' }).run();
  return db;
}

let n = 0;
function addTx(db: DB, description: string, signedCents: number, accountId = 'acc-bank') {
  const id = `tx-${++n}`;
  db.insert(transactions)
    .values({
      id, accountId, fingerprint: `fp-${id}`,
      dateUtc: '2026-03-10T00:00:00.000Z', postedOn: '2026-03-10',
      description, searchText: buildSearchText({ description }),
      amountCents: Math.abs(signedCents), signedCents,
      status: 'POSTED', firstSeenAt: 'now', lastSeenRunId: 1, rawJson: '{}',
    })
    .run();
  return id;
}

function categoryOf(db: DB, id: string): string | null {
  const row = db
    .select({ name: categories.name })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.id, id))
    .get();
  return row?.name ?? null;
}

function rowOf(db: DB, id: string) {
  return db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

describe('seedRules', () => {
  it('inserts every rule and resolves its category', () => {
    const db = freshDb();
    const res = seedRules(db); // second call: idempotent
    expect(res.inserted).toBe(0);
    expect(res.skippedUnknownCategory).toEqual([]);
  });

  it('references only categories that exist', () => {
    const db = freshDb();
    const names = new Set(db.select().from(categories).all().map((c) => c.name));
    const missing = SEED_RULES.filter((r) => r.category && !names.has(r.category));
    expect(missing).toEqual([]);
  });
});

describe('rule categorization', () => {
  const cases: [string, string][] = [
    ['IFOOD *RESTAURANTE JAPA', 'Restaurante'],
    ['PAO DE ACUCAR 1234', 'Mercado'],
    ['DROGASIL 456', 'Farmácia'],
    ['POSTO SHELL CENTRO', 'Carro'],
    ['UBER *TRIP', 'Carro'],
    ['CONDOMINIO EDIFICIO X', 'Condomínio'],
    ['ENEL SP', 'Luz'],
    ['VIVO FIXO', 'Celular'],
    ['UNIMED SEGUROS', 'Unimed'],
    ['AMAZON BR', 'Compras'],
    ['NETFLIX.COM', 'Compras'],
    ['AIRBNB * HOSPEDAGEM', 'Viagem'],
    ['LATAM AIRLINES', 'Viagem'],
    ['DARF NUMERADO', 'DARF'],
    ['IPTU SAO PAULO', 'IPTU'],
    ['TARIFA MENSALIDADE', 'Taxas'],
    ['SAQUE 24H BANCO', 'Dinheiro'],
    ['OFICINA DO ZE', 'Manutenção'],
    ['STARBUCKS COFFEE', 'Restaurante'],
    ['PSIQUIATRA DR SILVA', 'Psiquiatra'],
  ];

  it.each(cases)('files %s under %s', (description, expected) => {
    const db = freshDb();
    const id = addTx(db, description, -5000);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe(expected);
  });

  // The ordering trap: "MERCADO LIVRE" contains "MERCADO".
  it('files Mercado Livre as Compras, not groceries', () => {
    const db = freshDb();
    const ml = addTx(db, 'MERCADO LIVRE *PEDIDO', -5000);
    const sup = addTx(db, 'SUPERMERCADO BOM PRECO', -5000);
    recategorizeAll(db);
    expect(categoryOf(db, ml)).toBe('Compras');
    expect(categoryOf(db, sup)).toBe('Mercado');
  });

  // Regression: a trailing \\b after a word STEM silently breaks every inflected
  // form (PSIQUIATR vs "PSIQUIATRA", MARMITA vs "MARMITAS", MECANIC vs "MECANICA").
  const inflected: [string, string | null][] = [
    ['PSIQUIATRA DR SILVA', 'Psiquiatra'],
    ['PSICOLOGA ANA', 'Psiquiatra'],
    ['MARMITAS DA CASA', 'Marmitas'],
    ['MECANICA DO JOAO', 'Manutenção'],
    ['TARIFAS BANCARIAS', 'Taxas'],
    ['CAFES SELECIONADOS', 'Restaurante'],
    ['DROGARIAS PACHECO', 'Farmácia'],
    ['CLINICAS INTEGRADAS', 'Saúde'],
    ['APLICACOES FINANCEIRAS', null],
    ['POSTOS BR', 'Carro'],
  ];

  it.each(inflected)('matches the inflected form %s', (description, expected) => {
    const db = freshDb();
    const id = addTx(db, description, -5000);
    recategorizeAll(db);
    if (expected === null) {
      expect(rowOf(db, id).isInternal).toBe(true); // internal, so no spending category
    } else {
      expect(categoryOf(db, id)).toBe(expected);
    }
  });

  it('matches regardless of accents and case', () => {
    const db = freshDb();
    const id = addTx(db, 'Farmácia São João', -5000);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Farmácia');
  });
});

describe('internal movements', () => {
  it('excludes a card bill payment from the bank side', () => {
    const db = freshDb();
    const id = addTx(db, 'PAGAMENTO FATURA CARTAO', -120000);
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(true);
    expect(rowOf(db, id).internalReason).toBe('rule');
  });

  // Mandatory: left in, this silently cancels out a month of card spending.
  it('excludes the credit entry on the card side', () => {
    const db = freshDb();
    const id = addTx(db, 'PAGAMENTO RECEBIDO', 120000, 'acc-card');
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(true);
  });

  it('excludes investment moves', () => {
    const db = freshDb();
    const ap = addTx(db, 'APLICACAO AUTOMATICA', -100000);
    const rg = addTx(db, 'RESGATE CDB', 100000);
    recategorizeAll(db);
    expect(rowOf(db, ap).isInternal).toBe(true);
    expect(rowOf(db, rg).isInternal).toBe(true);
  });

  // ATM withdrawals are real spending, not a movement between your own pockets.
  it('treats a cash withdrawal as spending', () => {
    const db = freshDb();
    const id = addTx(db, 'SAQUE BANCO 24H', -20000);
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(false);
    expect(categoryOf(db, id)).toBe('Dinheiro');
  });
});

describe('defaults', () => {
  it('sends unmatched spending to Outros and flags it as uncategorized', () => {
    const db = freshDb();
    const id = addTx(db, 'ESTABELECIMENTO DESCONHECIDO XYZ', -3000);
    const stats = recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Outros');
    expect(rowOf(db, id).categorySource).toBe('default');
    expect(stats.uncategorized).toBe(1);
  });

  it('sends unmatched income to Receitas', () => {
    const db = freshDb();
    const id = addTx(db, 'TED RECEBIDA EMPRESA LTDA', 800000);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Receitas');
  });
});

describe('manual overrides', () => {
  it('beat the rules and survive a re-run', () => {
    const db = freshDb();
    const id = addTx(db, 'PAO DE ACUCAR 1234', -5000);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Mercado');

    const restauranteId = db.select().from(categories).where(eq(categories.name, 'Restaurante')).get()!.id;
    setOverride(db, rowOf(db, id).fingerprint, { categoryId: restauranteId });
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Restaurante');
    expect(rowOf(db, id).categorySource).toBe('manual');

    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Restaurante');
  });

  it('can rescue a transaction wrongly excluded as a transfer', () => {
    const db = freshDb();
    const id = addTx(db, 'PAGAMENTO FATURA CARTAO', -120000);
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(true);

    setOverride(db, rowOf(db, id).fingerprint, { isInternal: false });
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(false);
  });

  it('reverts to rules once cleared', () => {
    const db = freshDb();
    const id = addTx(db, 'PAO DE ACUCAR 1234', -5000);
    const restauranteId = db.select().from(categories).where(eq(categories.name, 'Restaurante')).get()!.id;
    setOverride(db, `fp-${id}`, { categoryId: restauranteId });
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Restaurante');

    clearOverride(db, `fp-${id}`);
    recategorizeAll(db);
    expect(categoryOf(db, id)).toBe('Mercado');
  });

  it('merges a partial patch instead of wiping the other field', () => {
    const db = freshDb();
    const id = addTx(db, 'ALGO', -1000);
    setOverride(db, `fp-${id}`, { categoryId: 5, note: 'anotação' });
    setOverride(db, `fp-${id}`, { isInternal: true });
    recategorizeAll(db);
    expect(rowOf(db, id).isInternal).toBe(true);
    expect(rowOf(db, id).categoryId).toBe(5);
  });
});

describe('idempotency', () => {
  it('reports no changes on a second pass', () => {
    const db = freshDb();
    addTx(db, 'IFOOD *X', -5000);
    addTx(db, 'PAO DE ACUCAR', -9000);
    addTx(db, 'DESCONHECIDO', -100);
    recategorizeAll(db);
    expect(recategorizeAll(db).changed).toBe(0);
  });

  it('counts every row exactly once across sources', () => {
    const db = freshDb();
    addTx(db, 'IFOOD *X', -5000);
    addTx(db, 'DESCONHECIDO', -100);
    const stats = recategorizeAll(db);
    expect(stats.scanned).toBe(2);
    expect(Object.values(stats.bySource).reduce((a, b) => a + b, 0)).toBe(2);
  });
});
