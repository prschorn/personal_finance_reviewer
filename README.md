# Finanças

A local web app that replaces the `Planilha orçamento` spreadsheet. It pulls bank
and credit card data from [Pluggy](https://docs.pluggy.ai) into a SQLite file on
this machine and renders two views:

- **Mensal** — every category by month for a year, with the transactions behind
  any figure one click away.
- **Cartões** — credit card spending by category, by card and by bill.

Single user, runs locally, nothing leaves this computer.

## Setup

```bash
npm install
```

Connect your banks at [meu.pluggy.ai](https://meu.pluggy.ai) (free, personal), then
create a developer account at [dashboard.pluggy.ai](https://dashboard.pluggy.ai) for
API credentials:

```bash
cp .env.local.example .env.local
```

Fill in `PLUGGY_CLIENT_ID` and `PLUGGY_CLIENT_SECRET`. On the free tier Pluggy does
not let the API list your connections, so paste each connection's id into
`PLUGGY_ITEM_IDS` (or add them later under Ajustes).

```bash
npm run dev
```

Open http://localhost:3000, then **Sincronizar**. Fill in your CPF/CNPJ under
Ajustes — that is what lets the app recognise transfers between your own accounts
instead of guessing from descriptions.

## How the numbers work

**Card purchases are itemized.** A supermarket run on the Nubank card counts under
Mercado, not under a "Nubank" line. The bill payment that settles those purchases is
treated as an internal transfer and excluded, so nothing is counted twice. This is
the one place the app deliberately differs from the old spreadsheet, which had
`Itaú` and `Nubank` rows carrying whole bills.

**Everything excluded is visible.** Transferências lists every movement kept out of
the totals, with the reason, and any of them can be put back with one click. Wrongly
excluding real spending is the worst thing this app could do, so it is never silent.

**Categorizing one transaction teaches the rest.** Picking a category creates a
rule matched on that merchant's name, so it applies to every month — the ones
already synced and the ones still to come. Correcting September also fixes January.

**Rules can be removed or switched off.** On Regras, a rule you created has a
Remove button; one shipped with the app only has Disable, because deleting it would
not stick — seeding re-inserts anything missing by name on the next boot, whereas a
disabled rule stays disabled. Either way the app tells you how many transactions
changed category as a result, so a rule that looked harmless can't quietly take a
dozen transactions with it.

**Installments count as one purchase.** A card statement truncates the description
and appends the installment marker, so one purchase shows up as
`PORTO SEGURO CIA S01/10`, `…S02/10` and so on. The match key ignores that marker,
so categorizing any single installment settles the whole plan — including the ones
dated next year that have not been billed yet. A broader rule also absorbs any
narrower ones it now covers, so rules made one installment at a time get tidied
away rather than shadowing each other.
Use "só esta" if you really mean just that one transaction; it removes the rule and
pins the category to that row alone. Your rules sit at the top of Regras marked
`sua`, above everything shipped with the app.

**A second bank just works.** Each connection syncs independently with its own
watermark, so one bank being broken never blocks or deletes the other, and identical
purchases at two banks stay distinct. Transfers between your own banks only become
detectable once both sides are connected. The one thing to avoid is connecting the
*same* bank twice — Pluggy warns against it, and it would double-count.

**Categories come from local rules.** Pluggy's own categorization is a paid add-on
and its generic categories would not produce *Marmitas* or *DARF* anyway. Rules live
in `src/categorize/seed-rules.ts`; the first match wins, and a category you pick by
hand always beats a rule. Anything no rule matched lands in Outros and is flagged
for review on the Mensal page.

**Pending transactions are included**, so the current month is not understated.
They are marked "não faturada" in the drill-down.

## Sync

Pluggy refreshes each connection on its own schedule (about daily) and its docs
advise against building an update loop, so this app only ever reads. It pulls when
you open it if the last sync is more than 6 hours old, and whenever you press
Sincronizar. Two windows per account:

- **createdAtFrom** since the last run — catches anything newly created, including
  old-dated rows Pluggy only just discovered.
- **a 45-day date range** — the only way to notice something was *deleted*, since a
  deleted row simply stops being returned. Once a month this widens to the full
  12 months Open Finance exposes.

Pluggy deletes and recreates a transaction under a new id whenever its details shift,
which is what normally happens when a pending charge posts. Manual categorizations
are therefore keyed to a stable fingerprint rather than the Pluggy id, and a rescue
pass reattaches any that a recreate orphans.

## What the live API actually does

Established by `npm run probe` against a real Itaú connection (connector 601), not
assumed from the docs:

- `GET /transactions` is **gone** (410 `ENDPOINT_DEPRECATED`). Use `GET /v2/transactions`,
  which also rejects `pageSize` — the cursor controls paging. Its `next` is a bare
  query string to append to the endpoint path, not a path.
- `GET /items` answers **401** on this plan, so connection ids are configured by hand.
  `GET /items/{id}`, `/accounts` and `/bills` all work.
- Dates are **genuine timestamps**, not midnight-UTC placeholders. `03:00:00Z` is
  local midnight and `02:59:00Z` is 23:59 the previous day; both resolve to the day
  the bank means once converted to America/Sao_Paulo. About 10% of transactions fall
  on a different day under conversion, and a couple land in a different month — which
  is the whole reason `src/lib/date.ts` exists.
- Sign conventions hold on both account types, and the sync counts any row that
  disagrees with Pluggy's own DEBIT/CREDIT flag.
- `category` **is** populated (~98%), contrary to the plan's assumption. It is used
  as a hint below your own rules, and its `Credit card payment` and
  `Same person transfer` labels are trusted for transfer detection — they are more
  reliable than matching description text.
- `createdAtFrom` genuinely returns old-dated rows created recently, so the
  incremental window works as designed.
- `merchant.name` is present on only ~5% of rows, so rules match on the description.

## Commands

```bash
npm run dev         # http://localhost:3000
npm test            # 345 tests
npm run typecheck
npm run probe       # inspect the live Pluggy API, writes fixtures/
npm run db:migrate
```

To look at the UI without real data:

```bash
FINANCE_DB_PATH=db/demo.db npx tsx src/scripts/demo-seed.ts
FINANCE_DB_PATH=db/demo.db npx next dev --port 3100
```

## Layout

```
src/
  lib/          date, money and text primitives — date.ts decides which month a
                transaction lands in and is the most-tested file here
  pluggy/       API client and types. Never touches the database.
  sync/         pull, reconcile, detect transfers. Never calls fetch.
  categorize/   fingerprint + the pure resolve() that decides every category
  queries/      the matrix and card aggregations
  app/          Next.js pages and server actions
  db/           schema, migrations, seeds
```

Money is stored as integer centavos everywhere. Dates are stored as local
`YYYY-MM-DD` strings; Pluggy returns UTC, and `src/lib/date.ts` explains why
converting naively would file a transaction in the wrong month.
