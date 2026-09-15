import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getToday } from '../../queries/today';
import { getPacing } from '../../queries/pacing';
import { formatBRL } from '../../lib/money';
import { Money } from '../_components/Money';
import { CommittedMonths } from '../_components/CommittedMonths';
import { Pacing } from '../_components/Pacing';
import { ConnectionBanner } from '../_components/ConnectionBanner';
import { StaleNotice } from '../_components/StaleNotice';

export const dynamic = 'force-dynamic';

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function br(ymd: string) {
  return ymd.split('-').reverse().join('/');
}

function monthLabel(ym: string) {
  return `${MONTH_LABELS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}`;
}

function inDays(days: number) {
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  return `em ${days} dias`;
}

export default async function TodayPage() {
  const db = bootstrap(getDb());
  const t = getToday(db);
  const pacing = getPacing(db);

  const open = t.upcoming.find((b) => b.open);
  const scheduled = t.upcoming.filter((b) => !b.open);
  // Our itemized sum against the bank's own used-limit figure. They are different
  // bases and a gap is normal; showing it is how a wrong figure gets noticed.
  const gap = t.reportedUsedCents === null ? null : t.reportedUsedCents - t.unbilledTotalCents;

  return (
    <div className="mx-auto max-w-[1100px]">
      <ConnectionBanner />

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Hoje</h1>
        <p className="tnum text-[13px]" style={{ color: 'var(--ink-soft)' }}>
          {br(t.asOf)}
        </p>
      </div>

      <StaleNotice />

      <div className="grid gap-10 lg:grid-cols-2">
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 font-serif text-xl">Saldos</h2>
            <table className="ledger w-full text-[13px]">
              <caption className="sr-only">Saldo de cada conta</caption>
              <tbody>
                {t.balances.map((b) => (
                  <tr key={b.accountId}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="font-serif text-[15px]">{b.name ?? 'Conta'}</span>
                    </th>
                    {/* Not <Money>: it renders zero as an en dash meaning "nothing
                        happened", and an account that really holds R$ 0,00 is a fact. */}
                    <td className="tnum py-2 text-right" style={{ color: b.cents < 0 ? 'var(--alert)' : 'var(--ink)' }}>
                      {formatBRL(b.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {t.balances.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal" style={{ color: 'var(--ink-soft)' }}>
                      Total
                    </th>
                    <td className="tnum py-2 text-right">{formatBRL(t.balanceTotalCents)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            {t.balances.length === 0 && (
              <p className="text-[13px]" style={{ color: 'var(--ink-faint)' }}>
                Nenhuma conta corrente conectada.
              </p>
            )}
          </section>

          <section>
            <h2 className="mb-1 font-serif text-xl">Cartões</h2>
            <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              Limite usado e disponível, como o banco informou na última sincronização.
            </p>
            <div className="space-y-4">
              {t.cards.map((c) => (
                <div key={c.accountId}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-serif text-[15px]">{c.name ?? 'Cartão'}</span>
                    <span className="tnum text-[13px]" style={{ color: 'var(--ink-soft)' }}>
                      {c.usedCents === null ? '–' : formatBRL(c.usedCents)} usado
                    </span>
                  </div>
                  {c.freeShare !== null && (
                    <>
                      <div
                        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
                        style={{ background: 'rgb(var(--heat) / 0.12)' }}
                        role="img"
                        aria-label={`${Math.round((1 - c.freeShare) * 100)}% do limite usado`}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(1 - c.freeShare) * 100}%`, background: 'rgb(var(--heat) / 0.55)' }}
                        />
                      </div>
                      <p className="mt-1 tnum text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                        {formatBRL(c.availableCents!)} livres de {formatBRL(c.limitCents!)}
                      </p>
                    </>
                  )}
                </div>
              ))}
              {t.cards.length === 0 && (
                <p className="text-[13px]" style={{ color: 'var(--ink-faint)' }}>
                  Nenhum cartão conectado.
                </p>
              )}
            </div>
          </section>

          <Pacing pacing={pacing} />
        </div>

        <div className="space-y-10">
          <section>
            <h2 className="mb-1 font-serif text-xl">Próxima fatura</h2>
            <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              A Pluggy só devolve faturas já fechadas, então esta data é estimada a partir do
              histórico do cartão.
            </p>

            {open ? (
              <>
                <p className="font-serif text-[15px]">{open.accountName ?? 'Cartão'}</p>
                <p className="tnum mt-0.5 text-[13px]" style={{ color: 'var(--ink-soft)' }}>
                  {open.dueDate ? `vence ${br(open.dueDate)} · ${inDays(open.daysAway!)}` : 'sem data estimada'}
                  {open.closesOn && ` · fecha ${br(open.closesOn)}`}
                </p>
                <p className="mt-2 tnum text-[20px]">
                  <Money cents={open.chargedCents} />
                  {/* "até agora" is load-bearing: this cycle is still collecting charges. */}
                  <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                    até agora, em {open.count} {open.count === 1 ? 'lançamento' : 'lançamentos'}
                  </span>
                </p>
              </>
            ) : (
              <p className="text-[13px]" style={{ color: 'var(--ink-faint)' }}>
                Nada lançado ainda no ciclo aberto.
              </p>
            )}

            {scheduled.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                {scheduled.map((b, i) => (
                  <li key={`${b.accountId}-${b.dueDate ?? i}`} className="flex justify-between gap-3">
                    <span className="tnum">{b.dueDate ? br(b.dueDate) : 'sem data'}</span>
                    <span className="tnum shrink-0">
                      {formatBRL(b.chargedCents)}
                      <span className="ml-2" style={{ color: 'var(--ink-faint)' }}>
                        já agendado
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {gap !== null && t.unbilledTotalCents > 0 && (
              <p className="mt-4 text-[12px] leading-relaxed" style={{ color: gap === 0 ? 'var(--ink-faint)' : 'var(--warn)' }}>
                Somando tudo que ainda não foi faturado: {formatBRL(t.unbilledTotalCents)}. O banco
                informa {formatBRL(t.reportedUsedCents!)} de limite usado.
              </p>
            )}
          </section>

          {t.committed.length > 0 && (
            <section>
              <h2 className="mb-1 font-serif text-xl">Compromissos</h2>
              <p className="mb-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                Parcelas já agendadas pelo banco. Cada uma já está lançada no mês em que vai cair,
                então isto não é um gasto a mais — é o que o{' '}
                <Link href="/" className="underline underline-offset-2">
                  Mensal
                </Link>{' '}
                já mostra nos meses à frente.
              </p>
              <CommittedMonths months={t.committed} />
              {t.horizonMonth && (
                <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                  Agendado até {monthLabel(t.horizonMonth)}. A sincronização volta a pedir estas
                  linhas ao banco toda vez que roda, mas ainda não apaga sozinha uma parcela
                  cancelada — se um parcelamento for renegociado, este total pode ficar alto
                  até a próxima leitura completa.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
