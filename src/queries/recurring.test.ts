import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { freshDb as makeDb, addTx as insertTx } from '../db/testing';
import { addMonths } from '../lib/date';
import {
  buildRecurring,
  seriesLabel,
  getRecurring,
  getSeriesTransactions,
  type CandidateRow,
} from './recurring';

const AS_OF = '2026-09';

function occ(over: Partial<CandidateRow> & { month: string }): CandidateRow {
  return {
    key: '1PASSWORD',
    postedOn: `${over.month}-05`,
    cents: 399,
    fingerprint: `fp-${over.month}`,
    description: '1PASSWORD',
    merchantName: null,
    categoryId: null,
    categoryName: null,
    accountName: 'Black',
    direction: 'saida',
    ...over,
  };
}

/** A charge landing once a month, same amount, across the given months. */
function monthly(months: string[], over: Partial<CandidateRow> = {}) {
  return months.map((month) => occ({ month, ...over }));
}

describe('buildRecurring', () => {
  it('reports nothing for no rows', () => {
    const report = buildRecurring([], AS_OF);
    expect(report.outgoing).toEqual([]);
    expect(report.incoming).toEqual([]);
    expect(report.monthlyTotalCents).toBe(0);
  });

  it('detects a charge that lands once a month', () => {
    const report = buildRecurring(monthly(['2026-06', '2026-07', '2026-08', '2026-09']), AS_OF);

    expect(report.outgoing).toHaveLength(1);
    const s = report.outgoing[0]!;
    expect(s.key).toBe('1PASSWORD');
    expect(s.status).toBe('ativa');
    expect(s.kind).toBe('fixo');
    expect(s.typicalCents).toBe(399);
    expect(s.activeMonths).toBe(4);
    expect(s.annualCents).toBe(399 * 12);
  });

  // matchKeyFor prefers merchantName, which is coarse: one live merchant groups 125
  // charges across 10 months with perfect cadence. Without this gate every
  // restaurant, supermarket and petrol station reads as a subscription.
  it('rejects a merchant visited many times a month, however regular it looks', () => {
    const rows = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].flatMap((month) =>
      Array.from({ length: 12 }, (_, i) =>
        occ({ key: 'UBER', month, cents: 1500 + i, fingerprint: `fp-${month}-${i}` }),
      ),
    );

    expect(buildRecurring(rows, AS_OF).outgoing).toEqual([]);
  });

  it('tolerates a single double-billed month', () => {
    const rows = [
      ...monthly(['2026-06', '2026-07', '2026-09']),
      occ({ month: '2026-08' }),
      occ({ month: '2026-08', fingerprint: 'fp-dup' }),
    ];

    expect(buildRecurring(rows, AS_OF).outgoing).toHaveLength(1);
  });

  it('needs three months before it will call anything recurring', () => {
    const report = buildRecurring(monthly(['2026-05', '2026-06']), AS_OF);
    expect(report.outgoing).toEqual([]);
  });

  it('keeps a subscription that skipped a few months', () => {
    // 9 active over a 12-month span = 0.75
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const [s] = buildRecurring(monthly(months), AS_OF).outgoing;
    expect(s!.coverage).toBeCloseTo(0.75, 2);
    expect(s!.status).toBe('ativa');
  });

  it('rejects a charge that only appears once a quarter', () => {
    const months = ['2026-03', '2026-06', '2026-09'];
    expect(buildRecurring(monthly(months), AS_OF).outgoing).toEqual([]);
  });

  it('records the day of the month it usually lands on', () => {
    const rows = [
      occ({ month: '2026-07', postedOn: '2026-07-31' }),
      occ({ month: '2026-08', postedOn: '2026-08-31' }),
      occ({ month: '2026-09', postedOn: '2026-09-30' }),
    ];
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.expectedDay).toBe(31);
  });
});

