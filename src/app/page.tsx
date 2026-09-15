import Link from 'next/link';
import { getDb } from '../db/client';
import { bootstrap } from '../db/bootstrap';
import { getAvailableYears, getDefaultYear, getMatrix, getUncategorized } from '../queries/matrix';
import { formatBRL } from '../lib/money';
import { MatrixGrid } from './_components/MatrixGrid';
import { StaleNotice } from './_components/StaleNotice';
import { ConnectionBanner } from './_components/ConnectionBanner';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ ano?: string }> }) {
  const db = bootstrap(getDb());
  const params = await searchParams;

  const years = getAvailableYears(db);
  const requested = Number(params.ano);
  const year = years.includes(requested) ? requested : getDefaultYear(db);

  const matrix = getMatrix(db, year);
  const pending = getUncategorized(db, 500);

  return (
    <div className="mx-auto max-w-[1500px]">
      <ConnectionBanner />

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-4">
          <h1 className="font-serif text-4xl leading-none tracking-tight">{year}</h1>
          <div className="flex gap-1">
            {years.length > 1 && years.map((y) => (
              <Link
                key={y}
                href={`/?ano=${y}`}
                aria-current={y === year ? 'page' : undefined}
                className="tnum rounded px-2 py-1 text-[13px]"
                style={{
                  color: y === year ? 'var(--ink)' : 'var(--ink-soft)',
                  background: y === year ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {y}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[15px]">
          <p className="tnum" style={{ color: 'var(--ink-soft)' }}>
            {formatBRL(matrix.incomeGrandTotal)} recebidos
          </p>
          <p className="tnum" style={{ color: 'var(--ink-soft)' }}>
            {formatBRL(matrix.grandTotal)} gastos
          </p>
          <p
            className="tnum font-medium"
            style={{ color: matrix.balanceGrandTotal < 0 ? 'var(--alert)' : 'var(--positive)' }}
          >
            {matrix.balanceGrandTotal < 0 ? '−' : '+'}
            {formatBRL(Math.abs(matrix.balanceGrandTotal))} de saldo
          </p>
        </div>
      </div>

      <StaleNotice />

      {pending.length > 0 && (
        <Link
          href="/transactions?filtro=sem-categoria"
          className="mb-4 flex items-center gap-2 rounded border px-3 py-2 text-[13px]"
          style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}
        >
          <span className="tnum font-medium">{pending.length}</span>
          <span>
            {pending.length === 1 ? 'transação sem regra' : 'transações sem regra'}: gastos foram para Outros e
            entradas viraram Receitas. Revisar →
          </span>
        </Link>
      )}

      <MatrixGrid matrix={matrix} />

      <p className="mt-6 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Compras no cartão entram na categoria do que foi comprado. O pagamento da fatura é tratado como
        transferência e não conta como gasto, para não somar duas vezes. Saldo é receita menos gasto:
        investimentos e transferências entre contas suas ficam de fora dos dois lados, e estornos abatem a
        própria categoria em vez de virarem receita. Clique em qualquer número para ver os lançamentos por
        trás dele.
      </p>
    </div>
  );
}
