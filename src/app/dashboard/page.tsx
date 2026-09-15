import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getAvailableYears, getDefaultYear } from '../../queries/matrix';
import { getDashboard } from '../../queries/dashboard';
import { formatBRL } from '../../lib/money';
import { ChartCard } from '../_components/ChartCard';
import { ConnectionBanner } from '../_components/ConnectionBanner';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string }>;
}) {
  const db = bootstrap(getDb());
  const params = await searchParams;

  const years = getAvailableYears(db);
  const requested = Number(params.ano);
  const year = years.includes(requested) ? requested : getDefaultYear(db);
  const d = getDashboard(db, year);

  const up = d.balanceTotal >= 0;

  return (
    <div className="mx-auto max-w-[1100px]">
      <ConnectionBanner />

      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-4">
          <h1 className="font-serif text-4xl leading-none tracking-tight">{year}</h1>
          {years.length > 1 && (
            <div className="flex gap-1">
              {years.map((y) => (
                <Link
                  key={y}
                  href={`/dashboard?ano=${y}`}
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
          )}
        </div>

        {/* Proportional figures, not tabular: these do not align in a column. */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[15px]">
          <span style={{ color: 'var(--ink-soft)' }}>{formatBRL(d.incomeTotal)} recebidos</span>
          <span style={{ color: 'var(--ink-soft)' }}>{formatBRL(d.spendingTotal)} gastos</span>
          <span className="font-medium" style={{ color: up ? 'var(--positive)' : 'var(--alert)' }}>
            {up ? '+' : '−'}
            {formatBRL(Math.abs(d.balanceTotal))} de saldo
          </span>
        </div>
      </div>

      {d.truncated && (
        <p className="mb-6 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
          Até {d.monthLabels.at(-1)}. Os meses seguintes só têm parcelas de cartão já agendadas e nenhuma
          receita, então ficam de fora para não parecerem uma queda. Veja-os em Cartões, em “Parcelas a vencer”.
        </p>
      )}

      <ChartCard
        title="Receitas e gastos"
        description="O que entrou e o que saiu em cada mês. Investimentos e transferências entre contas suas ficam de fora dos dois lados."
        series={d.incomeVsSpending}
        labels={d.monthLabels}
      />

      <ChartCard
        title="Gastos por categoria"
        description={`As maiores categorias do ano, mês a mês; o resto está somado em "Demais categorias". Clique numa série na legenda para escondê-la — a escala se ajusta ao que sobra, o que ajuda quando uma categoria grande achata as outras.`}
        series={d.byCategory}
        labels={d.monthLabels}
      />
    </div>
  );
}
