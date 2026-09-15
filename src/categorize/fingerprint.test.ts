import { describe, it, expect } from 'vitest';
import { fingerprint, anchorDate, descriptionKey } from './fingerprint';

const base = {
  accountId: 'acc-1',
  postedOn: '2026-03-10',
  amountCents: 5432,
  searchText: 'MERCADO EXTRA',
};

describe('fingerprint stability', () => {
  it('is deterministic', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('is short and hex', () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  // The volatile parts of a description must not affect identity.
  it('ignores NSU / authorization codes in the description', () => {
    expect(fingerprint({ ...base, searchText: 'MERCADO EXTRA NSU 998877665544' })).toBe(
      fingerprint({ ...base, searchText: 'MERCADO EXTRA NSU 112233445566' }),
    );
  });

  it('ignores whitespace differences', () => {
    expect(fingerprint({ ...base, searchText: 'MERCADO   EXTRA' })).toBe(fingerprint(base));
  });
});

describe('fingerprint discrimination', () => {
  it('changes with the amount', () => {
    expect(fingerprint({ ...base, amountCents: 5433 })).not.toBe(fingerprint(base));
  });

  it('changes with the account', () => {
    expect(fingerprint({ ...base, accountId: 'acc-2' })).not.toBe(fingerprint(base));
  });

  it('changes with a materially different description', () => {
    expect(fingerprint({ ...base, searchText: 'PADARIA' })).not.toBe(fingerprint(base));
  });

  // Two identical purchases on one day collide deliberately: an override should
  // apply to both. Disambiguating by sequence would be unstable across recreates
  // and could let an override jump to the wrong twin.
  it('collides for genuine same-day twins, by design', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });
});

describe('card purchase anchoring', () => {
  it('survives a posting-date shift when a purchase date is present', () => {
    const pending = { ...base, postedOn: '2026-03-10', ccPurchaseDate: '2026-03-08T00:00:00.000Z' };
    const posted = { ...base, postedOn: '2026-03-12', ccPurchaseDate: '2026-03-08T00:00:00.000Z' };
    expect(fingerprint(pending)).toBe(fingerprint(posted));
  });

  it('falls back to postedOn without a purchase date', () => {
    expect(anchorDate({ postedOn: '2026-03-10' })).toBe('2026-03-10');
    expect(anchorDate({ postedOn: '2026-03-10', ccPurchaseDate: null })).toBe('2026-03-10');
  });

  it('uses the local calendar date of the purchase', () => {
    expect(anchorDate({ postedOn: '2026-03-12', ccPurchaseDate: '2026-03-08T00:00:00.000Z' })).toBe('2026-03-08');
  });

  it('degrades to postedOn rather than throwing on a malformed purchase date', () => {
    expect(anchorDate({ postedOn: '2026-03-10', ccPurchaseDate: 'garbage' })).toBe('2026-03-10');
  });

  // Without a purchase date, a posting shift DOES change identity — that is what
  // the rescue pass in sync/reconcile exists to repair.
  it('changes on a posting shift when there is no purchase date', () => {
    expect(fingerprint({ ...base, postedOn: '2026-03-12' })).not.toBe(fingerprint(base));
  });
});

describe('installments', () => {
  const purchase = { ...base, ccPurchaseDate: '2026-03-08T00:00:00.000Z' };

  // Every installment of one purchase shares account, purchase date, per-installment
  // amount and description. Without the installment number they collapse into one
  // identity, and a manual category on installment 3 leaks onto all ten.
  it('gives each installment of one purchase its own identity', () => {
    const ids = [1, 2, 3, 10].map((n) => fingerprint({ ...purchase, ccInstallmentNumber: n }));
    expect(new Set(ids).size).toBe(4);
  });

  it('keeps each installment stable across a posting-date shift', () => {
    const pending = fingerprint({ ...purchase, postedOn: '2026-04-10', ccInstallmentNumber: 3 });
    const posted = fingerprint({ ...purchase, postedOn: '2026-04-14', ccInstallmentNumber: 3 });
    expect(pending).toBe(posted);
  });

  it('leaves single-payment purchases unchanged', () => {
    expect(fingerprint({ ...base, ccInstallmentNumber: null })).toBe(fingerprint(base));
    expect(fingerprint({ ...base, ccInstallmentNumber: 0 })).toBe(fingerprint(base));
  });
});

describe('descriptionKey', () => {
  it('strips volatile digit runs', () => {
    expect(descriptionKey('COMPRA 123456789 LOJA')).toBe('COMPRA LOJA');
  });
});
