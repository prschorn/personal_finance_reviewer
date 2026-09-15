'use client';

import { useState } from 'react';
import type { RecurringSeries } from '../../queries/recurring';
import { formatBRL } from '../../lib/money';
import { Money } from './Money';
import { DrillDown } from './DrillDown';

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function monthLabel(ym: string) {
  return `${MONTH_LABELS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}`;
}

function StatusNote({ series }: { series: RecurringSeries }) {
  if (series.priceChange) {
    const { fromCents, toCents, sinceMonth, deltaShare } = series.priceChange;
    return (
      <span style={{ color: 'var(--warn)' }}>
        de {formatBRL(fromCents)} para {formatBRL(toCents)} desde {monthLabel(sinceMonth)} (
        {deltaShare > 0 ? '+' : '−'}
        {Math.abs(Math.round(deltaShare * 100))}%)
      </span>
    );
  }
  if (series.status === 'parada') {
    return (
      <span style={{ color: 'var(--ink-soft)' }}>
        sem cobrança desde {monthLabel(series.lastMonth)} · costumava cair no dia {series.expectedDay}
      </span>
    );
  }
  if (series.status === 'nova') {
    return (
      <span style={{ color: 'var(--ink-soft)' }}>
        apareceu {series.activeMonths} vezes desde {monthLabel(series.firstMonth)} — pode ser nova
      </span>
    );
  }
  return null;
}

export function RecurringTable({ series, caption }: { series: RecurringSeries[]; caption: string }) {
  const [open, setOpen] = useState<RecurringSeries | null>(null);

  return (
    <>
      <table className="ledger w-full text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="py-1.5 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
              Cobrança
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Dia
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Por mês
            </th>
            <th scope="col" className="col-total py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Por ano
            </th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={`${s.direction}-${s.key}`} style={s.status === 'parada' ? { opacity: 0.62 } : undefined}>
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <button
                  type="button"
                  onClick={() => setOpen(s)}
                  className="block max-w-[26rem] truncate text-left font-serif text-[15px] underline-offset-4 hover:underline"
                  style={{ color: 'var(--ink)' }}
                >
                  {s.label}
                </button>
                <span className="text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                  {s.categoryName ?? 'sem categoria'} · {s.activeMonths} de {s.spanMonths} meses
                </span>
                <span className="block text-[12px]">
                  <StatusNote series={s} />
                </span>
              </th>
              <td className="tnum py-2 text-right align-top" style={{ color: 'var(--ink-faint)' }}>
                {s.expectedDay}
              </td>
              <td className="py-2 text-right align-top">
                <Money cents={s.typicalCents} />
              </td>
              <td className="col-total py-2 text-right align-top">
                <Money cents={s.annualCents} dim />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <DrillDown
          url={`/api/recurring?key=${encodeURIComponent(open.key)}`}
          categoryId={open.categoryId}
          title={open.label}
          subtitle={`${open.activeMonths} cobranças · ${open.key}`}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
