import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * All money is INTEGER centavos (see lib/money.ts).
 * All dates are TEXT `YYYY-MM-DD`, which sorts chronologically, so BETWEEN works
 * and no date type is needed.
 */

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * One Pluggy Item = one bank connection. On the free "Meu Pluggy" tier `GET /items`
 * may return 403, in which case rows here originate from the PLUGGY_ITEM_IDS env
 * var or the Settings page instead of from discovery. Either way, this table is
 * the source of truth for what gets synced.
 */
export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  connectorId: integer('connector_id'),
  connectorName: text('connector_name'),
  status: text('status'), // UPDATING | UPDATED | LOGIN_ERROR | OUTDATED | WAITING_USER_INPUT
  executionStatus: text('execution_status'),
  lastUpdatedAt: text('last_updated_at'), // Pluggy's clock, not ours
  consentExpiresAt: text('consent_expires_at'),
  lastPatchAt: text('last_patch_at'), // throttles the manual "refresh from bank" button
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  rawJson: text('raw_json'),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // BANK | CREDIT
  subtype: text('subtype'), // CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD
  name: text('name'),
  number: text('number'),
  balanceCents: integer('balance_cents'),
  currencyCode: text('currency_code').notNull().default('BRL'),
  // Credit-card-only fields
  creditLimitCents: integer('credit_limit_cents'),
  availableCreditLimitCents: integer('available_credit_limit_cents'),
  balanceCloseDate: text('balance_close_date'),
  balanceDueDate: text('balance_due_date'),
  cardBrand: text('card_brand'),
  cardLevel: text('card_level'),
  syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(true),
  rawJson: text('raw_json'),
});

// ---------------------------------------------------------------------------
// Categories, rules, user decisions
// ---------------------------------------------------------------------------

/** Flat, no hierarchy — the spreadsheet this replaces is flat. */
export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  // `income` rows are classified so they stay out of expense totals; they are not rendered.
  kind: text('kind').notNull(), // expense | income | internal
  sortOrder: integer('sort_order').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

export const rules = sqliteTable(
  'rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    priority: integer('priority').notNull(), // ASC; first match wins
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    name: text('name').notNull(),
    matchField: text('match_field').notNull(), // search_text | description | description_raw | merchant_name
    matchType: text('match_type').notNull(), // contains | equals | startsWith | regex
    matchValue: text('match_value').notNull(),
    // Optional narrowing
    accountId: text('account_id'),
    accountType: text('account_type'), // BANK | CREDIT
    direction: text('direction'), // in | out (sign of signed_cents)
    minCents: integer('min_cents'), // on ABS(signed_cents)
    maxCents: integer('max_cents'),
    // Effects
    setCategoryId: integer('set_category_id').references(() => categories.id),
    setInternal: integer('set_internal', { mode: 'boolean' }),
  },
  (t) => [index('idx_rules_priority').on(t.priority, t.id)],
);

/**
 * Manual user decisions, keyed by FINGERPRINT rather than transaction id.
 *
 * Pluggy deletes and recreates transactions (with a new id) whenever date,
 * description or amount shift materially — which is exactly what happens on the
 * PENDING -> POSTED transition. Keying on a stable synthetic fingerprint is what
 * stops every manual categorization evaporating each month.
 */
