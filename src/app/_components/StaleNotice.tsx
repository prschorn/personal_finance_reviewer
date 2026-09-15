import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getSyncStatus } from '../../queries/status';

/**
 * Pluggy refreshes items on its own schedule and its docs advise against building
 * an update loop, so this app only pulls. That makes "how old is this?" a real
 * question the page has to answer.
 */
export function StaleNotice() {
  const db = bootstrap(getDb());
  const status = getSyncStatus(db);
  if (!status.everSynced) return null;

  const hours = status.lastSuccessAt
    ? Math.floor((Date.now() - Date.parse(status.lastSuccessAt)) / 3_600_000)
    : null;

  const age =
    hours === null ? 'nunca' : hours < 1 ? 'há poucos minutos' : hours < 24 ? `há ${hours}h` : `há ${Math.floor(hours / 24)} dias`;

  return (
    <p className="mb-3 text-[12px]" style={{ color: status.stale ? 'var(--warn)' : 'var(--ink-faint)' }}>
      Atualizado {age}
      {status.lastRunStatus === 'partial' && ' · última sincronização foi parcial'}
      {status.lastRunStatus === 'error' && ' · última sincronização falhou'}
    </p>
  );
}
