'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SyncButton } from './SyncButton';

const LINKS = [
  { href: '/', label: 'Mensal' },
  { href: '/dashboard', label: 'Painel' },
  { href: '/cards', label: 'Cartões' },
  { href: '/transactions', label: 'Transações' },
  { href: '/internal', label: 'Transferências' },
  { href: '/rules', label: 'Regras' },
  { href: '/settings', label: 'Ajustes' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header
      className="sticky top-0 z-30 border-b px-5 backdrop-blur sm:px-8"
      style={{ borderColor: 'var(--rule)', background: 'color-mix(in srgb, var(--paper) 88%, transparent)' }}
    >
      <nav className="flex h-14 items-center gap-1">
        <Link href="/" className="mr-5 font-serif text-lg tracking-tight" style={{ color: 'var(--ink)' }}>
          Finanças
        </Link>

        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className="shrink-0 rounded px-2.5 py-1.5 text-[13px] transition-colors"
                style={{
                  color: active ? 'var(--ink)' : 'var(--ink-soft)',
                  background: active ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        <SyncButton />
      </nav>
    </header>
  );
}
