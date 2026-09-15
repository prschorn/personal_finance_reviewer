import { describe, it, expect } from 'vitest';
import { mapTransaction, mapAccount, mapBill, normalizeSign, signAgreesWithType } from './map';
import type { PluggyAccount, PluggyTransaction } from '../pluggy/types';

const ctx = { runId: 7, now: '2026-03-15T12:00:00.000Z' };
const bankAccount = { id: 'acc-bank', type: 'BANK' as const };
const cardAccount = { id: 'acc-card', type: 'CREDIT' as const };

function tx(over: Partial<PluggyTransaction> = {}): PluggyTransaction {
  return {
    id: 'tx-1',
    accountId: 'acc-bank',
    date: '2026-03-10T00:00:00.000Z',
    description: 'MERCADO EXTRA',
    amount: 54.32,
    currencyCode: 'BRL',
    type: 'DEBIT',
    status: 'POSTED',
    ...over,
  };
}

describe('normalizeSign', () => {
  // The single convention everything downstream aggregates on.
  it('makes money-out negative on both account types', () => {
    expect(normalizeSign(-5432, 'BANK')).toBe(-5432); // bank debit is already negative
    expect(normalizeSign(5432, 'CREDIT')).toBe(-5432); // card purchase is positive at Pluggy
  });

  it('makes money-in positive on both account types', () => {
    expect(normalizeSign(500000, 'BANK')).toBe(500000); // salary
    expect(normalizeSign(-120000, 'CREDIT')).toBe(120000); // card bill payment
  });
});

describe('signAgreesWithType', () => {
  it('agrees when the normalized sign matches Pluggy DEBIT/CREDIT', () => {
    expect(signAgreesWithType(-5432, 'DEBIT')).toBe(true);
    expect(signAgreesWithType(5432, 'CREDIT')).toBe(true);
  });

  it('flags a disagreement', () => {
    expect(signAgreesWithType(5432, 'DEBIT')).toBe(false);
    expect(signAgreesWithType(-5432, 'CREDIT')).toBe(false);
  });

  it('abstains when there is nothing to compare', () => {
    expect(signAgreesWithType(0, 'DEBIT')).toBe(true);
    expect(signAgreesWithType(-100, null)).toBe(true);
  });
});

describe('mapTransaction', () => {
  it('stores money as integer cents', () => {
    const row = mapTransaction(tx({ amount: 54.32 }), bankAccount, ctx);
    expect(row.amountCents).toBe(5432);
    expect(row.signedCents).toBe(5432);
  });

  it('files a midnight-UTC date under the correct local day', () => {
    const row = mapTransaction(tx({ date: '2026-03-01T00:00:00.000Z' }), bankAccount, ctx);
    expect(row.postedOn).toBe('2026-03-01');
    expect(row.dateUtc).toBe('2026-03-01T00:00:00.000Z'); // raw kept for audit
  });

  it('normalizes a card purchase to negative', () => {
    const row = mapTransaction(tx({ amount: 120.5, type: 'DEBIT' }), cardAccount, ctx);
    expect(row.amountCents).toBe(12050);
    expect(row.signedCents).toBe(-12050);
  });

  it('normalizes a card bill payment to positive', () => {
    const row = mapTransaction(tx({ amount: -1200, type: 'CREDIT', description: 'PAGAMENTO FATURA' }), cardAccount, ctx);
    expect(row.signedCents).toBe(120000);
  });

  it('builds normalized search text from all three sources', () => {
    const row = mapTransaction(
      tx({ description: 'Farmácia São João', descriptionRaw: 'FARM SAO JOAO 12', merchant: { name: 'Drogaria' } }),
      bankAccount, ctx,
    );
    expect(row.searchText).toBe('FARMACIA SAO JOAO FARM SAO JOAO 12 DROGARIA');
  });

  it('defaults an absent status to POSTED', () => {
    expect(mapTransaction(tx({ status: undefined }), bankAccount, ctx).status).toBe('POSTED');
  });

  it('strips formatting from documents so they can be compared', () => {
    const row = mapTransaction(
      tx({ paymentData: { receiver: { name: 'Eu', documentNumber: { type: 'CPF', value: '123.456.789-01' } } } }),
      bankAccount, ctx,
    );
    expect(row.receiverDocument).toBe('12345678901');
  });

  it('converts the card purchase date to a local calendar date', () => {
    const row = mapTransaction(
      tx({ creditCardMetadata: { installmentNumber: 3, totalInstallments: 10, totalAmount: 1000, purchaseDate: '2026-02-20T00:00:00.000Z', billId: 'bill-9' } }),
      cardAccount, ctx,
    );
    expect(row.ccPurchaseDate).toBe('2026-02-20');
    expect(row.ccInstallmentNumber).toBe(3);
    expect(row.ccTotalInstallments).toBe(10);
    expect(row.ccTotalAmountCents).toBe(100000);
    expect(row.ccBillId).toBe('bill-9');
  });

  // The upsert must never clobber a user's decision, so it must not write these.
  it('writes no categorization fields at all', () => {
    const row = mapTransaction(tx(), bankAccount, ctx) as Record<string, unknown>;
    expect(row.categoryId).toBeUndefined();
    expect(row.isInternal).toBeUndefined();
    expect(row.internalReason).toBeUndefined();
  });

  it('keeps the raw payload for audit', () => {
    const row = mapTransaction(tx(), bankAccount, ctx);
    expect(JSON.parse(row.rawJson).id).toBe('tx-1');
  });

  it('stamps the run id so deletion detection can sweep', () => {
    expect(mapTransaction(tx(), bankAccount, ctx).lastSeenRunId).toBe(7);
  });

  it('is pure: same input, identical output', () => {
    expect(mapTransaction(tx(), bankAccount, ctx)).toEqual(mapTransaction(tx(), bankAccount, ctx));
  });
});

