'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '../db/client';
import { bootstrap, configuredItemIds } from '../db/bootstrap';
import { clientFromEnv } from '../pluggy/client';
import { syncAndCategorize, recategorize } from '../sync/pipeline';
import { setOverride, clearOverride } from '../categorize/recategorize';
import { setOwnIdentifiers } from '../config/own';
import { items } from '../db/schema';
import { eq } from 'drizzle-orm';

/**
 * Server actions. Each one bootstraps the database, does its work, then
 * revalidates every view, since a categorization change can move figures on all
 * of them at once.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  detail?: string[];
}

function revalidateAll() {
  for (const path of ['/', '/cards', '/transactions', '/internal', '/rules', '/settings']) {
    revalidatePath(path);
  }
}

export async function syncNow(trigger: 'manual' | 'auto' = 'manual'): Promise<ActionResult> {
  const db = bootstrap(getDb());
  try {
    const api = clientFromEnv();
    const res = await syncAndCategorize(api, db, { trigger, fallbackItemIds: configuredItemIds() });

    const t = res.sync.transactions;
    const parts = [
      `${t.inserted} novas`,
      `${t.updated} atualizadas`,
      res.sync.deleted ? `${res.sync.deleted} removidas` : null,
      res.sync.overrides.migrated ? `${res.sync.overrides.migrated} categorias mantidas` : null,
    ].filter(Boolean) as string[];

    const detail = [...res.sync.warnings];
    if (t.signMismatches > 0) {
      detail.push(
        `${t.signMismatches} transações têm sinal inconsistente com o tipo informado pelo banco. Os totais podem estar errados.`,
      );
    }
    if (res.sync.overrides.orphaned > 0) {
      detail.push(
        `${res.sync.overrides.orphaned} categorias manuais não puderam ser reassociadas. Reveja em Transações.`,
      );
    }
    if (res.duplicateFingerprints > 0) {
      detail.push(`${res.duplicateFingerprints} possíveis duplicatas. Verifique em Transações.`);
    }

    revalidateAll();
    return { ok: res.sync.status !== 'error', message: parts.join(' · '), detail };
  } catch (err) {
    return { ok: false, message: 'Falha na sincronização', detail: [describe(err)] };
  }
}

export async function categorizeTransaction(
  fingerprint: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const db = bootstrap(getDb());
  setOverride(db, fingerprint, { categoryId });
  recategorize(db);
  revalidateAll();
  return { ok: true, message: 'Categoria salva' };
}

export async function markInternal(fingerprint: string, isInternal: boolean): Promise<ActionResult> {
  const db = bootstrap(getDb());
  setOverride(db, fingerprint, { isInternal });
  recategorize(db);
  revalidateAll();
  return {
    ok: true,
    message: isInternal ? 'Marcada como transferência' : 'Voltou a contar como gasto',
  };
}

export async function resetCategorization(fingerprint: string): Promise<ActionResult> {
  const db = bootstrap(getDb());
  clearOverride(db, fingerprint);
  recategorize(db);
  revalidateAll();
  return { ok: true, message: 'Voltou a seguir as regras' };
}

export async function saveOwnIdentifiers(form: FormData): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const parse = (key: string) =>
    String(form.get(key) ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  setOwnIdentifiers(db, {
    documents: parse('documents'),
    pixKeys: parse('pixKeys'),
    nameFragments: parse('nameFragments'),
  });
  recategorize(db);
  revalidateAll();
  return { ok: true, message: 'Identificadores salvos' };
}

export async function addItemId(form: FormData): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const id = String(form.get('itemId') ?? '').trim();
  if (!id) return { ok: false, message: 'Informe o ID da conexão' };
  db.insert(items).values({ id }).onConflictDoNothing().run();
  revalidateAll();
  return { ok: true, message: 'Conexão adicionada. Sincronize para buscar os dados.' };
}

export async function removeItemId(id: string): Promise<ActionResult> {
  const db = bootstrap(getDb());
  db.delete(items).where(eq(items.id, id)).run();
  revalidateAll();
  return { ok: true, message: 'Conexão removida' };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
