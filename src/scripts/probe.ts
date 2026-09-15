/**
 * M2 probe — answers the open questions in the plan against the LIVE Pluggy API,
 * before any sync logic is written to depend on the answers.
 *
 *   npm run probe
 *
 * Writes full payloads to fixtures/raw/ (gitignored — they contain real financial
 * data) and prints an aggregate report containing no amounts and no descriptions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clientFromEnv, PluggyError, type PluggyClient } from '../pluggy/client';
import type { PluggyAccount, PluggyItem, PluggyTransaction } from '../pluggy/types';
import { toLocalDate, addDays, today } from '../lib/date';

const RAW_DIR = resolve(process.cwd(), 'fixtures/raw');

const out: string[] = [];
function say(line = '') {
  console.log(line);
  out.push(line);
}
function heading(t: string) {
  say('');
  say(t);
  say('-'.repeat(t.length));
}

function dump(name: string, data: unknown) {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(resolve(RAW_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

/** Probe an endpoint we expect might be forbidden on the free tier. */
async function probe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const value = await fn();
    say(`  ${label}: OK`);
    return value;
  } catch (err) {
    if (err instanceof PluggyError) {
      say(`  ${label}: ${err.status}${err.isForbidden ? ' FORBIDDEN (free-tier limitation)' : ''}`);
      return null;
    }
    say(`  ${label}: ERROR ${(err as Error).message}`);
    return null;
  }
}

async function collectTransactions(
  client: PluggyClient,
  accountId: string,
  query: Parameters<PluggyClient['listTransactions']>[0],
  maxPages = 4,
): Promise<PluggyTransaction[]> {
  const all: PluggyTransaction[] = [];
  let pages = 0;
  for await (const page of client.listTransactions(query)) {
    all.push(...page);
    if (++pages >= maxPages) break;
  }
  return all;
}

