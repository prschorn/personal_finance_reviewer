'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '../db/client';
import { bootstrap, configuredItemIds } from '../db/bootstrap';
import { clientFromEnv } from '../pluggy/client';
import { syncAndCategorize, recategorize } from '../sync/pipeline';
import { setOverride, clearOverride } from '../categorize/recategorize';
import {
  categorySnapshot, countMatching, countMoved, countWithCategory, deleteUserRule,
  findShadowingRule, learnCategoryFromTransaction, setRuleEnabled,
} from '../categorize/learn';
import { setOwnIdentifiers } from '../config/own';
import { setLastReviewedAt } from '../config/settings';
import { getReviewQueue } from '../queries/review';
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
  for (const path of ['/', '/hoje', '/dashboard', '/cards', '/recorrentes', '/revisar', '/transactions', '/internal', '/rules', '/settings']) {
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

/**
 * Categorize every transaction with the same merchant name, in every month.
 *
 * Creates a rule rather than a one-off override, which is what makes the change
 * reach past months and survive future syncs.
 */
export async function categorizeAllLike(
  fingerprint: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const learned = learnCategoryFromTransaction(db, fingerprint, categoryId);

  if (!learned.ok) {
    // Too generic to make a rule from — fall back to this one transaction only,
    // so the click still does something rather than failing silently.
    setOverride(db, fingerprint, { categoryId });
    recategorize(db);
    revalidateAll();
    return { ok: true, message: `Categoria salva só nesta. ${learned.reason ?? ''}`.trim() };
  }

  // A rule can't beat an override left over from an earlier "só esta" on this same
  // transaction, so clear it — otherwise the new choice appears not to apply here.
  clearOverride(db, fingerprint);
  recategorize(db);
  revalidateAll();

  if (categoryId == null) return { ok: true, message: `Regra removida para "${learned.key}"` };

  const key = learned.key!;
  const matched = countMatching(db, key);
  // Count what actually ended up with the category, rather than what merely matched
  // the text. If another rule is winning, this is how we find out instead of
  // reporting a success that did not happen.
  const applied = countWithCategory(db, key, categoryId);

  if (applied === 0) {
    const blocker = findShadowingRule(db, key, categoryId);
    return {
      ok: false,
      message: 'A categoria não foi aplicada',
      detail: [
        blocker
          ? `A regra "${blocker.name}" combina com estes lançamentos e vem antes. Desative ou ajuste essa regra em Regras.`
          : 'Estes lançamentos estão marcados como transferência, então ficam fora dos totais. Use "Contar como gasto" em Transferências primeiro.',
      ],
    };
  }

  const what = learned.totalInstallments
    ? `${applied} ${applied === 1 ? 'lançamento' : 'lançamentos'}, incluindo as parcelas de ${learned.totalInstallments}`
    : `${applied} ${applied === 1 ? 'lançamento' : 'lançamentos'}`;

  const tidied = learned.superseded?.length
    ? ` ${learned.superseded.length} ${learned.superseded.length === 1 ? 'regra antiga substituída' : 'regras antigas substituídas'}.`
    : '';

  const partial =
    applied < matched
      ? ` ${matched - applied} não mudaram: veja em Transferências ou Regras.`
      : '';

  // Repointing an existing rule reaches everything that rule already covered,
  // which is a larger blast radius than adding one.
  const repointed = learned.updatedExisting ? ' Uma regra que já existia foi apontada para esta categoria.' : '';

  return { ok: true, message: `${what} de "${key}" categorizados, em todos os meses.${tidied}${partial}${repointed}` };
}

/**
 * Narrow a choice back to this one transaction: drop the rule it created and pin
 * the category here instead.
 *
 * Without removing the rule, "só esta" would leave every other matching
 * transaction categorized and only appear to have narrowed anything.
 */
export async function categorizeOnlyThis(
  fingerprint: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const db = bootstrap(getDb());
  learnCategoryFromTransaction(db, fingerprint, null); // removes the user rule, if any
  setOverride(db, fingerprint, { categoryId });
  recategorize(db);
  revalidateAll();
  return { ok: true, message: 'Aplicado só a este lançamento' };
}

/** Categorize exactly one transaction, leaving everything like it untouched. */
export async function categorizeTransaction(
  fingerprint: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const db = bootstrap(getDb());
  setOverride(db, fingerprint, { categoryId });
  recategorize(db);
  revalidateAll();
  return { ok: true, message: 'Categoria salva só nesta' };
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

/**
 * Remove a rule you created.
 *
 * Reports how many transactions changed category as a result, because that is the
 * consequence you actually care about — a rule can look harmless and still be
 * holding a dozen transactions in the wrong row.
 */
export async function removeRule(id: number): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const before = categorySnapshot(db);
  const res = deleteUserRule(db, id);

  if (!res.ok) return { ok: false, message: res.reason ?? 'Não foi possível remover' };

  recategorize(db);
  revalidateAll();

  const moved = countMoved(before, categorySnapshot(db));
  return {
    ok: true,
    message: moved
      ? `Regra "${res.name}" removida. ${moved} ${moved === 1 ? 'lançamento mudou' : 'lançamentos mudaram'} de categoria.`
      : `Regra "${res.name}" removida. Nenhum lançamento mudou de categoria.`,
  };
}

/** Turn a rule off or back on. The only option for rules shipped with the app. */
export async function toggleRule(id: number, enabled: boolean): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const before = categorySnapshot(db);
  const res = setRuleEnabled(db, id, enabled);

  if (!res.ok) return { ok: false, message: res.reason ?? 'Não foi possível alterar' };

  recategorize(db);
  revalidateAll();

  const moved = countMoved(before, categorySnapshot(db));
  const what = enabled ? 'ativada' : 'desativada';
  return {
    ok: true,
    message: moved
      ? `Regra "${res.name}" ${what}. ${moved} ${moved === 1 ? 'lançamento mudou' : 'lançamentos mudaram'} de categoria.`
      : `Regra "${res.name}" ${what}. Nenhum lançamento mudou de categoria.`,
  };
}

/**
 * Clear the review queue.
 *
 * Explicit, never implicit on visiting the page: a digest you lose to a stray
 * click is worse than one you have to dismiss. Nothing about categorization
 * changes, so this does not recategorize.
 */
export async function markReviewed(): Promise<ActionResult> {
  const db = bootstrap(getDb());
  const before = getReviewQueue(db).total;

  setLastReviewedAt(db);
  revalidateAll();

  return {
    ok: true,
    message: before === 0 ? 'Nada na fila.' : `Marcado. ${before} ${before === 1 ? 'item saiu' : 'itens saíram'} da fila.`,
  };
}
