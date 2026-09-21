'use client';

import { useState, useTransition } from 'react';
import { addItemId, saveOwnIdentifiers } from '../actions';
import type { OwnIdentifiers } from '../../config/own';

export function SettingsForms({ own }: { own: OwnIdentifiers }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const field = {
    borderColor: 'var(--rule-strong)',
    background: 'var(--surface)',
    color: 'var(--ink)',
  };

  return (
    <div className="space-y-8">
      <form
        action={(form) => start(async () => setMessage((await addItemId(form)).message))}
        className="flex flex-wrap gap-2"
      >
        <input
          name="itemId"
          placeholder="ID da conexão (UUID)"
          aria-label="ID da conexão"
          className="flex-1 rounded border px-2.5 py-1.5 font-mono text-[12px]"
          style={field}
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded px-3 py-1.5 text-[13px] font-medium disabled:opacity-60"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Adicionar
        </button>
      </form>

      <form action={(form) => start(async () => setMessage((await saveOwnIdentifiers(form)).message))}>
        <h2 className="mb-1 font-serif text-xl">Seus identificadores</h2>
        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          Preencher isto é o que mais melhora a detecção de transferências entre suas próprias contas.
          Sem estes dados o app depende de adivinhar pela descrição, e pode errar nos dois sentidos.
          Separe por vírgula.
        </p>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[13px]" style={{ color: 'var(--ink-soft)' }}>CPF e CNPJ</span>
            <input
              name="documents"
              defaultValue={own.documents.join(', ')}
              placeholder="12345678901, 12345678000199"
              className="mt-1 w-full rounded border px-2.5 py-1.5 text-[13px]"
              style={field}
            />
          </label>

          <label className="block">
            <span className="text-[13px]" style={{ color: 'var(--ink-soft)' }}>Chaves Pix</span>
            <input
              name="pixKeys"
              defaultValue={own.pixKeys.join(', ')}
              placeholder="voce@email.com, +5511999999999"
              className="mt-1 w-full rounded border px-2.5 py-1.5 text-[13px]"
              style={field}
            />
          </label>

          <label className="block">
            <span className="text-[13px]" style={{ color: 'var(--ink-soft)' }}>Como seu nome aparece</span>
            <input
              name="nameFragments"
              defaultValue={own.nameFragments.join(', ')}
              placeholder="FULANO"
              className="mt-1 w-full rounded border px-2.5 py-1.5 text-[13px]"
              style={field}
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="mt-3 rounded px-3 py-1.5 text-[13px] font-medium disabled:opacity-60"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {pending ? 'Salvando…' : 'Salvar'}
        </button>
      </form>

      {message && (
        <p role="status" className="text-[13px]" style={{ color: 'var(--accent)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
