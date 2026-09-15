'use client';

import { useEffect, useState } from 'react';
import type { DrillDownRow } from '../../queries/matrix';
import { Money } from './Money';
import { CategoryPicker } from './CategoryPicker';

/**
 * The transactions behind one cell.
 *
 * A side panel rather than a modal, so the grid stays visible: the point of
 * opening a cell is to check a figure against its context, not to leave it.
 */
export function DrillDown({
  url, categoryId, title, subtitle, onClose,
}: {
  /** Endpoint returning DrillDownRow[]. Lets the monthly grid and the cards page share this panel. */
  url: string;
  /** Current category, for the picker. Null on the "Sem categoria" row. */
  categoryId: number | null;
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DrillDownRow[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    fetch(url)
      .then((r) => r.json())
      .then((data: DrillDownRow[]) => alive && setRows(Array.isArray(data) ? data : []))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [url]);

  const total = rows?.reduce((sum, r) => sum + r.cents, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${title}, ${subtitle}`}>
      <button type="button" className="flex-1 bg-black/25" onClick={onClose} aria-label="Fechar detalhes" />

      <aside
        className="flex h-full w-full max-w-lg flex-col border-l shadow-2xl"
        style={{ background: 'var(--surface)', borderColor: 'var(--rule)' }}
      >
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--rule)' }}>
          <div>
            <h2 className="font-serif text-xl leading-tight">{title}</h2>
            <p className="mt-0.5 text-[13px]" style={{ color: 'var(--ink-soft)' }}>
              {subtitle}
              {rows !== null && (
                <>
                  {' · '}
                  <Money cents={total} />
                  {' · '}
                  {rows.length} {rows.length === 1 ? 'lançamento' : 'lançamentos'}
                </>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-lg" style={{ color: 'var(--ink-faint)' }} aria-label="Fechar">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {rows === null ? (
            <p className="p-5 text-[13px]" style={{ color: 'var(--ink-soft)' }}>Carregando…</p>
          ) : rows.length === 0 ? (
            <p className="p-5 text-[13px]" style={{ color: 'var(--ink-soft)' }}>Nenhum lançamento.</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.id} className="border-b px-5 py-3" style={{ borderColor: 'var(--rule)' }}>
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-[14px] leading-snug">{row.description ?? row.merchantName ?? '—'}</p>
                    <Money cents={row.cents} />
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: 'var(--ink-faint)' }}>
                    <span className="tnum">{row.postedOn.split('-').reverse().join('/')}</span>
                    <span>{row.accountName ?? row.accountType}</span>
                    {row.installment && <span className="tnum">parcela {row.installment}</span>}
                    {row.status === 'PENDING' && <span style={{ color: 'var(--warn)' }}>não faturado</span>}
                    {row.categorySource === 'manual' && <span>categoria manual</span>}
                  </div>

                  <div className="mt-2">
                    <CategoryPicker
                      fingerprint={row.fingerprint}
                      currentId={categoryId}
                      currentName={title}
                      isGuess={row.categorySource === 'default'}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
