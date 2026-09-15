import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DB } from '../db/client';
import { transactions, transactionOverrides } from '../db/schema';

/**
 * Carry manual categorizations across Pluggy's delete-and-recreate.
 *
 * Overrides are keyed by fingerprint, which is stable for card purchases (anchored
 * on the merchant-set purchase date). For everything else — a bank transaction
 * whose posting date shifted — the fingerprint changes, orphaning the override.
 * This pass reattaches those.
 *
 * Only MANUAL overrides need rescuing: rule-derived categories re-apply on their
 * own, which keeps the blast radius to a handful of rows per sync.
 */

/** How far a recreated transaction's posting date may have moved. */
export const RESCUE_DAY_WINDOW = 5;

export interface RescueStats {
  migrated: number;
  /** Could not be matched confidently. Harmless — they re-match if the row returns. */
  orphaned: number;
  /** Two or more equally plausible candidates, so we refused to guess. */
  ambiguous: number;
}

export function emptyRescueStats(): RescueStats {
  return { migrated: 0, orphaned: 0, ambiguous: 0 };
}

export interface RescueInput {
  /** Fingerprints soft-deleted by this run's sweep. */
  deletedFingerprints: string[];
  accountId: string;
  runId: number;
  now: string;
}

export function rescueOverrides(db: DB, input: RescueInput, stats: RescueStats = emptyRescueStats()): RescueStats {
  const { deletedFingerprints, accountId, runId, now } = input;
  if (!deletedFingerprints.length) return stats;

  // Only fingerprints that actually carry a manual override are worth rescuing.
  const orphans = db
    .select()
    .from(transactionOverrides)
    .where(inArray(transactionOverrides.fingerprint, [...new Set(deletedFingerprints)]))
    .all();
  if (!orphans.length) return stats;

  // An override whose fingerprint is still in use by another live row isn't orphaned.
  const stillLive = new Set(
    db
      .select({ fingerprint: transactions.fingerprint })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt)))
      .all()
      .map((r) => r.fingerprint),
  );

  // Candidates: rows THIS run inserted that don't already carry an override.
  const inserted = db
    .select({
      id: transactions.id,
      fingerprint: transactions.fingerprint,
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
    })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.lastSeenRunId, runId), isNull(transactions.deletedAt)))
    .all()
    .filter((c) => !existingOverride(db, c.fingerprint));

  db.transaction((tx) => {
    for (const orphan of orphans) {
      if (stillLive.has(orphan.fingerprint)) continue;

      const deleted = db
        .select({ amountCents: transactions.amountCents, postedOn: transactions.postedOn })
        .from(transactions)
        .where(eq(transactions.fingerprint, orphan.fingerprint))
        .get();
      if (!deleted) {
        stats.orphaned++;
        continue;
      }

      const candidates = inserted.filter(
        (c) =>
          c.amountCents === deleted.amountCents &&
          Math.abs(daysBetween(c.postedOn, deleted.postedOn)) <= RESCUE_DAY_WINDOW,
      );

      // Refuse to guess: a wrong migration silently mis-categorizes real spending.
      if (candidates.length !== 1) {
        if (candidates.length > 1) stats.ambiguous++;
        stats.orphaned++;
        continue;
      }

      const target = candidates[0]!;
      tx.insert(transactionOverrides)
        .values({
          fingerprint: target.fingerprint,
          categoryId: orphan.categoryId,
          isInternal: orphan.isInternal,
          note: orphan.note,
          migratedFrom: orphan.fingerprint,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      stats.migrated++;
    }
  });

  return stats;
}

/**
 * Case (i) of PENDING -> POSTED: Pluggy updated the row IN PLACE, so the old row is
 * right there and migration is deterministic rather than heuristic.
 * Call before the upsert overwrites the fingerprint.
 */
export function migrateOverrideInPlace(
  db: DB,
  transactionId: string,
  newFingerprint: string,
  now: string,
): boolean {
  const existing = db
    .select({ fingerprint: transactions.fingerprint })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!existing || existing.fingerprint === newFingerprint) return false;

  const override = db
    .select()
    .from(transactionOverrides)
    .where(eq(transactionOverrides.fingerprint, existing.fingerprint))
    .get();
  if (!override) return false;

  db.insert(transactionOverrides)
    .values({
      fingerprint: newFingerprint,
      categoryId: override.categoryId,
      isInternal: override.isInternal,
      note: override.note,
      migratedFrom: override.fingerprint,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return true;
}

function existingOverride(db: DB, fingerprint: string): boolean {
  return !!db
    .select({ fingerprint: transactionOverrides.fingerprint })
    .from(transactionOverrides)
    .where(eq(transactionOverrides.fingerprint, fingerprint))
    .get();
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86_400_000;
}
