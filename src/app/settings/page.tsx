import { getDb } from '../../db/client';
import { bootstrap, configuredItemIds } from '../../db/bootstrap';
import { getConnections, getRecentRuns, getSyncStatus } from '../../queries/status';
import { getOwnIdentifiers } from '../../config/own';
import { SettingsForms } from '../_components/SettingsForms';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const db = bootstrap(getDb());

  const connections = getConnections(db);
  const status = getSyncStatus(db);
  const runs = getRecentRuns(db, 8);
  const own = getOwnIdentifiers(db);
  const hasCredentials = !!(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
  const envItemIds = configuredItemIds();

  return (
    <div className="mx-auto max-w-[760px] space-y-10">
      <div>
        <h1 className="mb-1 font-serif text-4xl leading-none tracking-tight">Ajustes</h1>
        <p className="text-[14px]" style={{ color: 'var(--ink-soft)' }}>
          Tudo fica neste computador, em <code className="text-[13px]">db/finance.db</code>.
        </p>
      </div>

      {!hasCredentials && (
        <section className="rounded border px-4 py-3" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}>
          <h2 className="mb-1 font-serif text-lg" style={{ color: 'var(--warn)' }}>Faltam as credenciais da Pluggy</h2>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--warn)' }}>
            Crie uma conta de desenvolvedor em dashboard.pluggy.ai, copie{' '}
            <code>.env.local.example</code> para <code>.env.local</code> e preencha{' '}
            <code>PLUGGY_CLIENT_ID</code> e <code>PLUGGY_CLIENT_SECRET</code>. Depois reinicie o app.
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-1 font-serif text-xl">Conexões</h2>
        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          No plano gratuito a Pluggy não lista suas conexões pela API, então o ID de cada uma precisa ser
          informado aqui. Conecte o banco em{' '}
          <a href="https://meu.pluggy.ai" target="_blank" rel="noreferrer" className="underline">meu.pluggy.ai</a>{' '}
          e cole o ID da conexão.
        </p>

        {connections.length === 0 ? (
          <p className="mb-3 text-[13px]" style={{ color: 'var(--ink-faint)' }}>Nenhuma conexão ainda.</p>
        ) : (
          <ul className="mb-3">
            {connections.map((c) => (
              <li key={c.itemId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b py-2.5" style={{ borderColor: 'var(--rule)' }}>
                <div className="min-w-0">
                  <p className="font-serif text-[15px]">{c.connectorName ?? 'Conexão'}</p>
                  <p className="truncate font-mono text-[11px]" style={{ color: 'var(--ink-faint)' }}>{c.itemId}</p>
                </div>
                <div className="text-right text-[12px]" style={{ color: c.needsAttention ? 'var(--warn)' : 'var(--ink-faint)' }}>
                  <p>{c.status ?? 'nunca sincronizada'}{c.accountCount > 0 && ` · ${c.accountCount} contas`}</p>
                  {c.consentExpiresAt && <p className="tnum">consentimento até {c.consentExpiresAt.slice(0, 10).split('-').reverse().join('/')}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {envItemIds.length > 0 && (
          <p className="mb-3 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
            Também lendo de PLUGGY_ITEM_IDS: {envItemIds.length}
          </p>
        )}

        <SettingsForms own={own} />
      </section>

      <section>
        <h2 className="mb-1 font-serif text-xl">Sincronização</h2>
        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          A Pluggy atualiza suas contas sozinha, uma vez por dia. Este app apenas busca o que já está lá:
          ao abrir, se a última busca tiver mais de 6 horas, e sempre que você clicar em Sincronizar.
        </p>
        <p className="mb-3 text-[13px]">
          {status.everSynced ? (
            <>Última busca bem-sucedida: <span className="tnum">{status.lastSuccessAt?.replace('T', ' ').slice(0, 16)}</span></>
          ) : (
            'Ainda não sincronizado.'
          )}
        </p>

        {runs.length > 0 && (
          <ul className="text-[12px]">
            {runs.map((run) => (
              <li key={run.id} className="flex justify-between gap-4 border-b py-1.5" style={{ borderColor: 'var(--rule)' }}>
                <span className="tnum" style={{ color: 'var(--ink-faint)' }}>{run.startedAt.replace('T', ' ').slice(0, 16)}</span>
                <span style={{ color: run.status === 'ok' ? 'var(--ink-soft)' : 'var(--warn)' }}>
                  {run.status === 'ok' ? 'concluída' : run.status === 'partial' ? 'parcial' : run.status === 'running' ? 'em andamento' : 'falhou'}
                  {run.trigger === 'auto' && ' · automática'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