export const transactionOverrides = sqliteTable('transaction_overrides', {
  fingerprint: text('fingerprint').primaryKey(),
  categoryId: integer('category_id').references(() => categories.id),
  isInternal: integer('is_internal', { mode: 'boolean' }), // tri-state: NULL = no opinion
  note: text('note'),
  migratedFrom: text('migrated_from'), // audit trail for the rescue pass
  updatedAt: text('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const transactions = sqliteTable(
  'transactions',
  {
    // Unique NOW, but not stable over time — see transactionOverrides above.
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),

    dateUtc: text('date_utc').notNull(), // raw, for audit and for recomputing if the policy changes
    postedOn: text('posted_on').notNull(), // local YYYY-MM-DD
    // Generated + stored so it can never drift out of sync with postedOn.
    month: text('month')
      .notNull()
      .generatedAlwaysAs(sql`substr(posted_on, 1, 7)`, { mode: 'stored' }),

    description: text('description'),
    descriptionRaw: text('description_raw'),
    searchText: text('search_text').notNull(), // normalized; drives rules and UI search

    amountCents: integer('amount_cents').notNull(), // as Pluggy gave it
    signedCents: integer('signed_cents').notNull(), // normalized: negative = money left
    currencyCode: text('currency_code').notNull().default('BRL'),
    type: text('type'), // DEBIT | CREDIT
    status: text('status').notNull(), // PENDING | POSTED
    balanceCents: integer('balance_cents'),
    providerCode: text('provider_code'),

    merchantName: text('merchant_name'),
    merchantCnpj: text('merchant_cnpj'),

    /** Pluggy's own classification. A hint only — never overrides a local rule. */
    pluggyCategory: text('pluggy_category'),

    paymentMethod: text('payment_method'), // PIX | TED | DOC | BOLETO
    payerName: text('payer_name'),
    payerDocument: text('payer_document'),
    receiverName: text('receiver_name'),
    receiverDocument: text('receiver_document'),

    ccInstallmentNumber: integer('cc_installment_number'),
    ccTotalInstallments: integer('cc_total_installments'),
    // Full purchase price. NEVER summed into the matrix — that is the double-counting trap.
    ccTotalAmountCents: integer('cc_total_amount_cents'),
    ccPurchaseDate: text('cc_purchase_date'),
    ccBillId: text('cc_bill_id'),

    // Written by the categorization pass, never by the sync upsert.
    categoryId: integer('category_id').references(() => categories.id),
    categorySource: text('category_source'), // manual | rule | structural | default
    isInternal: integer('is_internal', { mode: 'boolean' }).notNull().default(false),
    internalReason: text('internal_reason'), // card_payment | own_transfer | rule | manual
    internalPairId: text('internal_pair_id'),

    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenRunId: integer('last_seen_run_id').notNull(), // drives deletion detection
    deletedAt: text('deleted_at'), // soft delete only

    rawJson: text('raw_json').notNull(),
  },
  (t) => [
    // Partial covering index for the monthly matrix; the query repeats these exact predicates.
    index('idx_tx_matrix')
      .on(t.month, t.categoryId, t.signedCents)
      .where(sql`deleted_at IS NULL AND is_internal = 0`),
    index('idx_tx_acct_day').on(t.accountId, t.postedOn),
    index('idx_tx_fp').on(t.fingerprint),
    index('idx_tx_run').on(t.accountId, t.lastSeenRunId),
    index('idx_tx_bill').on(t.ccBillId),
  ],
);

// ---------------------------------------------------------------------------
// Credit card bills (optional — the free tier may not expose these)
// ---------------------------------------------------------------------------

export const bills = sqliteTable(
  'bills',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    dueDate: text('due_date'),
    totalAmountCents: integer('total_amount_cents'),
    minimumPaymentCents: integer('minimum_payment_cents'),
    allowsInstallments: integer('allows_installments', { mode: 'boolean' }),
    rawJson: text('raw_json'),
  },
  (t) => [index('idx_bills_account').on(t.accountId, t.dueDate)],
);

// ---------------------------------------------------------------------------
// Sync bookkeeping
// ---------------------------------------------------------------------------

export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  trigger: text('trigger').notNull(), // manual | auto
  status: text('status').notNull(), // running | ok | partial | error
  statsJson: text('stats_json'),
  error: text('error'),
});

export const accountSyncState = sqliteTable('account_sync_state', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  lastSuccessAt: text('last_success_at'), // watermark for Window A's createdAtFrom
  lastDeepScanAt: text('last_deep_scan_at'), // drives the monthly full-history rescan
  lastSyncRunId: integer('last_sync_run_id'),
});

/** Small key/value store for app settings that don't deserve their own table. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type Item = typeof items.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type TransactionOverride = typeof transactionOverrides.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
