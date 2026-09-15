import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { freshDb as makeDb, addTx as insertTx, catId } from '../db/testing';
import { transactions } from '../db/schema';
import { learnCategoryFromTransaction } from '../categorize/learn';
import { recategorizeAll } from '../categorize/recategorize';
import { setLastReviewedAt } from '../config/settings';
import { getOutliers, getReviewQueue, MAX_ITEMS } from './review';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const SINCE = '2026-09-01T00:00:00.000Z';
const NEW = '2026-09-10T00:00:00.000Z';
const OLD = '2026-05-01T00:00:00.000Z';

function freshDb(): DB {
  return makeDb({ accounts: [{ id: 'conta', type: 'BANK', name: 'Conta' }] });
}

function addTx(
  db: DB,
  o: {
    description: string;
    signedCents: number;
    postedOn?: string;
    firstSeenAt?: string;
    categorySource?: string;
    category?: string;
    pluggyCategory?: string;
    fingerprint?: string;
    installments?: [number, number];
  },
) {
  return insertTx(db, {
    accountId: 'conta',
    postedOn: '2026-09-10',
    firstSeenAt: NEW,
    category: o.category ?? 'Outros',
    ...o,
  });
}

/** A merchant with a settled history of small charges. */
function withHistory(db: DB, description: string, cents: number, times = 4) {
  for (let i = 0; i < times; i++) {
    addTx(db, { description, signedCents: -cents, postedOn: `2026-0${i + 1}-10`, firstSeenAt: OLD });
  }
}

describe('getOutliers', () => {
  it('flags a charge far above anything ever spent at that merchant', () => {
    const db = freshDb();
    withHistory(db, 'POSTO SHELL', 20000);
    addTx(db, { description: 'POSTO SHELL', signedCents: -90000 });

    const [out] = getOutliers(db, { since: SINCE });

    expect(out!.cents).toBe(90000);
    expect(out!.previousMaxCents).toBe(20000);
    expect(out!.ratio).toBeCloseTo(4.5, 5);
  });

  it('leaves a charge only a little above the usual alone', () => {
    const db = freshDb();
    withHistory(db, 'POSTO SHELL', 20000);
    addTx(db, { description: 'POSTO SHELL', signedCents: -40000 }); // exactly 2x, under 2.5

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });

  // One previous visit is not a history; it would make any second, larger visit
  // an anomaly.
  it('needs several previous charges before it will call one unusual', () => {
    const db = freshDb();
    addTx(db, { description: 'LOJA NOVA', signedCents: -1000, postedOn: '2026-01-10', firstSeenAt: OLD });
    addTx(db, { description: 'LOJA NOVA', signedCents: -90000 });

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });

  // A R$ 4 coffee becoming R$ 12 is a ratio of 3 and means nothing.
  it('ignores small amounts however large the multiple', () => {
    const db = freshDb();
    withHistory(db, 'CAFETERIA', 400);
    addTx(db, { description: 'CAFETERIA', signedCents: -4000 });

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });

  it('only looks at rows that arrived since the watermark', () => {
    const db = freshDb();
    withHistory(db, 'POSTO SHELL', 20000);
    addTx(db, { description: 'POSTO SHELL', signedCents: -90000, firstSeenAt: OLD });

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });

  // The first installment of a plan is smaller than the purchase, not bigger.
  it('leaves installment rows out', () => {
    const db = freshDb();
    withHistory(db, 'LOJA MOVEIS', 20000);
    addTx(db, { description: 'LOJA MOVEIS', signedCents: -90000, installments: [1, 10] });

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });

  it('ignores money coming in', () => {
    const db = freshDb();
    withHistory(db, 'ALGUEM', 20000);
    addTx(db, { description: 'ALGUEM', signedCents: 90000 });

    expect(getOutliers(db, { since: SINCE })).toEqual([]);
  });
});