describe('fixed versus variable', () => {
  // A password manager and an electricity bill are both recurring, but presenting
  // them identically is a lie: only one of them has a "price".
  it('calls a charge that barely moves fixed', () => {
    const rows = ['2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: 399 + i }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.kind).toBe('fixo');
  });

  it('calls a bill that swings widely variable', () => {
    const cents = [19000, 31000, 53700, 24000];
    const rows = ['2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ key: 'RGE SUL', month, cents: cents[i]! }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.kind).toBe('variavel');
  });

  it('does not claim a price change on a variable bill', () => {
    const cents = [19000, 31000, 24000, 53700];
    const rows = ['2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ key: 'RGE SUL', month, cents: cents[i]! }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.priceChange).toBeNull();
  });
});

describe('price changes', () => {
  it('reports a rise that stuck', () => {
    const cents = [399, 399, 499, 499, 499];
    const rows = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );

    expect(buildRecurring(rows, AS_OF).outgoing[0]!.priceChange).toEqual({
      fromCents: 399,
      toCents: 499,
      sinceMonth: '2026-07',
      deltaShare: (499 - 399) / 399,
    });
  });

  // Once a price has changed and stuck, the old months are history. Annualizing a
  // median that still contains them projects a bill you will never receive again.
  it('prices the series at the level it sits at now, not the median of its history', () => {
    const cents = [399, 399, 399, 499, 499];
    const rows = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );

    const [s] = buildRecurring(rows, AS_OF).outgoing;

    expect(s!.typicalCents).toBe(499);
    expect(s!.annualCents).toBe(499 * 12);
  });

  it('reports a fall', () => {
    const cents = [499, 499, 399, 399];
    const rows = ['2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.priceChange!.toCents).toBe(399);
  });

  // A double charge or a refund month is not a price change, and saying so would
  // train you to ignore the signal.
  it('ignores a one-month blip that went back', () => {
    const cents = [399, 399, 798, 399, 399];
    const rows = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.priceChange).toBeNull();
  });

  it('ignores rounding-sized drift', () => {
    const cents = [399, 400, 401, 400];
    const rows = ['2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );
    expect(buildRecurring(rows, AS_OF).outgoing[0]!.priceChange).toBeNull();
  });

  it('reports the most recent change when there have been several', () => {
    const cents = [299, 299, 399, 399, 499, 499];
    const rows = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) =>
      occ({ month, cents: cents[i]! }),
    );
    const change = buildRecurring(rows, AS_OF).outgoing[0]!.priceChange!;
    expect([change.fromCents, change.toCents, change.sinceMonth]).toEqual([399, 499, '2026-08']);
  });
});

describe('status', () => {
  // A charge that normally lands on the 31st simply has not happened yet on the
  // 15th. Claiming "stopped" after one missing month would cry wolf every month.
  it('still calls a series active after one missing month', () => {
    const [s] = buildRecurring(monthly(['2026-05', '2026-06', '2026-07', '2026-08']), AS_OF).outgoing;
    expect(s!.status).toBe('ativa');
  });

  it('calls a series stopped after a whole month with nothing', () => {
    const [s] = buildRecurring(monthly(['2026-04', '2026-05', '2026-06', '2026-07']), AS_OF).outgoing;
    expect(s!.status).toBe('parada');
  });

  // Something two months old cannot reach three occurrences, so it needs its own
  // gate — otherwise the page is useless until you have used it for a quarter.
  it('flags a two-month-old series as new', () => {
    const [s] = buildRecurring(monthly(['2026-08', '2026-09']), AS_OF).outgoing;
    expect(s!.status).toBe('nova');
    expect(s!.activeMonths).toBe(2);
  });

  it('does not call an old two-occurrence series new', () => {
    expect(buildRecurring(monthly(['2026-02', '2026-03']), AS_OF).outgoing).toEqual([]);
  });

  // A mortgage and a restaurant you happen to visit monthly are both "recurring",
  // but only one of them is a commitment with a price. Adding them into one
  // "per month" figure would make that number mean nothing.
  it('totals what has a price separately from what merely repeats', () => {
    const report = buildRecurring(
      [
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'ASSINATURA', cents: 1000 }),
        ...['2026-07', '2026-08', '2026-09'].map((month, i) =>
          occ({ key: 'RESTAURANTE', month, cents: [8000, 14500, 11000][i]! }),
        ),
      ],
      AS_OF,
    );

    expect(report.monthlyTotalCents).toBe(1000);
    expect(report.annualTotalCents).toBe(12000);
    expect(report.variableMonthlyCents).toBe(11000);
  });

  it('leaves stopped series out of the monthly total', () => {
    const report = buildRecurring(
      [
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'ATIVA', cents: 1000 }),
        ...monthly(['2026-04', '2026-05', '2026-06'], { key: 'PARADA', cents: 5000 }),
      ],
      AS_OF,
    );
    expect(report.monthlyTotalCents).toBe(1000);
    expect(report.annualTotalCents).toBe(12000);
  });
});