describe('mapAccount', () => {
  it('maps a credit card with its credit data', () => {
    const acc: PluggyAccount = {
      id: 'acc-card', itemId: 'item-1', type: 'CREDIT', subtype: 'CREDIT_CARD',
      name: 'Nubank', number: '1234', balance: 1234.56, currencyCode: 'BRL',
      creditData: { brand: 'Mastercard', level: 'Platinum', creditLimit: 10000, availableCreditLimit: 8765.44, balanceDueDate: '2026-03-20', balanceCloseDate: '2026-03-13' },
    };
    const row = mapAccount(acc);
    expect(row.balanceCents).toBe(123456);
    expect(row.creditLimitCents).toBe(1000000);
    expect(row.availableCreditLimitCents).toBe(876544);
    expect(row.cardBrand).toBe('Mastercard');
    expect(row.balanceDueDate).toBe('2026-03-20');
  });

  it('leaves credit fields null for a bank account', () => {
    const row = mapAccount({ id: 'a', itemId: 'i', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: null, number: null, balance: 100, currencyCode: 'BRL' });
    expect(row.creditLimitCents).toBeNull();
    expect(row.cardBrand).toBeNull();
  });
});

describe('mapBill', () => {
  it('converts amounts to cents', () => {
    const row = mapBill({ id: 'b1', dueDate: '2026-03-20', totalAmount: 3456.78, minimumPaymentAmount: 345.67 }, 'acc-card');
    expect(row.totalAmountCents).toBe(345678);
    expect(row.minimumPaymentCents).toBe(34567);
    expect(row.accountId).toBe('acc-card');
  });

  // Pluggy sends a full ISO timestamp here, unlike the plain dates elsewhere.
  // Stored raw it renders as "03T00:00:00.000Z/09/2026".
  it('normalizes an ISO due date to a plain local date', () => {
    expect(mapBill({ id: 'b1', dueDate: '2026-09-03T00:00:00.000Z', totalAmount: 100 }, 'acc').dueDate).toBe('2026-09-03');
  });

  it('keeps a plain date as it is', () => {
    expect(mapBill({ id: 'b1', dueDate: '2026-09-03', totalAmount: 100 }, 'acc').dueDate).toBe('2026-09-03');
  });

  it('tolerates a missing due date', () => {
    expect(mapBill({ id: 'b1', dueDate: null, totalAmount: 100 }, 'acc').dueDate).toBeNull();
  });
});

describe('mapAccount statement dates', () => {
  it('normalizes ISO statement dates too', () => {
    const row = mapAccount({
      id: 'a', itemId: 'i', type: 'CREDIT', subtype: 'CREDIT_CARD', name: null, number: null,
      balance: 0, currencyCode: 'BRL',
      creditData: { balanceDueDate: '2026-09-03T00:00:00.000Z', balanceCloseDate: '2026-08-27T00:00:00.000Z' },
    });
    expect(row.balanceDueDate).toBe('2026-09-03');
    expect(row.balanceCloseDate).toBe('2026-08-27');
  });
});
