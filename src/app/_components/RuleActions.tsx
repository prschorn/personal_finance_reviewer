'use client';

import { useState, useTransition } from 'react';
import { removeRule, toggleRule } from '../actions';
import type { ActionResult } from '../actions';

/**
 * Remove or disable one rule.
 *
 * Rules you created can be removed outright. Rules shipped with the app are
 * disabled instead: deleting one would not stick, because seeding re-inserts
 * anything missing by name the next time the app starts.
 */
export function RuleActions({
  id,
  origin,
  enabled,
  name,
}: {
  id: number;
  origin: string;
  enabled: boolean;
  name: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const button = {
    borderColor: 'var(--rule-strong)',
    color: 'var(--ink-soft)',
  };

  return (
    <span className="flex flex-wrap items-center gap-2 text-[12px]">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await toggleRule(id, !enabled)))}
        className="rounded border px-2 py-0.5 disabled:opacity-50"
        style={button}
      >
        {enabled ? 'Desativar' : 'Ativar'}
      </button>

      {origin === 'user' &&
        (confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setResult(await removeRule(id));
                  setConfirming(false);
                })
              }
              className="rounded border px-2 py-0.5 disabled:opacity-50"
              style={{ borderColor: 'var(--alert)', color: 'var(--alert)' }}
            >
              {pending ? 'Removendo…' : 'Confirmar'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} style={{ color: 'var(--ink-faint)' }}>
              cancelar
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="rounded border px-2 py-0.5 disabled:opacity-50"
            style={button}
            title={`Remover a regra "${name}"`}
          >
            Remover
          </button>
        ))}

      {result && (
        <span style={{ color: result.ok ? 'var(--accent)' : 'var(--alert)' }}>{result.message}</span>
      )}
    </span>
  );
}
