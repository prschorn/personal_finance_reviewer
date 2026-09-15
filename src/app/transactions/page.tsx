import Link from 'next/link';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { countByFilter, listTransactions, type TransactionFilter } from '../../queries/transactions';
import { Movement } from '../_components/Money';
import { CategoryPicker } from '../_components/CategoryPicker';

export const dynamic = 'force-dynamic';

const FILTERS: { key: TransactionFilter; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'sem-regra', label: 'Sem regra' },
  { key: 'nao-faturadas', label: 'Não faturadas' },
  { key: 'duplicadas', label: 'Possíveis duplicatas' },
];

const EMPTY: Record<TransactionFilter, { title: string; body: string }> = {
  todas: { title: 'Nenhuma transação', body: 'Sincronize para buscar os dados das suas contas.' },
  'sem-regra': {
    title: 'Toda transação tem uma regra',
    body: 'Nenhum lançamento está usando a categoria padrão. Os números do Mensal vêm todos de regras ou de escolhas suas.',
  },
  'nao-faturadas': { title: 'Nada em aberto', body: 'Todas as transações já foram faturadas pelo banco.' },
  duplicadas: { title: 'Nenhuma duplicata', body: 'Cada transação aparece uma única vez. Os totais são confiáveis.' },
};

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; q?: string }>;
}) {
  const db = bootstrap(getDb());
  const params = await searchParams;

  const filter = (FILTERS.find((f) => f.key === params.filtro)?.key ?? 'todas') as TransactionFilter;
  const search = params.q ?? '';
  const rows = listTransactions(db, { filter, search });
  const counts = countByFilter(db);

  return (
    <div className="mx-auto max-w-[1100px]">
      <h1 className="mb-5 font-serif text-4xl leading-none tracking-tight">Transações</h1>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/transactions?filtro=${f.key}`}
            className="rounded px-2.5 py-1 text-[13px]"
            style={{
              color: f.key === filter ? 'var(--ink)' : 'var(--ink-soft)',
              background: f.key === filter ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {f.label}{' '}
            <span className="tnum" style={{ color: 'var(--ink-faint)' }}>
              {counts[f.key]}
            </span>
          </Link>
        ))}

        <form className="ml-auto" action="/transactions">
          <input type="hidden" name="filtro" value={filter} />
          <input
            name="q"
            defaultValue={search}
            placeholder="Buscar descrição"
            aria-label="Buscar descrição"
            className="rounded border px-2.5 py-1.5 text-[13px]"
            style={{ borderColor: 'var(--rule-strong)', background: 'var(--surface)', color: 'var(--ink)' }}
          />
        </form>
      </div>

      {filter === 'sem-regra' && rows.length > 0 && (
        <p className="mb-4 rounded border px-3 py-2 text-[13px]"
          style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          Nenhuma regra combinou com estes lançamentos, então o app chutou: saídas foram para Outros e
          entradas para Receitas. A categoria que aparece abaixo é esse chute — escolha a certa e o app
          cria uma regra para todos os meses.
        </p>
      )}

      {filter === 'duplicadas' && counts.duplicadas > 0 && (
        <p className="mb-4 rounded border px-3 py-2 text-[13px]"
          style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          Estas transações compartilham a mesma identidade. Provavelmente o mesmo lançamento entrou duas vezes,
          o que infla o mês. Marque a repetida como transferência para tirá-la dos totais.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="mt-16 max-w-md">
          <h2 className="font-serif text-2xl">{EMPTY[filter].title}</h2>
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            {EMPTY[filter].body}
          </p>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="border-b py-3" style={{ borderColor: 'var(--rule)' }}>
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-[14px] leading-snug">{row.description ?? row.merchantName ?? '—'}</p>
                <Movement signedCents={row.signedCents} muted={row.isInternal} />
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                <span className="tnum">{row.postedOn.split('-').reverse().join('/')}</span>
                <span>{row.accountName ?? row.accountType}</span>
                {row.categoryName && (
                  <span>
                    {row.categoryName}
                    {row.categorySource === 'default' && (
                      <span style={{ color: 'var(--warn)' }}> · sem regra</span>
                    )}
                  </span>
                )}
                {row.installment && <span className="tnum">parcela {row.installment}</span>}
                {row.status === 'PENDING' && <span style={{ color: 'var(--warn)' }}>não faturada</span>}
                {row.isInternal && <span style={{ color: 'var(--accent)' }}>transferência, fora dos totais</span>}
                {row.categorySource === 'manual' && <span>categoria manual</span>}
              </div>

              <div className="mt-2">
                <CategoryPicker
                  fingerprint={row.fingerprint}
                  currentId={row.categoryId}
                  currentName={row.categoryName}
                  isGuess={row.categorySource === 'default'}
                  showInternal={!row.isInternal}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
