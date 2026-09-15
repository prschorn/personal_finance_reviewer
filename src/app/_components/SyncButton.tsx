'use client';

import { useState, useTransition } from 'react';
import { syncNow } from '../actions';
import type { ActionResult } from '../actions';

export function SyncButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await syncNow('manual')))}
        className="shrink-0 rounded px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:opacity-60"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        {pending ? 'Buscando…' : 'Sincronizar'}
      </button>

      {result && (
        <div
          role="status"
          className="absolute right-0 top-11 z-40 w-80 rounded border p-3 text-[13px] shadow-lg"
          style={{
            borderColor: result.ok ? 'var(--rule)' : 'var(--alert)',
            background: 'var(--surface)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="tnum" style={{ color: result.ok ? 'var(--ink)' : 'var(--alert)' }}>
              {result.message}
            </p>
            <button
              type="button"
              onClick={() => setResult(null)}
              aria-label="Fechar"
              style={{ color: 'var(--ink-faint)' }}
            >
              ✕
            </button>
          </div>

          {result.detail?.length ? (
            <ul className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: 'var(--rule)' }}>
              {result.detail.map((line, i) => (
                <li key={i} style={{ color: 'var(--warn)' }}>
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
