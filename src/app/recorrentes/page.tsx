import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { getRecurring, type RecurringSeries } from '../../queries/recurring';
import { formatBRL } from '../../lib/money';
import { RecurringTable } from '../_components/RecurringTable';

export const dynamic = 'force-dynamic';

const byKind = (series: RecurringSeries[], kind: 'fixo' | 'variavel') =>
  series.filter((s) => s.kind === kind && s.status !== 'parada');

export default async function RecurringPage() {
  const db = bootstrap(getDb());
  const r = getRecurring(db);

  const fixed = byKind(r.outgoing, 'fixo');
  const variable = byKind(r.outgoing, 'variavel');
  const stopped = r.outgoing.filter((s) => s.status === 'parada');
  const income = r.incoming.filter((s) => s.status !== 'parada');
  const changed = r.outgoing.filter((s) => s.priceChange).length;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Recorrentes</h1>
        {fixed.length > 0 && (
          <p className="tnum text-[15px]" style={{ color: 'var(--ink-soft)' }}>
            {formatBRL(r.monthlyTotalCents)} por mês · {formatBRL(r.annualTotalCents)} por ano
          </p>
        )}
      </div>

      <p className="mb-8 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
        Encontrado pelo padrão de cobrança, não por uma lista de nomes — por isso aparecem
        serviços que nenhuma regra conhece. Nada aqui muda categoria de nada.
        {r.ungroupableCount > 0 && (
          <> {r.ungroupableCount} lançamentos têm descrição curta demais para agrupar e ficaram de fora.</>
        )}
      </p>

      {r.outgoing.length === 0 && r.incoming.length === 0 ? (
        <div className="mt-16 max-w-md">
          <h2 className="font-serif text-2xl">Nada recorrente ainda</h2>
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            Uma cobrança precisa aparecer em três meses antes de virar uma série aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {fixed.length > 0 && (
            <section>
              <h2 className="mb-1 font-serif text-xl">Preço fixo</h2>
              <p className="mb-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                Cobram o mesmo valor todo mês, então esse valor é um compromisso: some
                {' '}{formatBRL(r.monthlyTotalCents)} por mês. {changed > 0 && `${changed} mudaram de preço.`}
              </p>
              <RecurringTable series={fixed} caption="Cobranças recorrentes de preço fixo" />
            </section>
          )}

          {variable.length > 0 && (
            <section>
              <h2 className="mb-1 font-serif text-xl">Valor variável</h2>
              <p className="mb-3 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                Voltam todo mês mas nunca pelo mesmo valor — luz, condomínio, o restaurante de
                sempre. {formatBRL(r.variableMonthlyCents)} num mês típico, somando as medianas.
                É um hábito, não um compromisso, e por isso fica fora do total acima.
              </p>
              <RecurringTable series={variable} caption="Cobranças recorrentes de valor variável" />
            </section>
          )}

          {income.length > 0 && (
            <section>
              <h2 className="mb-1 font-serif text-xl">Entradas recorrentes</h2>
              <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                O que entra com a mesma regularidade. Útil para notar um recebimento que falhou.
              </p>
              <RecurringTable series={income} caption="Entradas recorrentes" />
            </section>
          )}

          {stopped.length > 0 && (
            <section>
              <h2 className="mb-1 font-serif text-xl">Pararam</h2>
              <p className="mb-3 max-w-2xl text-[12px] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
                Vinham todo mês e passaram um mês inteiro sem aparecer. Pode ser um cancelamento
                que você fez, ou um que você não fez.
              </p>
              <RecurringTable series={stopped} caption="Séries que pararam de aparecer" />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
