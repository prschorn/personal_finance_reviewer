import { describe, it, expect } from 'vitest';
import { normalize, buildSearchText, stripVolatileDigits, stripInstallmentSuffix } from './text';

describe('normalize', () => {
  it('uppercases, strips accents and collapses whitespace', () => {
    expect(normalize('Farmácia São João')).toBe('FARMACIA SAO JOAO');
    expect(normalize('  restaurante   do  Zé  ')).toBe('RESTAURANTE DO ZE');
    expect(normalize('Condomínio Ediçāo')).toBe('CONDOMINIO EDICAO');
  });

  it('handles the full range of Portuguese diacritics', () => {
    expect(normalize('ÁÀÂÃÄ ÉÊ ÍÎ ÓÔÕ ÚÜ Ç')).toBe('AAAAA EE II OOO UU C');
  });

  it('tolerates empty and nullish input', () => {
    expect(normalize('')).toBe('');
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
  });
});

describe('buildSearchText', () => {
  it('joins the three description sources, de-duplicated', () => {
    expect(
      buildSearchText({ description: 'IFOOD *PIZZA', descriptionRaw: 'IFOOD *PIZZA', merchantName: 'iFood' }),
    ).toBe('IFOOD *PIZZA IFOOD');
  });

  it('skips missing fields', () => {
    expect(buildSearchText({ description: 'UBER TRIP' })).toBe('UBER TRIP');
    expect(buildSearchText({})).toBe('');
  });
});

describe('stripVolatileDigits', () => {
  // NSU / authorization codes / masked card numbers change between syncs even
  // though the transaction is the same, so they must not feed the fingerprint.
  it('removes runs of six or more digits', () => {
    expect(stripVolatileDigits('COMPRA NSU 123456789 MERCADO')).toBe('COMPRA NSU MERCADO');
    expect(stripVolatileDigits('PIX ENVIADO 987654321098')).toBe('PIX ENVIADO');
  });

  it('keeps short digit runs that carry meaning', () => {
    expect(stripVolatileDigits('POSTO 24 HORAS')).toBe('POSTO 24 HORAS');
    expect(stripVolatileDigits('PARCELA 3/10')).toBe('PARCELA 3/10');
    expect(stripVolatileDigits('LOJA 12345')).toBe('LOJA 12345');
  });

  it('collapses the whitespace it leaves behind', () => {
    expect(stripVolatileDigits('A 1234567 B')).toBe('A B');
  });
});

describe('stripInstallmentSuffix', () => {
  // Card statements truncate the description and append the marker, so one purchase
  // appears under several slightly different names.
  it('strips the trailing marker Itaú appends', () => {
    expect(stripInstallmentSuffix('PORTO SEGURO CIA S01/10', 10)).toBe('PORTO SEGURO CIA S');
    expect(stripInstallmentSuffix('PORTO SEGURO CIA S10/10', 10)).toBe('PORTO SEGURO CIA S');
    expect(stripInstallmentSuffix('JIM.COM* CEZAR PEL03/04', 4)).toBe('JIM.COM* CEZAR PEL');
    expect(stripInstallmentSuffix('MERCADOLIVRE*MERCA01/03', 3)).toBe('MERCADOLIVRE*MERCA');
  });

  it('gives every installment of one purchase the same key', () => {
    const keys = ['S01/10', 'S05/10', 'S10/10'].map((n) => stripInstallmentSuffix(`PORTO SEGURO CIA ${n}`, 10));
    expect(new Set(keys).size).toBe(1);
  });

  it('handles a marker separated by spaces', () => {
    expect(stripInstallmentSuffix('LATAM AIR*SORNVZ  01/04', 4)).toBe('LATAM AIR*SORNVZ');
  });

  // Pluggy's own count removes all doubt about what is being stripped.
  it('refuses to strip a marker that disagrees with the known total', () => {
    expect(stripInstallmentSuffix('ALGUMA COISA 01/04', 10)).toBe('ALGUMA COISA 01/04');
  });

  it('leaves a single-payment description alone', () => {
    expect(stripInstallmentSuffix('PAO DE ACUCAR 1423')).toBe('PAO DE ACUCAR 1423');
    expect(stripInstallmentSuffix('IFOOD *SUSHI YAMA')).toBe('IFOOD *SUSHI YAMA');
  });

  // Without a known total, only strip what genuinely reads as "N of M".
  it('declines what cannot be an installment', () => {
    expect(stripInstallmentSuffix('VENCIMENTO 15/03')).toBe('VENCIMENTO 15/03');
    expect(stripInstallmentSuffix('ALGO 05/01')).toBe('ALGO 05/01');
    expect(stripInstallmentSuffix('ALGO 01/01')).toBe('ALGO 01/01');
  });

  it('strips a plausible marker when the total is unknown', () => {
    expect(stripInstallmentSuffix('LOJA QUALQUER 02/06')).toBe('LOJA QUALQUER');
  });
});
