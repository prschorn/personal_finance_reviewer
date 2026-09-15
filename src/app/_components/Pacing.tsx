import type { Pacing as PacingData, PacingRow } from '../../queries/pacing';
import { formatBRL } from '../../lib/money';

/**
 * This month so far, against the same stretch of your own previous months.
 *
 * Deliberately colourless. Half of all months sit above a median by construction,
 * so painting "above" red would fire every other month on every category and mean
 * nothing. The band is what gives the figure its context: inside p25..p75 is an
 * ordinary month, whichever side of the median it lands on.
 */
function Band({ row }: { row: PacingRow }) {
  if (row.medianCents === null) return null;

  const scale = Math.max(row.highCents!, row.currentCents, row.medianCents) * 1.15 || 1;
  const pct = (cents: number) => `${Math.min(100, (cents / scale) * 100)}%`;

  return (
    <div className="relative mt-1 h-1.5 w-full" aria-hidden>
      <div className="absolute inset-y-[3px] left-0 right-0 rounded-full" style={{ background: 'var(--rule)' }} />
      <div
        className="absolute inset-y-[3px] rounded-full"
        style={{
          left: pct(row.lowCents!),
          width: `calc(${pct(row.highCents!)} - ${pct(row.lowCents!)})`,
          background: 'rgb(var(--heat) / 0.28)',
        }}
      />
      <div
        className="absolute top-0 h-full w-px"
        style={{ left: pct(row.medianCents), background: 'var(--rule-strong)' }}
      />
      <div
        className="absolute top-[-2px] h-[10px] w-[2px] rounded-full"
        style={{ left: pct(row.currentCents), background: 'var(--ink)' }}
      />
    </div>
  );
}

export function Pacing({ pacing }: { pacing: PacingData }) {
  const shown = pacing.rows.filter((r) => r.currentCents > 0 || r.medianCents !== null).slice(0, 12);
  if (!shown.length) return null;

  const withReference = shown.filter((r) => r.medianCents !== null);
  const without = shown.filter((r) => r.medianCents === null);

  return (
    <section>
      <h2 className="mb-1 font-serif text-xl">Ritmo do mês</h2>
      <p className="mb-4 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Dia {pacing.day}, comparado com o dia {pacing.day} dos {pacing.baselineMonths.length} meses
        anteriores — não com o mês inteiro deles.
        {pacing.totalMedianCents !== null && (
          <>
            {' '}
            No total: {formatBRL(pacing.totalCurrentCents)} contra {formatBRL(pacing.totalMedianCents)} de
            mediana.
          </>
        )}
      </p>

      <table className="ledger w-full text-[13px]">
        <caption className="sr-only">Gasto do mês até hoje, por categoria, contra a mediana</caption>
        <thead>
          <tr>
            <th scope="col" className="py-1.5 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
              Categoria
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Até agora
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Sua mediana
            </th>
          </tr>
        </thead>
        <tbody>
          {withReference.map((row) => (
            <tr key={row.categoryId}>
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="font-serif text-[15px]">{row.name}</span>
                {row.confidence === 'fraca' && (
                  <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                    histórico curto
                  </span>
                )}
                <Band row={row} />
              </th>
              <td className="tnum py-2 text-right align-top">{formatBRL(row.currentCents)}</td>
              <td className="tnum py-2 text-right align-top" style={{ color: 'var(--ink-soft)' }}>
                {formatBRL(row.medianCents!)}
                <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                  {Math.round(row.share! * 100)}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {without.length > 0 && (
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
          Sem histórico suficiente para comparar:{' '}
          {without.map((r) => `${r.name} (${formatBRL(r.currentCents)})`).join(', ')}.
        </p>
      )}

      <p className="mt-3 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Mediana, não média: um mês atípico não desloca a referência. Metade dos meses fica acima
        dela — isso é o esperado, não um aviso. A faixa marca onde caiu a metade do meio dos seus
        meses.
      </p>
    </section>
  );
}
