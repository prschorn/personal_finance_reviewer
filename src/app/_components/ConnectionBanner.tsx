import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getConnections, CONSENT_WARNING_DAYS } from '../../queries/status';

/**
 * Open Finance consent lapses silently: the API simply starts returning nothing.
 * Without this banner the failure mode is "the numbers stopped changing and
 * nobody noticed", so it is not decoration.
 */
export function ConnectionBanner() {
  const db = bootstrap(getDb());
  const problems = getConnections(db).filter((c) => c.needsAttention || c.consentExpiringSoon);
  if (!problems.length) return null;

  return (
    <div className="mb-4 space-y-2">
      {problems.map((c) => (
        <div
          key={c.itemId}
          className="rounded border px-3 py-2 text-[13px]"
          style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}
        >
          <strong className="font-medium">{c.connectorName ?? c.itemId.slice(0, 8)}</strong>{' '}
          {c.needsAttention
            ? `precisa ser reconectado (${c.status}).`
            : `tem consentimento vencendo em menos de ${CONSENT_WARNING_DAYS} dias.`}{' '}
          Renove em{' '}
          <a href="https://meu.pluggy.ai" target="_blank" rel="noreferrer" className="underline">
            meu.pluggy.ai
          </a>
          {' · '}
          <Link href="/settings" className="underline">
            Ajustes
          </Link>
        </div>
      ))}
    </div>
  );
}
