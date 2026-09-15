'use client';

import { useEffect, useState, useTransition } from 'react';
import { categorizeAllLike, categorizeOnlyThis, markInternal } from '../actions';
import type { ActionResult } from '../actions';

interface Option {
  id: number;
  name: string;
}

/**
 * The category list is identical for every row, so it is fetched ONCE per page
 * and shared. Without the in-flight promise below, a 300-row list would fire 300
 * parallel requests before the first one resolved.
 */
let cache: Option[] | null = null;
let inFlight: Promise<Option[]> | null = null;

function loadCategories(): Promise<Option[]> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= fetch('/api/categories')
    .then((r) => r.json())
    .then((data: Option[]) => {
      cache = data;
      inFlight = null;
      return data;
    })
    .catch(() => {
      inFlight = null;
      return [];
    });
  return inFlight;
}

export function CategoryPicker({
  fingerprint,
  currentId,
  showInternal = true,
}: {
  fingerprint: string;
  currentId: number | null;
  showInternal?: boolean;
}) {
  const [options, setOptions] = useState<Option[]>(cache ?? []);
  const [pending, start] = useTransition();
  /** What the last action did, so the scope of the change is never a surprise. */
  const [result, setResult] = useState<ActionResult | null>(null);
  /** Remembers the pick so "só esta" can narrow it without re-selecting. */
  const [lastPick, setLastPick] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadCategories().then((data) => alive && setOptions(data));
    return () => {
      alive = false;
    };
  }, []);

  const control = {
    borderColor: 'var(--rule-strong)',
    background: 'var(--surface)',
    color: 'var(--ink)',
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      {options.length === 0 ? (
        // A controlled <select> whose value has no matching <option> silently
        // displays the wrong row, so wait until the list is actually here.
        <span className="rounded border px-2 py-1" style={{ ...control, color: 'var(--ink-faint)' }}>
          Carregando categorias…
        </span>
      ) : (
        <select
          value={currentId ?? ''}
          disabled={pending}
          aria-label="Categoria"
          onChange={(e) => {
            const value = e.target.value ? Number(e.target.value) : null;
            setLastPick(value);
            // Default is "everything like this", which is almost always what you
            // mean when you correct a merchant's category.
            start(async () => setResult(await categorizeAllLike(fingerprint, value)));
          }}
          className="rounded border px-2 py-1"
          style={control}
        >
          <option value="">Sem categoria</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}

      {showInternal && (
        <button
          type="button"
          disabled={pending}
          onClick={() => start(() => markInternal(fingerprint, true).then(() => undefined))}
          className="rounded border px-2 py-1 disabled:opacity-50"
          style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-soft)' }}
          title="Não contar como gasto (dinheiro que só mudou de lugar)"
        >
          É transferência
        </button>
      )}

      {result && (
        <span className="flex flex-wrap items-center gap-2">
          <span style={{ color: result.ok ? 'var(--accent)' : 'var(--alert)' }}>{result.message}</span>
          {result.detail?.map((line, i) => (
            <span key={i} style={{ color: 'var(--warn)' }}>
              {line}
            </span>
          ))}
          {lastPick !== null && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => setResult(await categorizeOnlyThis(fingerprint, lastPick)))
              }
              className="underline disabled:opacity-50"
              style={{ color: 'var(--ink-faint)' }}
              title="Aplicar só a este lançamento e desfazer a regra"
            >
              só esta
            </button>
          )}
        </span>
      )}
    </div>
  );
}
