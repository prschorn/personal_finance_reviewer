import { asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { bootstrap } from '../../db/bootstrap';
import { categories, rules } from '../../db/schema';
import { RuleActions } from '../_components/RuleActions';

export const dynamic = 'force-dynamic';

const MATCH_LABEL: Record<string, string> = {
  contains: 'contém',
  equals: 'é exatamente',
  startsWith: 'começa com',
  regex: 'casa com o padrão',
};

const FIELD_LABEL: Record<string, string> = {
  search_text: 'descrição',
  description: 'descrição',
  description_raw: 'descrição original',
  merchant_name: 'estabelecimento',
};

export default async function RulesPage() {
  const db = bootstrap(getDb());

  const rows = db
    .select({
      id: rules.id,
      priority: rules.priority,
      name: rules.name,
      matchField: rules.matchField,
      matchType: rules.matchType,
      matchValue: rules.matchValue,
      accountType: rules.accountType,
      direction: rules.direction,
      setInternal: rules.setInternal,
      categoryName: categories.name,
      enabled: rules.enabled,
      origin: rules.origin,
    })
    .from(rules)
    .leftJoin(categories, eq(categories.id, rules.setCategoryId))
    .orderBy(asc(rules.priority), desc(sql`length(${rules.matchValue})`), asc(rules.id))
    .all();

  return (
    <div className="mx-auto max-w-[900px]">
      <h1 className="mb-1 font-serif text-4xl leading-none tracking-tight">Regras</h1>
      <p className="mb-6 max-w-2xl text-[14px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
        A primeira regra que combinar decide a categoria, de cima para baixo. Quando você escolhe a categoria
        de um lançamento, o app cria aqui uma regra <strong className="font-medium">suas</strong> no topo da
        lista, e ela vale para todos os meses. Para mudar as regras que vêm com o app, edite{' '}
        <code className="text-[13px]">src/categorize/seed-rules.ts</code> e reinicie. Elas aparecem abaixo
        na ordem em que são avaliadas: a mais específica vence quando duas têm a mesma prioridade.
      </p>

      <ol className="ledger">
        {rows.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2.5" style={{ borderColor: 'var(--rule)', opacity: rule.enabled ? 1 : 0.45 }}>
            <span className="tnum w-8 shrink-0 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              {rule.priority}
            </span>

            <span className="font-serif text-[15px]">{rule.name}</span>
            {rule.origin === 'user' && (
              <span
                className="rounded px-1.5 py-0.5 text-[11px]"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                sua
              </span>
            )}

            <span className="text-[12px]" style={{ color: 'var(--ink-faint)' }}>
              {FIELD_LABEL[rule.matchField] ?? rule.matchField} {MATCH_LABEL[rule.matchType] ?? 'combina com'}{' '}
              <code style={{ color: 'var(--ink-soft)' }}>{rule.matchValue}</code>
              {rule.accountType === 'CREDIT' && ' · só no cartão'}
              {rule.accountType === 'BANK' && ' · só na conta'}
              {rule.direction === 'in' && ' · só entradas'}
              {rule.direction === 'out' && ' · só saídas'}
            </span>

            <span className="ml-auto text-[13px]" style={{ color: rule.setInternal ? 'var(--accent)' : 'var(--ink)' }}>
              {rule.setInternal ? 'transferência' : (rule.categoryName ?? '—')}
            </span>

            <RuleActions id={rule.id} origin={rule.origin} enabled={rule.enabled} name={rule.name} />
          </li>
        ))}
      </ol>
    </div>
  );
}