describe('getReviewQueue', () => {
  it('says nothing is new when nothing is', () => {
    const db = freshDb();
    setLastReviewedAt(db, NOW.toISOString());
    addTx(db, { description: 'QUALQUER', signedCents: -100, firstSeenAt: OLD });

    const queue = getReviewQueue(db, NOW);

    expect(queue.items).toEqual([]);
    expect(queue.total).toBe(0);
  });

  it('falls back to a bounded window before anything has been reviewed', () => {
    const db = freshDb();
    const queue = getReviewQueue(db, NOW);
    // 14 days back, so a first open shows a recent window rather than all history.
    expect(queue.since).toBe('2026-09-01');
  });

  // 'default' means no rule matched; 'pluggy' means a rule of yours did not decide
  // it either — the bank's own guess did. Both are guesses, and they read differently.
  it('collects rows the app guessed at, labelling how it guessed', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'SEM REGRA NENHUMA', signedCents: -5000, categorySource: 'default' });
    addTx(db, { description: 'VEIO DA PLUGGY', signedCents: -6000, categorySource: 'pluggy' });
    addTx(db, { description: 'REGRA SUA', signedCents: -7000, categorySource: 'rule' });

    const guesses = getReviewQueue(db, NOW).items.filter((i) => i.kind === 'sem-categoria');

    expect(guesses).toHaveLength(2);
    expect(guesses[0]!.detail).toContain('nenhuma regra');
    expect(guesses[1]!.detail).toContain('Pluggy');
  });

  // The confirm control needs the category's NAME, not just its id: it reads
  // "Confirmar Mercado", and a <select> fires no change event when you pick the
  // option already selected, so confirming has to be its own button.
  it('carries the guessed category name, whoever guessed it', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'PALPITE DO APP', signedCents: -5000, categorySource: 'default', category: 'Outros' });
    addTx(db, { description: 'PALPITE DA PLUGGY', signedCents: -6000, categorySource: 'pluggy', category: 'Mercado' });

    const guesses = getReviewQueue(db, NOW).items.filter((i) => i.kind === 'sem-categoria');

    expect(guesses.map((g) => g.categoryName)).toEqual(['Outros', 'Mercado']);
    expect(guesses.every((g) => g.categoryId !== null)).toBe(true);
  });

  it('leaves the category name off items that are not about a category', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });

    expect(getReviewQueue(db, NOW).items[0]!.categoryName).toBeNull();
  });

  it('flags two identical charges on the same day', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });

    const duplicates = getReviewQueue(db, NOW).items.filter((i) => i.kind === 'duplicata');

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.cents).toBe(12300);
  });

  // A wrong total outranks a wrong label, which outranks a trend.
  it('puts integrity problems above classification ones', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'ALGO SEM REGRA', signedCents: -5000, categorySource: 'default' });
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });
    addTx(db, { description: 'COBRANCA DOBRADA', signedCents: -12300, fingerprint: 'fp-dobrada' });

    expect(getReviewQueue(db, NOW).items[0]!.kind).toBe('duplicata');
  });

  it('counts every kind it found', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'UM', signedCents: -5000, categorySource: 'default' });
    addTx(db, { description: 'DOIS', signedCents: -5000, categorySource: 'pluggy' });

    expect(getReviewQueue(db, NOW).counts['sem-categoria']).toBe(2);
  });

  it('caps a very long queue and says it did', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    for (let i = 0; i < MAX_ITEMS + 10; i++) {
      addTx(db, { description: `LANCAMENTO ${i}`, signedCents: -100 - i, categorySource: 'default' });
    }

    const queue = getReviewQueue(db, NOW);

    expect(queue.items).toHaveLength(MAX_ITEMS);
    expect(queue.total).toBe(MAX_ITEMS + 10);
    expect(queue.truncated).toBe(true);
  });

  it('hands a fingerprint through so a row can be recategorized in place', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'SEM REGRA', signedCents: -5000, categorySource: 'default', fingerprint: 'fp-x' });

    expect(getReviewQueue(db, NOW).items[0]!.fingerprint).toBe('fp-x');
  });
});

