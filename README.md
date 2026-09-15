# Finanças

A local web app that replaces the `Planilha orçamento` spreadsheet. It pulls bank
and credit card data from [Pluggy](https://docs.pluggy.ai) into a SQLite file on
this machine and renders:

- **Hoje** — balances, how much of each card limit is used, what the next bill is
  collecting so far and when it lands, the installments already scheduled into
  months that haven't happened, and how this month is pacing against your own
  previous months. The only view that looks forward.
- **Revisar** — one list of what is worth a second look since you last looked:
  duplicates, charges far above anything ever spent at that merchant, categories
  nothing decided, and subscriptions that changed price or went quiet.
- **Mensal** — every category by month for a year, with the transactions behind
  any figure one click away.
- **Painel** — income against spending month by month, and the biggest categories
  over the same months. Both have a table view; hiding a series rescales the axis,
  which is how you read the smaller categories when one large one flattens them.
- **Cartões** — credit card spending by category, by card and by bill. Clicking a
  category opens the card transactions behind it, for the year or the single month
  on screen.
- **Recorrentes** — what comes back every month, found by cadence rather than by a
  list of brand names, split into things with a price and things that merely repeat.

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

**"Sem regra" does not mean "no category".** It lists transactions no rule matched,
where the category shown is the app's fallback guess — Outros for money out,
Receitas for money in. Those rows do carry a category; the point is that nothing
decided it, which is how an insurance refund ends up counted as income. Each row is
marked `sem regra` so the guess is never mistaken for a decision.

When the guess is right, **Confirmar** turns it into a rule. It exists as its own
button because the dropdown already shows the guessed category, and a `<select>`
fires no change event when you pick the option that is already selected — so
choosing Receitas on a row already guessed as Receitas did nothing at all.

**Categories come from local rules.** Pluggy's own categorization is a paid add-on
and its generic categories would not produce *Marmitas* or *DARF* anyway. Rules live
in `src/categorize/seed-rules.ts`; the first match wins, and a category you pick by
hand always beats a rule. Anything no rule matched lands in Outros and is flagged
for review on the Mensal page.

**Pending transactions are included**, so the current month is not understated.
They are marked "não faturada" in the drill-down.

## Charts

The palette is the validated categorical theme from the data-viz method, not the
app's own indigo and green: run through the validator, the indigo falls outside the
lightness band and the green sits below the chroma floor (it reads gray). The
semantically obvious green-for-income against orange-for-spending also fails —
ΔE 3.2 under protanopia, indistinguishable to red-green colorblind readers. Blue
and orange pass every check in both modes.

Three hues in the seven-series palette sit below 3:1 against the light surface, so
the relief rule applies and every chart ships a table view. Series colours are
assigned per entity and never cycled: past six categories the rest fold into
"Demais categorias" rather than inventing a hue, and hiding a series never repaints
the ones that remain.

Charts stop at the current month for the current year. Card installments are billed
months ahead, so the tail of the year holds scheduled charges and no income —
plotting it would drop the income line to zero and read as a collapse rather than as
"it hasn't happened yet". Those months are not hidden: Hoje lists them under
Compromissos, and Mensal has no date ceiling and shows them in place.

## Recurring charges

**Found by cadence, not by a list of names.** The shipped "Assinaturas digitais"
rule names ten brands and decides a *category*; this decides whether something
*recurs*, which is a different question — it finds services no list contains.
It reads `category_id` and never writes it, so no figure elsewhere moves.

**One charge a month is the load-bearing test.** Grouping uses the same
`matchKeyFor` that rule-learning uses, which prefers `merchantName` and is coarse:
one ride-hailing merchant covers 125 charges across 10 months with perfect monthly
"cadence". Requiring the *median* month to hold exactly one charge is what keeps
every restaurant and petrol station out, while still tolerating a double-billed month.

**Fixed and variable are shown apart, and only fixed has a price.** A password
manager and an electricity bill both recur, but only one will bill the same amount
again — so only the fixed ones are summed into a monthly commitment. A series counts
as fixed when most months repeat the previous month's amount, *not* by the spread of
its whole history: a genuine price rise widens that spread and would classify exactly
the series worth flagging as "variable", suppressing its own detection.

**A price change has to settle on both sides.** A jump counts only if the new amount
holds to the present *and* the old one was a level rather than one odd month.
Without the second half, a double charge followed by a return to normal reads as a
price cut. Once a change has stuck, the series is priced at the new level — the
cheaper months are history, and annualizing a median that still contains them
projects a bill that will never arrive.

**"Parou" needs a whole missed month.** A charge that normally lands on the 31st
simply has not happened yet on the 15th; claiming it stopped after one missing month
would cry wolf every month, for every late-in-month series.

## Pacing

**Same day against the same day.** This month to day 15 is compared against the
first 15 days of each of the previous six months — never against a whole month
prorated. Prorating assumes spending is spread evenly through a month, and it is
not: the condo lands on the 1st and the electricity bill mid-month, so on day 2 a
prorated reference would report the condo at 400% of "expected" every single month.
Cutting both sides at the same day assumes nothing. A 30-day month contributes its
whole total "as of day 31", which is right — it has no day 31.

**Median, and the band around it.** Half of all months sit above a median by
construction, so "above" is not a warning and is never coloured as one. The p25–p75
band is what gives a figure its context: inside it is an ordinary month, whichever
side of the median it fell on.

**Too little history says so.** Four of six months makes a reference; two or three
is shown but labelled short; fewer than two shows the figure with no comparison at
all. A percentage derived from one month is a number pretending to be a reference.

## The review queue

**One stored fact: when you last cleared it.** Everything else is derived at read
time, which is why there is no review table. "New" means `first_seen_at` after that
moment — written once at insert and never updated, even by Pluggy's
delete-and-recreate, which makes it a true "new to this app" watermark. On a first
open everything is new, and the page says the date is when a row *arrived*, not when
it was charged.

**Clearing it is a button.** Marking on arrival would lose a digest to a stray click.

**"Sem regra" had quietly stopped working.** Nothing in the database has
`category_source = 'default'` any more: the Pluggy-hint tier in `resolve()` sits
above the fallback and absorbs everything, so `getUncategorized()` always returned
nothing and the old banner never rendered. The queue therefore treats `'pluggy'`
rows as guesses too, labelled apart from `'default'` ones — one means no rule
matched, the other means no rule of *yours* decided it.

**Outliers are measured against your own record.** A charge is flagged when it
beats the largest you have ever spent at that merchant by 2.5×, on a history of at
least three charges, and is over R$ 50. Against the maximum rather than the median,
because beating a median happens about half the time and would bury the queue.

**Series-level facts expire.** A price change and a series going quiet are facts
about a whole series, so no row-arrival watermark can retire them; without a window
they would return every time the queue was cleared, and a queue that never empties
stops being read. They stay for two months. The permanent list is Recorrentes.

## What is already committed

**Scheduled installments are real rows, not a projection.** Instalment 2 onwards
arrives from Pluggy dated on the due date of the bill that will carry it, so
grouping by date already groups by bill. Hoje reads them straight; nothing is
inferred and nothing is added to the totals, because Mensal is already counting
those same rows in those same months.

**The next bill is estimated, and says so.** Pluggy returns only *closed* bills —
there is no row for the cycle currently collecting, and `balanceDueDate` points at
the last bill that already came due. So the due day comes from the card's own
history and the closing date from `billClosingDate` inside the stored payload,
which has run exactly seven days ahead of the due date on every bill so far.

**Nothing is ever written to the `bills` table.** A projected bill row would be
matched by the card-payment detector, which marks any bank outflow internal when it
lands within fifty centavos and five days of a stored bill — a plausible-looking
projection would silently erase a real payment from every figure in the app. The
projection is computed on read and never stored.

**The sync asks for the future but will not delete in it.** The fetch window now
reaches 400 days ahead so a scheduled installment is re-read on every sync instead
of being frozen at first sight. The deletion sweep still stops at tomorrow: a range
is only authoritative for deletion once it has been observed coming back complete,
and nothing has yet established that a date-ranged query returns future rows at all.
Until it does, a cancelled installment lingers, and Hoje says so rather than
quietly carrying it.

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
npm test            # 515 tests
npm run typecheck
npm run probe       # inspect the live Pluggy API, writes fixtures/
npm run db:migrate
```

To look at the UI without real data:

```bash
FINANCE_DB_PATH=db/demo.db npx tsx src/scripts/demo-seed.ts
FINANCE_DB_PATH=db/demo.db npx next dev --port 3100
```

The demo runs the real pipeline against `FakePluggy`, and is anchored to today's
date rather than a fixed year, so the forward-looking views always have something
in them: an installment plan materialized into months that have not happened, an
open cycle with no bill row, subscriptions billed to the exact centavo (one of
which raises its price partway through), a cancelled one, and at least one item of
every kind the review queue reports.

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
