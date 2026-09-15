import { describe, it, expect } from 'vitest';
import { normalize, buildSearchText, stripVolatileDigits } from './text';

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