describe('series-level items are news, not a permanent list', () => {
  /** A fixed-price series that rose in `changeMonth` and held. */
  function withPriceRise(db: DB, changeMonth: string) {
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
      '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    for (const m of months) {
      addTx(db, {
        description: 'ASSINATURA FIXA',
        signedCents: m >= changeMonth ? -1000 : -500,
        postedOn: `${m}-05`,
        firstSeenAt: OLD,
      });
    }
  }

  it('reports a price change that happened recently', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    withPriceRise(db, '2026-08');

    expect(getReviewQueue(db, NOW).items.filter((i) => i.kind === 'preco-mudou')).toHaveLength(1);
  });

  // Otherwise a rise from last November reappears every single time the queue is
  // cleared, and a queue that never empties stops being read.
  it('drops a price change old enough to have been seen already', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    withPriceRise(db, '2025-12');

    expect(getReviewQueue(db, NOW).items.filter((i) => i.kind === 'preco-mudou')).toEqual([]);
  });

  it('reports a series in the months just after it stopped', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    for (const m of ['2026-04', '2026-05', '2026-06', '2026-07']) {
      addTx(db, { description: 'PAROU AGORA', signedCents: -3000, postedOn: `${m}-05`, firstSeenAt: OLD });
    }

    expect(getReviewQueue(db, NOW).items.filter((i) => i.kind === 'serie-parou')).toHaveLength(1);
  });

  it('stops reporting a series that has been gone for months', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    for (const m of ['2025-10', '2025-11', '2025-12', '2026-01']) {
      addTx(db, { description: 'PAROU HA MUITO', signedCents: -3000, postedOn: `${m}-05`, firstSeenAt: OLD });
    }

    expect(getReviewQueue(db, NOW).items.filter((i) => i.kind === 'serie-parou')).toEqual([]);
  });
});

describe('confirming a guess', () => {
  // The whole point of the Confirmar button. resolve() consults rules BEFORE the
  // Pluggy hint, so learning one creates a decision that outranks the guess — but
  // that precedence is invisible from the UI, and if it ever flipped the button
  // would appear to do nothing.
  it('turns the guess into a rule that outranks Pluggy, for every matching row', () => {
    const db = freshDb();
    // Pluggy really does label these, so resolve() has a hint to lose to.
    addTx(db, { description: 'PADARIA IPIRANGA', signedCents: -1200, pluggyCategory: 'Groceries' });
    addTx(db, { description: 'PADARIA IPIRANGA', signedCents: -3400, pluggyCategory: 'Groceries' });
    recategorizeAll(db);
    const guessed = db.select().from(transactions).all();
    expect(guessed.every((t) => t.categorySource === 'pluggy')).toBe(true);
    expect(guessed.every((t) => t.categoryId === catId(db, 'Mercado'))).toBe(true);

    const restaurante = catId(db, 'Restaurante');
    const learned = learnCategoryFromTransaction(db, guessed[0]!.fingerprint, restaurante);
    recategorizeAll(db);

    expect(learned.ok).toBe(true);
    const after = db.select().from(transactions).all();
    // Both rows moved, and the source says a decision made them move.
    expect(after.map((t) => t.categoryId)).toEqual([restaurante, restaurante]);
    expect(after.every((t) => t.categorySource === 'rule')).toBe(true);
  });

  it('drops those rows out of the queue once confirmed', () => {
    const db = freshDb();
    setLastReviewedAt(db, SINCE);
    addTx(db, { description: 'PADARIA IPIRANGA', signedCents: -1200, pluggyCategory: 'Groceries' });
    recategorizeAll(db);
    expect(getReviewQueue(db, NOW).counts['sem-categoria']).toBe(1);

    const target = db.select().from(transactions).all()[0]!;
    learnCategoryFromTransaction(db, target.fingerprint, catId(db, 'Restaurante'));
    recategorizeAll(db);

    expect(getReviewQueue(db, NOW).counts['sem-categoria']).toBe(0);
  });
});