async function main() {
  const client = clientFromEnv();
  say('Pluggy probe');
  say(`run at ${new Date().toISOString()}`);

  // -- Q4: which endpoints are forbidden on this tier? ----------------------
  heading('Q4. Endpoint availability');
  const discovered = await probe('GET /items', () => client.listItems());

  const configured = (process.env.PLUGGY_ITEM_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const itemIds = discovered?.length ? discovered.map((i) => i.id) : configured;
  if (!itemIds.length) {
    say('');
    say('No items to probe.');
    say('GET /items is unavailable and PLUGGY_ITEM_IDS is unset.');
    say('Connect a bank at https://meu.pluggy.ai, then put its item id in .env.local as');
    say('  PLUGGY_ITEM_IDS=<uuid>[,<uuid>]');
    return;
  }
  say(`  item ids: ${itemIds.length} (${discovered?.length ? 'discovered' : 'from PLUGGY_ITEM_IDS'})`);

  const items: PluggyItem[] = [];
  const accounts: PluggyAccount[] = [];
  for (const id of itemIds) {
    const item = await probe(`GET /items/${id.slice(0, 8)}…`, () => client.getItem(id));
    if (!item) continue;
    items.push(item);
    const accs = await probe(`GET /accounts?itemId=${id.slice(0, 8)}…`, () => client.listAccounts(id));
    if (accs) accounts.push(...accs);
  }
  dump('items', items);
  dump('accounts', accounts);

  heading('Connections');
  for (const item of items) {
    say(`  ${item.connector?.name ?? '?'} (connector ${item.connector?.id ?? '?'})`);
    say(`    status=${item.status} executionStatus=${item.executionStatus}`);
    say(`    lastUpdatedAt=${item.lastUpdatedAt ?? 'never'} consentExpiresAt=${item.consentExpiresAt ?? 'none'}`);
  }
  say('');
  for (const a of accounts) {
    say(`  account ${a.id.slice(0, 8)}… ${a.type}/${a.subtype} ${a.currencyCode}${a.creditData ? ` brand=${a.creditData.brand ?? '?'} due=${a.creditData.balanceDueDate ?? '?'}` : ''}`);
  }

  // -- bills ---------------------------------------------------------------
  heading('Q4b. Bills availability (credit cards)');
  const creditAccounts = accounts.filter((a) => a.type === 'CREDIT');
  if (!creditAccounts.length) say('  no credit accounts on this connection');
  for (const a of creditAccounts) {
    const bills = await probe(`GET /bills?accountId=${a.id.slice(0, 8)}…`, () => client.listBills(a.id));
    if (bills) {
      dump(`bills-${a.id}`, bills);
      say(`    ${bills.length} bills, dueDates: ${bills.slice(0, 6).map((b) => b.dueDate).join(', ')}`);
    }
  }

  // -- transactions --------------------------------------------------------
  heading('Transactions sample');
  const sample: PluggyTransaction[] = [];
  for (const a of accounts) {
    const txs = await collectTransactions(client, a.id, { accountId: a.id, pageSize: 500 }, 2);
    say(`  ${a.type}/${a.subtype} ${a.id.slice(0, 8)}…: ${txs.length} transactions`);
    sample.push(...txs);
  }
  dump('transactions', sample);

  if (!sample.length) {
    say('');
    say('No transactions returned — cannot answer Q1/Q3/Q5/Q6.');
    say('If consent has expired, data endpoints return empty. Check consentExpiresAt above.');
    return;
  }

  // -- Q1: date semantics --------------------------------------------------
  heading('Q1. Date semantics (HIGHEST CONSEQUENCE)');
  const times = new Map<string, number>();
  for (const t of sample) {
    const time = t.date.includes('T') ? t.date.slice(11) : '(bare date)';
    times.set(time, (times.get(time) ?? 0) + 1);
  }
  const sorted = [...times].sort((a, b) => b[1] - a[1]);
  say(`  distinct time-of-day values: ${sorted.length}`);
  for (const [time, n] of sorted.slice(0, 8)) {
    say(`    ${time.padEnd(16)} ${n} (${((n / sample.length) * 100).toFixed(1)}%)`);
  }
  const midnight = sorted.filter(([t]) => t.startsWith('00:00:00') || t === '(bare date)').reduce((s, [, n]) => s + n, 0);
  const pct = (midnight / sample.length) * 100;
  say('');
  say(`  ${pct.toFixed(1)}% are midnight UTC or bare dates`);

  // The only thing that actually matters for the grid is how many transactions
  // land in a different MONTH depending on the interpretation. Everything else is
  // interesting but harmless.
  let dayShift = 0;
  let monthShift = 0;
  for (const t of sample) {
    const naive = t.date.slice(0, 10);
    const local = toLocalDate(t.date);
    if (naive !== local) {
      dayShift++;
      if (naive.slice(0, 7) !== local.slice(0, 7)) monthShift++;
    }
  }
  say(`  ${dayShift} of ${sample.length} fall on a different DAY once converted to ${'America/Sao_Paulo'}`);
  say(`  ${monthShift} of ${sample.length} fall in a different MONTH — this is what would distort the grid`);
  say('');
  if (pct > 90) {
    say('  => Floating local dates. lib/date.ts passes them through verbatim. Correct.');
  } else {
    say('  => Genuine timestamps. lib/date.ts converts UTC -> local, which is correct here:');
    say('     03:00:00Z is exactly local midnight, and 02:59:00Z is 23:59 the previous day,');
    say('     so both resolve to the calendar day the bank actually means.');
    say('     Spot-check one of the month-shifting rows above against the bank app.');
  }

  // -- Q3: sign conventions ------------------------------------------------
  heading('Q3. Sign conventions');
  for (const acc of accounts) {
    const txs = sample.filter((t) => t.accountId === acc.id);
    if (!txs.length) continue;
    const pos = txs.filter((t) => t.amount > 0);
    const neg = txs.filter((t) => t.amount < 0);
    const posDebit = pos.filter((t) => t.type === 'DEBIT').length;
    const negDebit = neg.filter((t) => t.type === 'DEBIT').length;
    say(`  ${acc.type}/${acc.subtype} ${acc.id.slice(0, 8)}…  n=${txs.length}`);
    say(`    amount > 0: ${pos.length} (of which type=DEBIT: ${posDebit})`);
    say(`    amount < 0: ${neg.length} (of which type=DEBIT: ${negDebit})`);
    const expected = acc.type === 'CREDIT' ? 'amount>0 should be DEBIT (a purchase)' : 'amount>0 should be CREDIT (money in)';
    const holds = acc.type === 'CREDIT' ? posDebit === pos.length : posDebit === 0;
    say(`    expectation: ${expected} -> ${holds ? 'HOLDS' : 'VIOLATED — fix normalizeSign before building the matrix'}`);
  }

  // -- Q6: is category populated? ------------------------------------------
  heading('Q6. Pluggy categorization on this tier');
  const withCategory = sample.filter((t) => t.category != null);
  say(`  ${withCategory.length}/${sample.length} transactions carry a category`);
  say(
    withCategory.length === 0
      ? '  => absent as expected. Local rules are the only source of categories.'
      : `  => present. Use ONLY as a hint below local rules. Examples: ${[...new Set(withCategory.map((t) => t.category))].slice(0, 8).join(', ')}`,
  );

  // -- Q5: installments ----------------------------------------------------
  heading('Q5. Installment reporting shape');
  const inst = sample.filter((t) => (t.creditCardMetadata?.totalInstallments ?? 0) > 1);
  say(`  ${inst.length} installment transactions`);
  for (const t of inst.slice(0, 5)) {
    const m = t.creditCardMetadata!;
    const ratio = m.totalAmount && t.amount ? (m.totalAmount / t.amount).toFixed(2) : '?';
    say(`    ${m.installmentNumber}/${m.totalInstallments}  totalAmount/amount=${ratio}  purchaseDate=${m.purchaseDate ?? 'none'}`);
  }
  if (inst.length) {
    say('  => Verify against a real bill that the full purchase is NOT also reported separately.');
  }

  // -- metadata coverage ---------------------------------------------------
  heading('Field coverage (drives transfer detection)');
  const cover = (label: string, pred: (t: PluggyTransaction) => boolean) => {
    const n = sample.filter(pred).length;
    say(`  ${label.padEnd(28)} ${n}/${sample.length} (${((n / sample.length) * 100).toFixed(0)}%)`);
  };
  cover('merchant.name', (t) => !!t.merchant?.name);
  cover('paymentData', (t) => !!t.paymentData);
  cover('paymentData.paymentMethod', (t) => !!t.paymentData?.paymentMethod);
  cover('payer document', (t) => !!t.paymentData?.payer?.documentNumber?.value);
  cover('receiver document', (t) => !!t.paymentData?.receiver?.documentNumber?.value);
  cover('creditCardMetadata.billId', (t) => !!t.creditCardMetadata?.billId);
  cover('descriptionRaw', (t) => !!t.descriptionRaw);
  cover('status present', (t) => !!t.status);
  cover('status = PENDING', (t) => t.status === 'PENDING');
  cover('createdAt present', (t) => !!t.createdAt);

  // -- Q2: does createdAtFrom behave like a creation filter? ----------------
  heading('Q2. createdAtFrom semantics (Window A depends on this)');
  const firstAccount = accounts[0];
  if (firstAccount) {
    const since = `${addDays(today(), -7)}T00:00:00.000Z`;
    const recent = await collectTransactions(client, firstAccount.id, {
      accountId: firstAccount.id, createdAtFrom: since, pageSize: 500,
    }, 2);
    say(`  createdAtFrom=${since} returned ${recent.length} transactions`);
    if (recent.length) {
      const dates = recent.map((t) => toLocalDate(t.date)).sort();
      const oldest = dates[0]!;
      say(`  oldest transaction DATE among them: ${oldest}`);
      say(
        oldest < addDays(today(), -7)
          ? '  => CONFIRMED: returns old-dated rows created recently. Window A works as designed.'
          : '  => INCONCLUSIVE: no old-dated rows in this batch. Re-check after a sync that recreates a transaction.',
      );
    } else {
      say('  => no transactions created in the last 7 days; re-run after the next Pluggy auto-sync.');
    }
  }

  heading('Next steps');
  say('  Full payloads written to fixtures/raw/ (gitignored).');
  say('  Redact and copy a few rows into fixtures/ to use as test fixtures.');

  writeFileSync(resolve(process.cwd(), 'fixtures/probe-report.txt'), out.join('\n'));
}

main().catch((err) => {
  console.error('\nProbe failed:', err instanceof PluggyError ? `${err.message} ${JSON.stringify(err.body)}` : err);
  process.exit(1);
});