describe('shape of the report', () => {
  it('keeps income in its own list', () => {
    const report = buildRecurring(
      [
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'ASSINATURA', cents: 1000 }),
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'SALARIO', cents: 900000, direction: 'entrada' }),
      ],
      AS_OF,
    );

    expect(report.outgoing.map((s) => s.key)).toEqual(['ASSINATURA']);
    expect(report.incoming.map((s) => s.key)).toEqual(['SALARIO']);
    // The yearly total is about what leaves, so income must not inflate it.
    expect(report.annualTotalCents).toBe(12000);
  });

  it('puts the most expensive series first, by the yearly figure', () => {
    const report = buildRecurring(
      [
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'PEQUENA', cents: 1000 }),
        ...monthly(['2026-07', '2026-08', '2026-09'], { key: 'GRANDE', cents: 90000 }),
      ],
      AS_OF,
    );
    expect(report.outgoing.map((s) => s.key)).toEqual(['GRANDE', 'PEQUENA']);
  });

  it('carries the count of rows it could not group', () => {
    expect(buildRecurring([], AS_OF, 17).ungroupableCount).toBe(17);
  });

  it('hands the latest fingerprint through, so a series can be recategorized in place', () => {
    const [s] = buildRecurring(monthly(['2026-07', '2026-08', '2026-09']), AS_OF).outgoing;
    expect(s!.latestFingerprint).toBe('fp-2026-09');
  });
});

describe('seriesLabel', () => {
  it('prefers the merchant name', () => {
    const rows = [occ({ month: '2026-09', merchantName: 'Uber do Brasil', description: 'UBER *TRIP 8sh2' })];
    expect(seriesLabel(rows)).toBe('Uber do Brasil');
  });

  it('takes the most common merchant name when they differ', () => {
    const rows = [
      occ({ month: '2026-07', merchantName: 'Netflix' }),
      occ({ month: '2026-08', merchantName: 'Netflix' }),
      occ({ month: '2026-09', merchantName: 'NETFLIX.COM' }),
    ];
    expect(seriesLabel(rows)).toBe('Netflix');
  });

  // The statement truncates, so the longest description is the least truncated one.
  it('falls back to the longest description', () => {
    const rows = [
      occ({ month: '2026-08', description: 'PORTO SEGURO CI' }),
      occ({ month: '2026-09', description: 'PORTO SEGURO CIA SEGUROS' }),
    ];
    expect(seriesLabel(rows)).toBe('PORTO SEGURO CIA SEGUROS');
  });

  it('strips the installment marker off the label', () => {
    const rows = [occ({ month: '2026-09', description: 'PORTO SEGURO CIA S01/10' })];
    expect(seriesLabel(rows)).toBe('PORTO SEGURO CIA S');
  });

  it('falls back to the key when there is nothing else', () => {
    const rows = [occ({ month: '2026-09', description: null, merchantName: null })];
    expect(seriesLabel(rows)).toBe('1PASSWORD');
  });
});

// --- DB-backed ---------------------------------------------------------------

const NOW = new Date('2026-09-15T12:00:00.000Z');

