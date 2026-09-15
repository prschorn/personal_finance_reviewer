import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { freshDb as makeDb, addTx as insertTx } from '../db/testing';
import { countByFilter, listTransactions } from './transactions';

function freshDb(): DB {
  return makeDb({ accounts: [{ id: 'a', type: 'BANK', name: 'Conta' }] });
}

function addTx(db: DB, o: {
  description: string; signedCents: number; category: string; categorySource: string;
  status?: string; postedOn?: string;
}) {
  return insertTx(db, { accountId: 'a', postedOn: '2026-09-01', ...o });
}

describe('the "sem regra" filter', () => {
  /**
   * It selects rows no rule matched — where the category shown is the app's
   * fallback guess. That includes money in, which falls back to Receitas: the row
   * displays a category and still belongs in the review list.
   */
  it('includes income that fell back to Receitas', () => {
    const db = freshDb();
    addTx(db, { description: 'TRANSFERENCIA RECEBIDA', signedCents: 130755, category: 'Receitas', categorySource: 'default' });

    const rows = listTransactions(db, { filter: 'sem-regra' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.categoryName).toBe('Receitas');
    expect(rows[0]!.categorySource).toBe('default');
  });

  it('includes spending that fell back to Outros', () => {
    const db = freshDb();
    addTx(db, { description: 'LOJA DESCONHECIDA', signedCents: -5000, category: 'Outros', categorySource: 'default' });
    expect(listTransactions(db, { filter: 'sem-regra' })).toHaveLength(1);
  });

  it('excludes anything a rule or a person decided', () => {
    const db = freshDb();
    addTx(db, { description: 'SCHORN CONSULTORIA', signedCents: 2250000, category: 'PJ', categorySource: 'rule' });
    addTx(db, { description: 'ESCOLHIDO A MAO', signedCents: -900, category: 'Mercado', categorySource: 'manual' });
    addTx(db, { description: 'DICA DA PLUGGY', signedCents: -800, category: 'Mercado', categorySource: 'pluggy' });

    expect(listTransactions(db, { filter: 'sem-regra' })).toEqual([]);
  });

  it('counts the same rows the list returns', () => {
    const db = freshDb();
    addTx(db, { description: 'A', signedCents: 1000, category: 'Receitas', categorySource: 'default' });
    addTx(db, { description: 'B', signedCents: -1000, category: 'Outros', categorySource: 'default' });
    addTx(db, { description: 'C', signedCents: -1000, category: 'Mercado', categorySource: 'rule' });

    expect(countByFilter(db)['sem-regra']).toBe(2);
    expect(listTransactions(db, { filter: 'sem-regra' })).toHaveLength(2);
    expect(countByFilter(db).todas).toBe(3);
  });
});

describe('other filters', () => {
  it('lists everything under todas', () => {
    const db = freshDb();
    addTx(db, { description: 'A', signedCents: -1000, category: 'Mercado', categorySource: 'rule' });
    expect(listTransactions(db, { filter: 'todas' })).toHaveLength(1);
  });

  it('finds transactions still unbilled', () => {
    const db = freshDb();
    addTx(db, { description: 'A', signedCents: -1000, category: 'Mercado', categorySource: 'rule', status: 'PENDING' });
    addTx(db, { description: 'B', signedCents: -1000, category: 'Mercado', categorySource: 'rule' });
    expect(listTransactions(db, { filter: 'nao-faturadas' })).toHaveLength(1);
  });

  it('searches the description regardless of accents and case', () => {
    const db = freshDb();
    addTx(db, { description: 'Farmácia São João', signedCents: -1000, category: 'Farmácia', categorySource: 'rule' });
    expect(listTransactions(db, { search: 'farmacia sao' })).toHaveLength(1);
    expect(listTransactions(db, { search: 'padaria' })).toHaveLength(0);
  });
});
