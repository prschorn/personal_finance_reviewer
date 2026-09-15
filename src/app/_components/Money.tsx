import { formatBRL } from '../../lib/money';

/**
 * Empty cells show an en dash, never "R$ 0,00".
 * A zero asserts "nothing was spent here"; a dash says "nothing is recorded here".
 * In a grid that is mostly empty early in the year, that distinction is the
 * difference between a readable table and a wall of noise.
 */
export function Money({ cents, dim = false }: { cents: number; dim?: boolean }) {
  if (cents === 0) {
    return (
      <span className="tnum" style={{ color: 'var(--ink-faint)' }} aria-label="sem lançamentos">
        –
      </span>
    );
  }
  return (
    <span
      className="tnum"
      style={{ color: cents < 0 ? 'var(--alert)' : dim ? 'var(--ink-soft)' : 'var(--ink)' }}
    >
      {formatBRL(cents)}
    </span>
  );
}

/** Compact form for dense grid cells: thousands as "1,2 mil". */
export function CompactMoney({ cents }: { cents: number }) {
  if (cents === 0) {
    return (
      <span className="tnum" style={{ color: 'var(--ink-faint)' }} aria-label="sem lançamentos">
        –
      </span>
    );
  }
  const negative = cents < 0;
  const reais = Math.abs(cents) / 100;
  const text =
    reais >= 1000
      ? `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`
      : reais.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

  return (
    <span className="tnum" style={{ color: negative ? 'var(--alert)' : 'inherit' }}>
      {negative ? '−' : ''}
      {text}
    </span>
  );
}

/**
 * One movement in a transaction list, shown the way it happened: money in carries
 * a + and reads as income, money out carries a −.
 *
 * Deliberately different from the matrix, which flips the sign so spending reads
 * as a positive magnitude. There, every figure is spending and the sign is noise;
 * here the direction is the point.
 */
export function Movement({ signedCents, muted = false }: { signedCents: number; muted?: boolean }) {
  const income = signedCents > 0;
  return (
    <span
      className="tnum whitespace-nowrap"
      style={{ color: muted ? 'var(--ink-faint)' : income ? 'var(--positive)' : 'var(--ink)' }}
    >
      {income ? '+' : '−'}
      {formatBRL(Math.abs(signedCents)).replace('-', '')}
    </span>
  );
}

/**
 * Compact figure that keeps its sign and does not colour itself.
 *
 * Used for Saldo, where a negative is the point rather than an anomaly, and the
 * row decides the colour.
 */
export function SignedCompact({ cents }: { cents: number }) {
  if (cents === 0) {
    return (
      <span className="tnum" style={{ color: 'var(--ink-faint)' }} aria-label="sem lançamentos">
        –
      </span>
    );
  }
  const reais = Math.abs(cents) / 100;
  const text =
    reais >= 1000
      ? `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`
      : reais.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  return (
    <span className="tnum">
      {cents < 0 ? '−' : '+'}
      {text}
    </span>
  );
}