function freshDb(): DB {
  return makeDb({
    accounts: [
      { id: 'conta', type: 'BANK', name: 'Conta' },
      { id: 'card', type: 'CREDIT', name: 'Black' },
    ],
  });
}

function addTx(
  db: DB,
  o: {
    postedOn: string;
    description: string;
    signedCents?: number;
    accountId?: string;
    installments?: [number, number];
    isInternal?: boolean;
    deleted?: boolean;
    category?: string;
  },
) {
  return insertTx(db, { accountId: 'card', signedCents: -399, ...o });
}

function months(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(from, i));
}

describe('getRecurring', () => {
  it('finds a monthly subscription in real rows', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) addTx(db, { postedOn: `${m}-05`, description: '1PASSWORD' });

    const report = getRecurring(db, NOW);

    expect(report.outgoing).toHaveLength(1);
    expect(report.outgoing[0]!.label).toBe('1PASSWORD');
    expect(report.outgoing[0]!.typicalCents).toBe(399);
  });

  // An installment plan has perfect cadence and near-identical amounts. It is a
  // finite purchase, and Hoje already accounts for it — counting it here would
  // report a car as a subscription.
  it('leaves installment plans out', () => {
    const db = freshDb();
    months('2026-05', 5).forEach((m, i) =>
      addTx(db, { postedOn: `${m}-03`, description: 'PORTO SEGURO CIA S', installments: [i + 1, 10] }),
    );

    expect(getRecurring(db, NOW).outgoing).toEqual([]);
  });

  it('ignores internal movements and deleted rows', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) {
      addTx(db, { postedOn: `${m}-05`, description: 'TRANSFERENCIA PROPRIA', isInternal: true });
      addTx(db, { postedOn: `${m}-06`, description: 'ASSINATURA MORTA', deleted: true });
    }

    expect(getRecurring(db, NOW).outgoing).toEqual([]);
  });

  it('splits income into its own list', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) {
      addTx(db, { postedOn: `${m}-05`, description: 'ASSINATURA NUVEM' });
      addTx(db, { postedOn: `${m}-01`, description: 'SALARIO MENSAL', signedCents: 900000, accountId: 'conta' });
    }

    const report = getRecurring(db, NOW);

    expect(report.outgoing.map((s) => s.label)).toEqual(['ASSINATURA NUVEM']);
    expect(report.incoming.map((s) => s.label)).toEqual(['SALARIO MENSAL']);
  });

  it('carries the current category through, so it can be corrected in place', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) {
      addTx(db, { postedOn: `${m}-05`, description: '1PASSWORD', category: 'Compras' });
    }

    expect(getRecurring(db, NOW).outgoing[0]!.categoryName).toBe('Compras');
  });

  // Never invent a key for a description too short to group: say how many.
  it('counts the rows it could not group instead of guessing', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) addTx(db, { postedOn: `${m}-05`, description: 'OI' });

    const report = getRecurring(db, NOW);

    expect(report.outgoing).toEqual([]);
    expect(report.ungroupableCount).toBe(4);
  });

  it('looks no further back than its window', () => {
    const db = freshDb();
    for (const m of months('2024-01', 4)) addTx(db, { postedOn: `${m}-05`, description: 'ANTIGA' });

    expect(getRecurring(db, NOW).outgoing).toEqual([]);
  });
});

describe('getSeriesTransactions', () => {
  it('returns the rows behind one series, newest last', () => {
    const db = freshDb();
    for (const m of months('2026-06', 4)) addTx(db, { postedOn: `${m}-05`, description: '1PASSWORD' });
    addTx(db, { postedOn: '2026-07-05', description: 'OUTRA COISA QUALQUER' });

    const rows = getSeriesTransactions(db, { key: '1PASSWORD' }, NOW);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.cents)).toEqual([399, 399, 399, 399]);
    expect(rows.at(-1)!.postedOn).toBe('2026-09-05');
  });

  it('returns nothing for a key that matches no series', () => {
    expect(getSeriesTransactions(freshDb(), { key: 'INEXISTENTE' }, NOW)).toEqual([]);
  });
});
