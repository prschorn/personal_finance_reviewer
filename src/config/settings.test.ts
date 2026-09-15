import { describe, it, expect } from 'vitest';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { readSetting, writeSetting, getLastReviewedAt, setLastReviewedAt } from './settings';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  return db;
}

describe('scalar settings', () => {
  it('round-trips a value', () => {
    const db = freshDb();
    writeSetting(db, 'alguma_coisa', 'valor');
    expect(readSetting(db, 'alguma_coisa')).toBe('valor');
  });

  it('overwrites rather than accumulating', () => {
    const db = freshDb();
    writeSetting(db, 'k', 'primeiro');
    writeSetting(db, 'k', 'segundo');
    expect(readSetting(db, 'k')).toBe('segundo');
  });

  it('returns null for a key never written', () => {
    expect(readSetting(freshDb(), 'inexistente')).toBeNull();
  });
});

describe('last reviewed', () => {
  it('is null until something is reviewed', () => {
    expect(getLastReviewedAt(freshDb())).toBeNull();
  });

  it('remembers when the queue was last cleared', () => {
    const db = freshDb();
    setLastReviewedAt(db, '2026-09-15T12:00:00.000Z');
    expect(getLastReviewedAt(db)).toBe('2026-09-15T12:00:00.000Z');
  });
});
