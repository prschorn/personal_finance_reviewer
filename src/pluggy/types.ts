/**
 * Hand-written types for the Pluggy API responses we consume.
 *
 * Deliberately not generated: we use a small slice of the API, and hand-written
 * types let us mark the fields whose real-world behaviour we have not yet confirmed
 * against the live API (see src/scripts/probe.ts).
 */

export type ItemStatus =
  | 'UPDATING'
  | 'UPDATED'
  | 'LOGIN_ERROR'
  | 'OUTDATED'
  | 'WAITING_USER_INPUT'
  | (string & {});

export type ExecutionStatus =
  | 'SUCCESS'
  | 'PARTIAL_SUCCESS'
  | 'ERROR'
  | 'MERGE_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CREDENTIALS_MFA'
  | 'ALREADY_LOGGED_IN'
  | 'SITE_NOT_AVAILABLE'
  | 'USER_INPUT_TIMEOUT'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_NEEDS_ACTION'
  | 'WAITING_USER_INPUT'
  | 'USER_AUTHORIZATION_PENDING'
  | 'MERGING'
  | (string & {});

export interface PluggyItem {
  id: string;
  connector?: { id: number; name: string; institutionUrl?: string; imageUrl?: string };
  status: ItemStatus;
  executionStatus: ExecutionStatus;
  lastUpdatedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Open Finance consent expiry. Null means no expiry set by the institution. */
  consentExpiresAt?: string | null;
  error?: { code: string; message: string } | null;
}

export type AccountType = 'BANK' | 'CREDIT';
export type AccountSubtype = 'CHECKING_ACCOUNT' | 'SAVINGS_ACCOUNT' | 'CREDIT_CARD' | (string & {});

export interface PluggyCreditData {
  level?: string | null;
  brand?: string | null;
  balanceCloseDate?: string | null;
  balanceDueDate?: string | null;
  availableCreditLimit?: number | null;
  creditLimit?: number | null;
  minimumPayment?: number | null;
}

export interface PluggyAccount {
  id: string;
  itemId: string;
  type: AccountType;
  subtype: AccountSubtype;
  name: string | null;
  number: string | null;
  balance: number;
  currencyCode: string;
  creditData?: PluggyCreditData | null;
}

export type TransactionType = 'DEBIT' | 'CREDIT';
export type TransactionStatus = 'PENDING' | 'POSTED';

export interface PluggyMerchant {
  name?: string | null;
  businessName?: string | null;
  cnpj?: string | null;
  cnae?: string | null;
  category?: string | null;
}

export interface PluggyPaymentParticipant {
  name?: string | null;
  documentNumber?: { type?: string | null; value?: string | null } | null;
  accountNumber?: string | null;
  branchNumber?: string | null;
  routingNumber?: string | null;
}

export interface PluggyPaymentData {
  payer?: PluggyPaymentParticipant | null;
  receiver?: PluggyPaymentParticipant | null;
  paymentMethod?: string | null; // PIX | TED | DOC | BOLETO
  referenceNumber?: string | null;
  reason?: string | null;
}

export interface PluggyCreditCardMetadata {
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  /** Full purchase price. Never aggregate this — it double-counts against the installments. */
  totalAmount?: number | null;
  purchaseDate?: string | null;
  payeeMCC?: number | null;
  cardNumber?: string | null;
  billId?: string | null;
}

export interface PluggyTransaction {
  id: string;
  accountId: string;
  /** ISO8601 UTC. Usually midnight-UTC standing in for a local date — see lib/date.ts. */
  date: string;
  description: string | null;
  descriptionRaw?: string | null;
  /** Sign is account-type dependent. Normalized once at upsert; never aggregate raw. */
  amount: number;
  amountInAccountCurrency?: number | null;
  currencyCode: string;
  type: TransactionType;
  status?: TransactionStatus | null;
  balance?: number | null;
  providerCode?: string | null;
  /** Null on the free tier (categorization is a paid add-on). Only ever a hint. */
  category?: string | null;
  categoryId?: string | null;
  merchant?: PluggyMerchant | null;
  paymentData?: PluggyPaymentData | null;
  creditCardMetadata?: PluggyCreditCardMetadata | null;
  /** Presence unconfirmed against the live API — the sync watermark does not depend on it. */
  createdAt?: string;
  updatedAt?: string;
}

export interface PluggyBillFinanceCharge {
  type?: string | null;
  amount?: number | null;
  currencyCode?: string | null;
}

export interface PluggyBill {
  id: string;
  dueDate: string | null;
  totalAmount: number | null;
  totalAmountCurrencyCode?: string | null;
  minimumPaymentAmount?: number | null;
  allowsInstallments?: boolean | null;
  financeCharges?: PluggyBillFinanceCharge[] | null;
}

export interface Paged<T> {
  results: T[];
  /** Ready-to-use query string for the next page, or null when exhausted. */
  next?: string | null;
  total?: number;
  totalPages?: number;
  page?: number;
}

export interface TransactionQuery {
  accountId: string;
  /** Cannot be combined with createdAtFrom. */
  dateFrom?: string;
  dateTo?: string;
  /** Returns transactions CREATED since this instant, whatever their date. */
  createdAtFrom?: string;
  ids?: string[];
  /** Test-only: never sent to the API, which rejects it. FakePluggy honours it. */
  pageSize?: number;
}

/**
 * The surface `sync/` depends on. Injected by parameter so the sync layer never
 * calls fetch and can be tested against FakePluggy with no module mocking.
 */
export interface PluggyApi {
  listItems(): Promise<PluggyItem[]>;
  getItem(itemId: string): Promise<PluggyItem>;
  patchItem(itemId: string): Promise<PluggyItem>;
  listAccounts(itemId: string): Promise<PluggyAccount[]>;
  listTransactions(query: TransactionQuery): AsyncIterable<PluggyTransaction[]>;
  listBills(accountId: string): Promise<PluggyBill[]>;
}
