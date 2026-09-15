'use client';

import { useState } from 'react';
import type { CardBreakdown } from '../../queries/cards';
import { formatBRL } from '../../lib/money';
import { Money } from './Money';
import { DrillDown } from './DrillDown';

/**
 * Card spending by category, with each row opening the transactions behind it.
 *
 * The bar carries the comparison and the number confirms it; the row is the click
 * target, so the whole line is actionable rather than a small link at the end.
 */
export function CardCategoryBreakdown({
  breakdown,
  periodLabel,
}: {
  breakdown: CardBreakdown;
  periodLabel: string;
}) {
  const [open, setOpen] = useState<{ categoryId: number | null; name: string } | null>(null);

  const url = open
    ? `/api/card-category?year=${breakdown.period.year}` +
      (breakdown.period.month ? `&month=${encodeURIComponent(breakdown.period.month)}` : '') +
      `&categoryId=${open.categoryId ?? ''}`
    : '';

  return (
    <>
      <table className="ledger w-full text-[13px]">
        <caption className="sr-only">Gastos no cartão por categoria em {periodLabel}</caption>
        <tbody>
          {breakdown.byCategory.map((row) => (
            <tr key={row.categoryId ?? 'sem'}>
              <th scope="row" className="w-[40%] p-0 text-left font-normal">
                <button
                  type="button"
                  onClick={() => setOpen({ categoryId: row.categoryId, name: row.name })}
                  className="w-full py-2 pr-3 text-left font-serif text-[15px] hover:underline"
                  title={`Ver os ${row.count} lançamentos de ${row.name}`}
                >
                  {row.name}
                </button>
              </th>
              <td className="py-2 pr-3">
                <div className="h-[6px] w-full rounded-full" style={{ background: 'var(--rule)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(1, row.share * 100)}%`, background: 'var(--accent)' }}
                  />
                </div>
              </td>
              <td className="tnum w-14 py-2 pr-3 text-right" style={{ color: 'var(--ink-faint)' }}>
                {Math.round(row.share * 100)}%
              </td>
              <td className="w-28 p-0 text-right">
                <button
                  type="button"
                  onClick={() => setOpen({ categoryId: row.categoryId, name: row.name })}
                  className="w-full py-2 text-right hover:underline"
                  title={`Ver os ${row.count} lançamentos de ${row.name}`}
                >
                  <Money cents={row.cents} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="py-2 font-medium">Total</td>
            <td />
            <td />
            <td className="py-2 text-right font-medium">{formatBRL(breakdown.totalCents)}</td>
          </tr>
        </tfoot>
      </table>

      {open && (
        <DrillDown
          url={url}
          categoryId={open.categoryId}
          title={open.name}
          subtitle={`No cartão · ${periodLabel}`}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
