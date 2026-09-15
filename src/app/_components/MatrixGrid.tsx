'use client';

import { useState } from 'react';
import type { Matrix } from '../../queries/matrix';
import { formatBRL } from '../../lib/money';
import { CompactMoney, SignedCompact } from './Money';
import { DrillDown } from './DrillDown';

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/**
 * The year as a landscape.
 *
 * Cell shading is proportional to the largest single cell in the year, so heavy
 * months and heavy categories are visible before any figure is read. This is the
 * one place the design spends any boldness; everything around it stays quiet.
 */
function TotalsRow({
  label, cells, total, tone = 'expense', strong = false,
}: {
  label: string;
  cells: number[];
  total: number;
  tone?: 'expense' | 'income' | 'balance';
  strong?: boolean;
}) {
  const colorFor = (value: number) => {
    if (tone === 'income') return value === 0 ? undefined : 'var(--positive)';
    if (tone === 'balance') {
      if (value === 0) return undefined;
      return value < 0 ? 'var(--alert)' : 'var(--positive)';
    }
    return undefined;
  };

  // Saldo is already signed; expenses and income are positive magnitudes, so only
  // Saldo may legitimately render negative.
  const render = (value: number) =>
    tone === 'balance' ? <SignedCompact cents={value} /> : <CompactMoney cents={value} />;

  return (
    <tr>
      <th
        scope="row"
        className={`sticky left-0 z-10 py-2 pr-3 text-left font-sans text-[13px] ${strong ? 'font-semibold' : 'font-medium'}`}
        style={{ background: 'var(--paper)' }}
      >
        {label}
      </th>
      {cells.map((value, i) => (
        <td key={i} className={`px-2 py-2 text-right ${strong ? 'font-semibold' : 'font-medium'}`} style={{ color: colorFor(value) }}>
          {render(value)}
        </td>
      ))}
      <td
        className={`col-total px-3 py-2 text-right ${strong ? 'font-semibold' : 'font-medium'}`}
        style={{ color: colorFor(total) }}
      >
        {render(total)}
      </td>
    </tr>
  );
}

export function MatrixGrid({ matrix }: { matrix: Matrix }) {
  const [cell, setCell] = useState<{ month: string; categoryId: number; name: string; label: string } | null>(null);

  const peak = Math.max(1, ...matrix.rows.flatMap((r) => r.cells.map((c) => Math.abs(c.cents))));
  const hasAnything = matrix.grandTotal !== 0 || matrix.rows.some((r) => r.total !== 0);

  if (!hasAnything) {
    return (
      <div className="mt-16 max-w-md">
        <h2 className="font-serif text-2xl" style={{ color: 'var(--ink)' }}>
          Nada em {matrix.year} ainda
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          Conecte um banco no Meu Pluggy, informe o ID da conexão em Ajustes e clique em Sincronizar.
          As transações aparecem aqui divididas pelas suas categorias.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="-mx-5 overflow-x-auto px-5 sm:-mx-8 sm:px-8">
        <table className="ledger w-full min-w-[860px] text-[13px]">
          <caption className="sr-only">Gastos por categoria e mês em {matrix.year}</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 py-2 pr-3 text-left font-normal" style={{ background: 'var(--paper)', color: 'var(--ink-soft)' }}>
                Categoria
              </th>
              {MONTH_LABELS.map((label, i) => (
                <th
                  key={label}
                  scope="col"
                  className="px-2 py-2 text-right font-normal"
                  style={{ color: matrix.monthsWithData[i] ? 'var(--ink-soft)' : 'var(--ink-faint)' }}
                >
                  {label}
                </th>
              ))}
              <th scope="col" className="col-total px-3 py-2 text-right font-medium" style={{ color: 'var(--ink)' }}>
                Ano
              </th>
            </tr>
          </thead>

          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.categoryId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 py-0.5 pr-3 text-left font-serif text-[15px] font-normal"
                  style={{ background: 'var(--paper)', color: row.total === 0 ? 'var(--ink-faint)' : 'var(--ink)' }}
                >
                  {row.name}
                </th>

                {row.cells.map((c, i) => {
                  const intensity = Math.abs(c.cents) / peak;
                  return (
                    <td key={i} className="p-0">
                      {c.count > 0 ? (
                        <button
                          type="button"
                          className="cell-button"
                          style={{ background: `rgba(var(--heat) / ${(intensity * 0.42).toFixed(3)})` }}
                          onClick={() =>
                            setCell({
                              month: matrix.months[i]!,
                              categoryId: row.categoryId,
                              name: row.name,
                              label: `${MONTH_LABELS[i]} ${matrix.year}`,
                            })
                          }
                          title={`${row.name} · ${MONTH_LABELS[i]} · ${formatBRL(c.cents)} · ${c.count} ${c.count === 1 ? 'lançamento' : 'lançamentos'}`}
                        >
                          <CompactMoney cents={c.cents} />
                        </button>
                      ) : (
                        <div className="cell-button" aria-hidden>
                          <CompactMoney cents={0} />
                        </div>
                      )}
                    </td>
                  );
                })}

                <td className="col-total px-3 py-0.5 text-right">
                  <CompactMoney cents={row.total} />
                </td>
              </tr>
            ))}
          </tbody>

          <tfoot>
            <TotalsRow label="Gastos" cells={matrix.monthTotals} total={matrix.grandTotal} />
            <TotalsRow label="Receitas" cells={matrix.incomeTotals} total={matrix.incomeGrandTotal} tone="income" />
            {/* Saldo is the one figure where a negative is genuinely an alarm, so it
                is the one place the grid uses red. */}
            <TotalsRow label="Saldo" cells={matrix.balanceTotals} total={matrix.balanceGrandTotal} tone="balance" strong />
          </tfoot>
        </table>
      </div>

      {cell && (
        <DrillDown
          month={cell.month}
          categoryId={cell.categoryId}
          title={cell.name}
          subtitle={cell.label}
          onClose={() => setCell(null)}
        />
      )}
    </>
  );
}
