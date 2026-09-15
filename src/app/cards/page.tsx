import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getCardBreakdown, getOpenInstallments } from '../../queries/cards';
import { getAvailableYears, getDefaultYear } from '../../queries/matrix';
import { formatBRL } from '../../lib/money';
import { Money } from '../_components/Money';

export const dynamic = 'force-dynamic';

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function monthLabel(ym: string) {
  return `${MONTH_LABELS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; mes?: string }>;
}) {
  const db = bootstrap(getDb());
  const params = await searchParams;

  const years = getAvailableYears(db);
  const requested = Number(params.ano);
  const year = years.includes(requested) ? requested : getDefaultYear(db);
  const month = params.mes && /^\d{4}-\d{2}$/.test(params.mes) ? params.mes : undefined;

  const b = getCardBreakdown(db, { year, month });
  const open = getOpenInstallments(db);
  const committed = open.reduce((s, r) => s + r.remainingCents, 0);

  const href = (m?: string) => `/cards?ano=${year}${m ? `&mes=${m}` : ''}`;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Cartões</h1>
        <p className="tnum text-[15px]" style={{ color: 'var(--ink-soft)' }}>
          {formatBRL(b.totalCents)} em {month ? monthLabel(month) : year}
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-1 text-[13px]">
        {years.map((y) => (
          <Link key={y} href={`/cards?ano=${y}`} className="tnum rounded px-2 py-1"
            style={{ color: y === year ? 'var(--ink)' : 'var(--ink-soft)', background: y === year ? 'var(--accent-soft)' : 'transparent' }}>
            {y}
          </Link>
        ))}
        <span className="mx-2" style={{ color: 'var(--rule-strong)' }}>|</span>
        <Link href={href()} className="rounded px-2 py-1"
          style={{ color: !month ? 'var(--ink)' : 'var(--ink-soft)', background: !month ? 'var(--accent-soft)' : 'transparent' }}>
          ano todo
        </Link>
        {b.monthsWithData.map((m) => (
          <Link key={m} href={href(m)} className="rounded px-2 py-1"
            style={{ color: month === m ? 'var(--ink)' : 'var(--ink-soft)', background: month === m ? 'var(--accent-soft)' : 'transparent' }}>
            {MONTH_LABELS[Number(m.slice(5, 7)) - 1]}
          </Link>
        ))}
      </div>

      {b.totalCents === 0 ? (
        <div className="mt-16 max-w-md">
          <h2 className="font-serif text-2xl">Nenhuma compra no cartão</h2>
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            Quando houver compras no período, elas aparecem aqui divididas por categoria, por cartão e por fatura.
          </p>
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
          <section>
            <h2 className="mb-3 font-serif text-xl">Por categoria</h2>
            <table className="ledger w-full text-[13px]">
              <tbody>
                {b.byCategory.map((row) => (
                  <tr key={row.categoryId ?? row.name}>
                    <th scope="row" className="w-[40%] py-2 pr-3 text-left font-serif text-[15px] font-normal">
                      {row.name}
                    </th>
                    <td className="py-2 pr-3">
                      {/* The bar is the comparison; the number is the confirmation. */}
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
                    <td className="w-28 py-2 text-right">
                      <Money cents={row.cents} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="py-2 font-medium">Total</td>
                  <td /><td />
                  <td className="py-2 text-right font-medium"><Money cents={b.totalCents} /></td>
                </tr>
              </tfoot>
            </table>
          </section>

          <div className="space-y-10">
            <section>
              <h2 className="mb-3 font-serif text-xl">Por cartão</h2>
              <table className="ledger w-full text-[13px]">
                <tbody>
                  {b.byCard.map((card) => (
                    <tr key={card.accountId}>
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <span className="font-serif text-[15px]">{card.name ?? 'Cartão'}</span>
                        {card.brand && <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>{card.brand}</span>}
                        {card.balanceDueDate && (
                          <span className="tnum ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                            vence {card.balanceDueDate.split('-').reverse().join('/')}
                          </span>
                        )}
                      </th>
                      <td className="py-2 text-right"><Money cents={card.cents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h2 className="mb-1 font-serif text-xl">Por fatura</h2>
              <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                Compare com a fatura em papel: se os valores baterem, os números desta página estão corretos.
              </p>
              <table className="ledger w-full text-[13px]">
                <tbody>
                  {b.byBill.map((bill, i) => {
                    const diff = bill.reportedTotalCents == null ? null : bill.reportedTotalCents - bill.chargedCents;
                    return (
                      <tr key={`${bill.billId ?? 'sem'}-${bill.accountId}-${i}`}>
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <span className="tnum">
                            {bill.dueDate ? bill.dueDate.split('-').reverse().join('/') : 'sem fatura'}
                          </span>
                          <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                            {bill.accountName} · {bill.count}
                          </span>
                        </th>
                        <td className="py-2 text-right">
                          <Money cents={bill.chargedCents} />
                          {diff !== null && diff !== 0 && (
                            <span className="tnum ml-2 text-[12px]" style={{ color: 'var(--warn)' }}>
                              fatura {formatBRL(bill.reportedTotalCents!)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {committed > 0 && (
              <section>
                <h2 className="mb-1 font-serif text-xl">Parcelas a vencer</h2>
                <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                  Já comprado, ainda não faturado. Não entra nos totais acima.
                </p>
                <p className="tnum text-[20px]"><Money cents={committed} /></p>
                <ul className="mt-3 space-y-1.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                  {open.slice(0, 6).map((r, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{r.description}</span>
                      <span className="tnum shrink-0">
                        faltam {r.remainingCount} de {r.totalInstallments} · {formatBRL(r.remainingCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}

      {b.topMerchants.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 font-serif text-xl">Onde mais gastou</h2>
          <ul className="grid gap-x-8 gap-y-1 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            {b.topMerchants.map((m) => (
              <li key={m.name} className="flex justify-between gap-3 border-b py-1.5" style={{ borderColor: 'var(--rule)' }}>
                <span className="truncate">{m.name}</span>
                <span className="shrink-0"><Money cents={m.cents} dim /></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
