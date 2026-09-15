'use client';

import { useState } from 'react';
import type { Series } from '../../queries/dashboard';
import { formatBRL } from '../../lib/money';
import { LineChart } from './LineChart';
import { seriesVar } from './chart-palette';

/**
 * One chart with its title and a table view.
 *
 * The table is not optional decoration: three hues in this palette sit below 3:1
 * against the light surface, which obligates relief — the numbers have to be
 * readable without relying on the colours. It doubles as the accessible view.
 */
export function ChartCard({
  title,
  description,
  series,
  labels,
}: {
  title: string;
  description: string;
  series: Series[];
  labels: string[];
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <section className="mb-12">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-serif text-xl">{title}</h2>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="text-[12px] underline"
          style={{ color: 'var(--ink-soft)' }}
          aria-expanded={showTable}
        >
          {showTable ? 'Ver gráfico' : 'Ver tabela'}
        </button>
      </div>
      <p className="mb-3 max-w-2xl text-[12px]" style={{ color: 'var(--ink-faint)' }}>
        {description}
      </p>

      {showTable ? (
        <div className="overflow-x-auto">
          <table className="ledger w-full text-[13px]">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-3 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
                  Série
                </th>
                {labels.map((l) => (
                  <th key={l} scope="col" className="px-2 py-2 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
                    {l}
                  </th>
                ))}
                <th scope="col" className="col-total px-3 py-2 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.name}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-serif text-[15px] font-normal">
                    <span
                      aria-hidden
                      className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                      style={{ background: seriesVar(s.slot) }}
                    />
                    {s.name}
                  </th>
                  {s.values.map((v, i) => (
                    <td key={i} className="tnum px-2 py-1.5 text-right">
                      {v === 0 ? <span style={{ color: 'var(--ink-faint)' }}>–</span> : formatBRL(v)}
                    </td>
                  ))}
                  <td className="tnum col-total px-3 py-1.5 text-right font-medium">
                    {formatBRL(s.values.reduce((a, b) => a + b, 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <LineChart series={series} labels={labels} caption={title} />
      )}
    </section>
  );
}
