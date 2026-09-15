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
import { addMonths, dayOfMonth, toMonth, today as todayIn } from '../lib/date';

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

/**
 * Subscriptions billed to the exact centavo, which is what makes them detectable
 * as a PRICE rather than a habit. `risesTo` lets one of them change price partway
 * through, so Recorrentes and the review queue have something real to report.
 */
const SUBSCRIPTIONS: { description: string; reais: number; day: number; risesTo?: { reais: number; month: number } }[] = [
  { description: 'NETFLIX.COM ASSINATURA', reais: 55.9, day: 8 },
  { description: 'SPOTIFY BR PREMIUM', reais: 34.9, day: 12, risesTo: { reais: 41.9, month: 7 } },
  { description: 'ICLOUD+ ARMAZENAMENTO', reais: 12.9, day: 21 },
];

/** A subscription that was cancelled, so "Pararam" is not an empty section. */
const CANCELLED = { description: 'ACADEMIA SMARTFIT PLANO', reais: 129.9, day: 6, lastMonth: 5 };

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

  // Anchored to the real clock, so Hoje always has a current cycle and a future
  // one. A hardcoded year would put the whole demo in the past or the future and
  // leave every forward-looking view empty.
  const TODAY = todayIn();
  const YEAR = Number(TODAY.slice(0, 4));
  const THIS_MONTH = Number(TODAY.slice(5, 7));
  const DAY = dayOfMonth(TODAY);
  const fake = new FakePluggy({ startTime: `${TODAY}T12:00:00.000Z` });

  fake.addItem({ id: 'demo-item', connector: { id: 200, name: 'Meu Pluggy' } });
  fake.addAccount({ id: 'demo-bank', itemId: 'demo-item', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta corrente', balance: 18430.55 });
  fake.addAccount({
    id: 'demo-card', itemId: 'demo-item', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Nubank', balance: 4210.9,
    creditData: { brand: 'Mastercard', level: 'Ultravioleta', creditLimit: 32000, availableCreditLimit: 27789.1, balanceDueDate: '2026-09-20', balanceCloseDate: '2026-09-13' },
  });

  let id = 0;
  const day = (m: number, d: number) => {
    const ym = addMonths(`${YEAR}-${String(THIS_MONTH).padStart(2, '0')}`, m - THIS_MONTH);
    return `${ym}-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  };
  /** Has this dated row already happened? The current month is only half over. */
  const happened = (m: number, d: number) => m < THIS_MONTH || (m === THIS_MONTH && d <= DAY);
  /** Charges in the open cycle carry no bill id — that is what makes them unbilled. */
  const billFor = (m: number) => (m < THIS_MONTH ? { billId: `bill-${m}` } : {});

  for (let month = 1; month <= THIS_MONTH; month++) {
    // Income
    if (happened(month, 5)) {
      fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: 22500, type: 'CREDIT', date: day(month, 5), description: 'SALARIO CREDITO EM CONTA' });
    }

    // Fixed costs, from the bank. Jittered, so they read as recurring but variable.
    for (const [description, amount] of FIXED) {
      if (!happened(month, 10)) continue;
      fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -Math.round(amount * (0.95 + rand() * 0.1)), type: 'DEBIT', date: day(month, 10), description });
    }

    // Subscriptions, to the exact centavo, so they read as a price.
    for (const sub of SUBSCRIPTIONS) {
      if (!happened(month, sub.day)) continue;
      const reais = sub.risesTo && month >= sub.risesTo.month ? sub.risesTo.reais : sub.reais;
      fake.add({
        id: `t${++id}`, accountId: 'demo-card', amount: reais, type: 'DEBIT',
        date: day(month, sub.day), description: sub.description,
        creditCardMetadata: billFor(month),
      });
    }

    if (month <= CANCELLED.lastMonth && happened(month, CANCELLED.day)) {
      fake.add({
        id: `t${++id}`, accountId: 'demo-card', amount: CANCELLED.reais, type: 'DEBIT',
        date: day(month, CANCELLED.day), description: CANCELLED.description,
        creditCardMetadata: billFor(month),
      });
    }

    // Variable spending, mostly on the card
    for (const [description, typical, perMonth] of MERCHANTS) {
      const times = perMonth < 1 ? (rand() < perMonth ? 1 : 0) : Math.round(perMonth * (0.6 + rand() * 0.8));
      for (let i = 0; i < times; i++) {
        const d = 1 + Math.floor(rand() * 27);
        if (!happened(month, d)) continue;
        fake.add({
          id: `t${++id}`, accountId: 'demo-card',
          amount: Math.round(typical * (0.7 + rand() * 0.6)),
          type: 'DEBIT',
          date: day(month, d),
          description,
          merchant: { name: description.split(' ')[0]! },
          creditCardMetadata: billFor(month),
        });
      }
    }

    // A charge far above anything ever spent at that merchant, for Revisar.
    if (month === THIS_MONTH - 1) {
      fake.add({
        id: `t${++id}`, accountId: 'demo-card', amount: 2480, type: 'DEBIT', date: day(month, 9),
        description: 'POSTO SHELL SANTO AMARO', merchant: { name: 'POSTO' },
        creditCardMetadata: billFor(month),
      });
    }

    // Closed bills only: Pluggy never returns the cycle still collecting, which is
    // exactly the gap queries/today.ts has to work around.
    if (month < THIS_MONTH) {
      const billTotal = 4200 + Math.round(rand() * 1500);
      const dueDate = day(month, 20).slice(0, 10);
      fake.addBills('demo-card', [{ id: `bill-${month}`, dueDate, totalAmount: billTotal }]);
      fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -billTotal, type: 'DEBIT', date: day(month, 20), description: 'PAGAMENTO FATURA CARTAO NUBANK' });
      fake.add({ id: `t${++id}`, accountId: 'demo-card', amount: -billTotal, type: 'CREDIT', date: day(month, 20), description: 'PAGAMENTO RECEBIDO OBRIGADO' });
    }

    // A transfer between own accounts, and an unknown merchant for the review queue
    if (happened(month, 25)) {
      fake.add({ id: `t${++id}`, accountId: 'demo-bank', amount: -3000, type: 'DEBIT', date: day(month, 25), description: 'APLICACAO AUTOMATICA CDB' });
    }
    if (happened(month, 17)) {
      fake.add({ id: `t${++id}`, accountId: 'demo-card', amount: 156.4, type: 'DEBIT', date: day(month, 17), description: 'EST COMERCIAL LTDA 4471' });
    }
  }

  // An installment plan, materialized in full — including the parcels dated into
  // months that have not happened. That is how the bank really sends them, and it
  // is what gives Hoje its Compromissos and Cartões its "Parcelas a vencer".
  const PLAN_START = THIS_MONTH - 4;
  const PURCHASE = day(PLAN_START, 14);
  for (let i = 1; i <= 10; i++) {
    const month = PLAN_START + i - 1;
    // Parcels after the first land on the due date of the bill that will carry them.
    const d = i === 1 ? 14 : 20;
    fake.add({
      id: `t${++id}`, accountId: 'demo-card', amount: 489.9, type: 'DEBIT', date: day(month, d),
      description: `MAGAZINE LUIZA PARCELA ${String(i).padStart(2, '0')}/10`,
      creditCardMetadata: {
        installmentNumber: i,
        totalInstallments: 10,
        purchaseDate: PURCHASE,
        ...(month < THIS_MONTH ? { billId: `bill-${month}` } : {}),
      },
    });
  }

  const res = await syncAndCategorize(fake, db, { now: () => new Date(`${TODAY}T12:00:00.000Z`), fallbackItemIds: ['demo-item'] });

  console.log('sync      ', res.sync.status, JSON.stringify(res.sync.transactions));
  console.log('internal  ', JSON.stringify(res.internal));
  console.log('categorize', JSON.stringify(res.categorize));
  console.log('duplicates', res.duplicateFingerprints);
}

main();
