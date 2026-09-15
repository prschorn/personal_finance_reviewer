'use client';

import { useEffect, useState, useTransition } from 'react';
import { categorizeTransaction, markInternal } from '../actions';

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
  const [saved, setSaved] = useState(false);

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
            start(async () => {
              await categorizeTransaction(fingerprint, value);
              setSaved(true);
              setTimeout(() => setSaved(false), 1600);
            });
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

      {saved && <span style={{ color: 'var(--accent)' }}>salvo</span>}
    </div>
  );
}
