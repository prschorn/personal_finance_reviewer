'use client';

import { useState } from 'react';
import type { CommittedMonth } from '../../queries/today';
import { Money } from './Money';
import { DrillDown } from './DrillDown';

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function label(ym: string) {
  return `${MONTH_LABELS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/**
 * Scheduled installments, by the month they will be billed in.
 *
 * Clicking a month opens the same panel the grid and the cards page use, so the
 * rows behind a figure are always one click away and always the same rows.
 */
export function CommittedMonths({ months }: { months: CommittedMonth[] }) {
  const [open, setOpen] = useState<CommittedMonth | null>(null);
  const total = months.reduce((sum, m) => sum + m.cents, 0);

  return (
    <>
      <table className="ledger w-full text-[13px]">
        <caption className="sr-only">Parcelas já agendadas, por mês de cobrança</caption>
        <thead>
          <tr>
            <th scope="col" className="py-1.5 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
              Mês
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Parcelas
            </th>
            <th scope="col" className="py-1.5 text-right font-normal" style={{ color: 'var(--ink-soft)' }}>
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row" className="py-1.5 text-left font-normal">
                <button
                  type="button"
                  onClick={() => setOpen(m)}
                  className="font-serif text-[15px] underline-offset-4 hover:underline"
                  style={{ color: 'var(--ink)' }}
                >
                  {label(m.month)}
                </button>
              </th>
              <td className="tnum py-1.5 text-right" style={{ color: 'var(--ink-faint)' }}>
                {m.count}
              </td>
              <td className="py-1.5 text-right">
                <Money cents={m.cents} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="py-1.5 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
              Total
            </th>
            <td />
            <td className="py-1.5 text-right">
              <Money cents={total} />
            </td>
          </tr>
        </tfoot>
      </table>

      {open && (
        <DrillDown
          url={`/api/committed?month=${encodeURIComponent(open.month)}`}
          categoryId={null}
          title={label(open.month)}
          subtitle="parcelas agendadas"
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
