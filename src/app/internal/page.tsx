import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { listInternal } from '../../sync/internal';
import { Money } from '../_components/Money';
import { UnmarkInternal } from '../_components/UnmarkInternal';

export const dynamic = 'force-dynamic';

const REASON_LABEL: Record<string, string> = {
  card_payment: 'pagamento de fatura',
  own_transfer: 'transferência entre contas suas',
  rule: 'regra',
  manual: 'marcada por você',
};

/**
 * The safety valve.
 *
 * Excluding a transfer is what stops double-counting, but a wrong exclusion
 * silently erases real spending — the worst thing this app could do. So every
 * exclusion is listed here with its reason and can be undone in one click.
 */
export default async function InternalPage() {
  const db = bootstrap(getDb());
  const rows = listInternal(db);
  const total = rows.reduce((s, r) => s + Math.abs(r.signedCents), 0);

  return (
    <div className="mx-auto max-w-[900px]">
      <h1 className="mb-1 font-serif text-4xl leading-none tracking-tight">Transferências</h1>
      <p className="mb-6 max-w-2xl text-[14px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
        Dinheiro que só mudou de lugar: pagamentos de fatura e transferências entre suas próprias contas.
        Fica fora dos totais de gasto para não contar duas vezes. Se algo aqui for um gasto de verdade,
        devolva para os totais.
      </p>

      {rows.length === 0 ? (
        <div className="mt-12 max-w-md">
          <h2 className="font-serif text-2xl">Nada excluído</h2>
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            Todo lançamento está contando como gasto ou receita. Quando o app identificar um pagamento de
            fatura ou uma transferência entre suas contas, ele aparece aqui.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-4 tnum text-[14px]" style={{ color: 'var(--ink-soft)' }}>
            {rows.length} {rows.length === 1 ? 'lançamento' : 'lançamentos'} · <Money cents={total} dim /> fora dos totais
          </p>

          <ul>
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b py-3" style={{ borderColor: 'var(--rule)' }}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px]">{row.description ?? '—'}</p>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                    <span className="tnum">{row.postedOn.split('-').reverse().join('/')}</span>
                    {' · '}
                    {REASON_LABEL[row.internalReason ?? ''] ?? row.internalReason ?? 'motivo desconhecido'}
                  </p>
                </div>
                <Money cents={Math.abs(row.signedCents)} dim />
                <UnmarkInternal fingerprint={row.fingerprint} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
