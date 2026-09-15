/**
 * Populate a throwaway database with plausible data, for looking at the UI.
 *
 *   FINANCE_DB_PATH=db/demo.db npx tsx src/scripts/demo-seed.ts
 *
 * Runs the real pipeline against FakePluggy, so what you see is produced by the
 * same sync, detection and categorization code as production data.
 */
import { getDb } from '../db/client';
import { bootstrap } from '../db/bootstrap';
import { FakePluggy } from '../pluggy/fake';
import { syncAndCategorize } from '../sync/pipeline';

const MERCHANTS: [string, number, number][] = [
  // description, typical amount (reais), times per month
  ['PAO DE ACUCAR 1423', 210, 4],
  ['HORTIFRUTI NATURAL', 95, 2],
  ['IFOOD *SUSHI YAMA', 78, 5],
  ['RESTAURANTE DO PORTO', 145, 2],
  ['STARBUCKS COFFEE', 28, 4],
  ['DROGARIA PACHECO', 87, 2],
  ['POSTO SHELL SANTO AMARO', 280, 2],
  ['UBER *TRIP', 32, 8],
  ['ESTACIONAMENTO ESTAPAR', 45, 3],
  ['AMAZON BR SERVICOS', 165, 2],
  ['MERCADO LIVRE *PEDIDO', 240, 1],
  ['NETFLIX.COM', 55, 1],
  ['SPOTIFY BR', 35, 1],
  ['OFICINA MECANICA JR', 640, 0.2],
  ['CLINICA SAO LUCAS', 320, 0.5],
  ['PSIQUIATRA DRA MENDES', 450, 1],
  ['NUTRICIONISTA CLARA', 300, 0.4],
  ['MARMITAS DA VOVO', 380, 1],
  ['LATAM AIRLINES', 1850, 0.15],
  ['AIRBNB * ESTADIA', 1200, 0.15],
];

const FIXED: [string, number][] = [
  ['CONDOMINIO EDIFICIO AURORA', 1450],
  ['ENEL DISTRIBUICAO SP', 215],
  ['VIVO FIXO E MOVEL', 139],
  ['UNIMED SEGUROS SAUDE', 890],
  ['DARF NUMERADO 0561', 1240],
  ['DAS SIMPLES NACIONAL', 890],
];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function main() {
  const db = bootstrap(getDb());
  const rand = seededRandom(42);
  const fake = new FakePluggy({ startTime: '2026-09-30T12:00:00.000Z' });

  fake.addItem({ id: 'demo-item', connector: { id: 200, name: 'Meu Pluggy' } });
  fake.addAccount({ id: 'demo-bank', itemId: 'demo-item', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta corrente', balance: 18430.55 });
  fake.addAccount({
    id: 'demo-card', itemId: 'demo-item', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Nubank', balance: 4210.9,
    creditData: { brand: 'Mastercard', level: 'Ultravioleta', creditLimit: 32000, availableCreditLimit: 27789.1, balanceDueDate: '2026-09-20', balanceCloseDate: '2026-09-13' },
  });

  let id = 0;
  const day = (m: number, d: number) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`;

  for (let month = 1; month <= 9; month++) {
    // Income
    fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: 22500, type: 'CREDIT', date: day(month, 5), description: 'SALARIO CREDITO EM CONTA' });

    // Fixed costs, from the bank
    for (const [description, amount] of FIXED) {
      fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -Math.round(amount * (0.95 + rand() * 0.1)), type: 'DEBIT', date: day(month, 10), description });
    }

    // Variable spending, mostly on the card
    for (const [description, typical, perMonth] of MERCHANTS) {
      const times = perMonth < 1 ? (rand() < perMonth ? 1 : 0) : Math.round(perMonth * (0.6 + rand() * 0.8));
      for (let i = 0; i < times; i++) {
        fake.add({
          id: `t${++id}`, accountId: 'demo-card',
          amount: Math.round(typical * (0.7 + rand() * 0.6)),
          type: 'DEBIT',
          date: day(month, 1 + Math.floor(rand() * 27)),
          description,
          merchant: { name: description.split(' ')[0]! },
          creditCardMetadata: { billId: `bill-${month}` },
        });
      }
    }

    // An installment purchase
    if (month >= 3) {
      fake.add({
        id: `t${++id}`, accountId: 'demo-card', amount: 489.9, type: 'DEBIT', date: day(month, 14),
        description: 'MAGAZINE LUIZA PARCELA',
        creditCardMetadata: { installmentNumber: month - 2, totalInstallments: 10, totalAmount: 4899, purchaseDate: day(3, 14), billId: `bill-${month}` },
      });
    }

    // The bill, both sides — these must NOT count as spending
    const billTotal = 4200 + Math.round(rand() * 1500);
    fake.addBills('demo-card', [{ id: `bill-${month}`, dueDate: `2026-${String(month).padStart(2, '0')}-20`, totalAmount: billTotal }]);
    fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -billTotal, type: 'DEBIT', date: day(month, 20), description: 'PAGAMENTO FATURA CARTAO NUBANK' });
    fake.add({ id: `t${++id}`, accountId: 'demo-card', amount: -billTotal, type: 'CREDIT', date: day(month, 20), description: 'PAGAMENTO RECEBIDO OBRIGADO' });

    // A transfer between own accounts, and an unknown merchant for the review queue
    fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -3000, type: 'DEBIT', date: day(month, 25), description: 'APLICACAO AUTOMATICA CDB' });
    fake.add({ id: `t${++id}`, accountId: 'demo-card', amount: 156.4, type: 'DEBIT', date: day(month, 17), description: 'EST COMERCIAL LTDA 4471' });
  }

  const res = await syncAndCategorize(fake, db, { now: () => new Date('2026-09-30T12:00:00.000Z'), fallbackItemIds: ['demo-item'] });

  console.log('sync      ', res.sync.status, JSON.stringify(res.sync.transactions));
  console.log('internal  ', JSON.stringify(res.internal));
  console.log('categorize', JSON.stringify(res.categorize));
  console.log('duplicates', res.duplicateFingerprints);
}

main();
