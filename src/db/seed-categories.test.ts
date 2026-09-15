import { describe, it, expect } from 'vitest';
import { createTestDb } from './client';
import { runMigrations } from './migrate';
import { categories } from './schema';
import { seedCategories, SEED_CATEGORIES } from './seed-categories';

function freshDb() {
  const { db } = createTestDb();
  runMigrations(db);
  return db;
}

describe('seedCategories', () => {
  it('inserts every seed category', () => {
    const db = freshDb();
    expect(seedCategories(db)).toBe(SEED_CATEGORIES.length);
    expect(db.select().from(categories).all()).toHaveLength(SEED_CATEGORIES.length);
  });

  it('is idempotent', () => {
    const db = freshDb();
    seedCategories(db);
    expect(seedCategories(db)).toBe(0);
    expect(db.select().from(categories).all()).toHaveLength(SEED_CATEGORIES.length);
  });

  it('preserves spreadsheet row order', () => {
    const db = freshDb();
    seedCategories(db);
    const names = db.select().from(categories).orderBy(categories.sortOrder).all().map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['Condomínio', 'Apartamento', 'Luz']);
    expect(names).toContain('Marmitas');
    expect(names).toContain('DARF');
  });

  // Itemizing card purchases means the whole-bill rows must not exist, or every
  // card purchase would be counted twice.
  it('omits the whole-card-bill rows from the original sheet', () => {
    const db = freshDb();
    seedCategories(db);
    const names = db.select().from(categories).all().map((c) => c.name);
    expect(names).not.toContain('Itaú');
    expect(names).not.toContain('Nubank');
  });

  it('has exactly one internal category and a Receitas income fallback', () => {
    const db = freshDb();
    seedCategories(db);
    const all = db.select().from(categories).all();
    expect(all.filter((c) => c.kind === 'internal').map((c) => c.name)).toEqual(['Transferências internas']);
    // Income may have several named sources (PJ, salário…), but Receitas must exist
    // as the fallback for money in that no rule claimed.
    expect(all.filter((c) => c.kind === 'income').map((c) => c.name)).toContain('Receitas');
  });

  // A rule pointing at a category that does not exist is skipped in silence, so
  // those transactions never get classified. Cheap to catch here.
  it('covers every category the seed rules reference', () => {
    const db = freshDb();
    seedCategories(db);
    const names = new Set(db.select().from(categories).all().map((c) => c.name));
    const missing = SEED_CATEGORIES.filter((c) => !names.has(c.name));
    expect(missing).toEqual([]);
  });
});
