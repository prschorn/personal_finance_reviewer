'use client';

import { useState, useTransition } from 'react';
import { markReviewed, type ActionResult } from '../actions';

/**
 * Clearing the queue is a button, not a side effect of arriving.
 *
 * Marking on visit would lose a digest to a stray click, and this app's habit is
 * that a state change is explicit and reports what it did.
 */
export function ReviewActions({ total }: { total: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending || total === 0}
        onClick={() => start(async () => setResult(await markReviewed()))}
        className="rounded px-3 py-1.5 text-[13px] transition-colors disabled:opacity-45"
        style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
      >
        {pending ? 'Marcando…' : 'Marcar como revisado'}
      </button>
      {result && (
        <span role="status" className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
          {result.message}
        </span>
      )}
    </div>
  );
}
