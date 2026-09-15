'use client';

import { useTransition } from 'react';
import { markInternal } from '../actions';

export function UnmarkInternal({ fingerprint }: { fingerprint: string }) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => markInternal(fingerprint, false).then(() => undefined))}
      className="shrink-0 rounded border px-2 py-1 text-[12px] disabled:opacity-50"
      style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-soft)' }}
    >
      {pending ? 'Salvando…' : 'Contar como gasto'}
    </button>
  );
}
