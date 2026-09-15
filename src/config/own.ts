import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { settings } from '../db/schema';

/**
 * Your own identifiers, used to recognise transfers between your own accounts.
 *
 * This turns the fuzziest heuristic in the app — "is this a transfer to myself?" —
 * into an exact lookup, and is the single highest-leverage thing to configure.
 *
 * Stored in the settings table (editable from /settings) and seeded from the
 * environment on first boot so it never has to live in the repo.
 */

export interface OwnIdentifiers {
  /** CPF / CNPJ, digits only. */
  documents: string[];
  pixKeys: string[];
  /** Fragments of your own name as it appears on the far side of a transfer. */
  nameFragments: string[];
}

export const OWN_DOCUMENTS_KEY = 'own_documents';
export const OWN_PIX_KEYS_KEY = 'own_pix_keys';
export const OWN_NAME_FRAGMENTS_KEY = 'own_name_fragments';

export function getOwnIdentifiers(db: DB = getDb()): OwnIdentifiers {
  return {
    documents: readList(db, OWN_DOCUMENTS_KEY).map((d) => d.replace(/\D/g, '')).filter(Boolean),
    pixKeys: readList(db, OWN_PIX_KEYS_KEY),
    nameFragments: readList(db, OWN_NAME_FRAGMENTS_KEY).map((n) => n.toUpperCase()),
  };
}

export function setOwnIdentifiers(db: DB, patch: Partial<OwnIdentifiers>): void {
  if (patch.documents) writeList(db, OWN_DOCUMENTS_KEY, patch.documents);
  if (patch.pixKeys) writeList(db, OWN_PIX_KEYS_KEY, patch.pixKeys);
  if (patch.nameFragments) writeList(db, OWN_NAME_FRAGMENTS_KEY, patch.nameFragments);
}

/** Populate from the environment on first boot; never overwrites existing values. */
export function seedOwnIdentifiersFromEnv(db: DB = getDb(), env: NodeJS.ProcessEnv = process.env): void {
  const pairs: [string, string | undefined][] = [
    [OWN_DOCUMENTS_KEY, env.OWN_DOCUMENTS],
    [OWN_PIX_KEYS_KEY, env.OWN_PIX_KEYS],
    [OWN_NAME_FRAGMENTS_KEY, env.OWN_NAME_FRAGMENTS],
  ];
  for (const [key, raw] of pairs) {
    if (!raw) continue;
    if (db.select().from(settings).where(eq(settings.key, key)).get()) continue;
    writeList(db, key, raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
}

function readList(db: DB, key: string): string[] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(db: DB, key: string, values: string[]): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(values) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(values) } })
    .run();
}
