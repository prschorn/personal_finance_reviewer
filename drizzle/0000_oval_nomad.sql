CREATE TABLE `account_sync_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`last_success_at` text,
	`last_deep_scan_at` text,
	`last_sync_run_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text,
	`name` text,
	`number` text,
	`balance_cents` integer,
	`currency_code` text DEFAULT 'BRL' NOT NULL,
	`credit_limit_cents` integer,
	`available_credit_limit_cents` integer,
	`balance_close_date` text,
	`balance_due_date` text,
	`card_brand` text,
	`card_level` text,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`raw_json` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`due_date` text,
	`total_amount_cents` integer,
	`minimum_payment_cents` integer,
	`allows_installments` integer,
	`raw_json` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bills_account` ON `bills` (`account_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`sort_order` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` integer,
	`connector_name` text,
	`status` text,
	`execution_status` text,
	`last_updated_at` text,
	`consent_expires_at` text,
	`last_patch_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	`raw_json` text
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`name` text NOT NULL,
	`match_field` text NOT NULL,
	`match_type` text NOT NULL,
	`match_value` text NOT NULL,
	`account_id` text,
	`account_type` text,
	`direction` text,
	`min_cents` integer,
	`max_cents` integer,
	`set_category_id` integer,
	`set_internal` integer,
	FOREIGN KEY (`set_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rules_priority` ON `rules` (`priority`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`stats_json` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `transaction_overrides` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`category_id` integer,
	`is_internal` integer,
	`note` text,
	`migrated_from` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`date_utc` text NOT NULL,
	`posted_on` text NOT NULL,
	`month` text GENERATED ALWAYS AS (substr(posted_on, 1, 7)) STORED NOT NULL,
	`description` text,
	`description_raw` text,
	`search_text` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`signed_cents` integer NOT NULL,
	`currency_code` text DEFAULT 'BRL' NOT NULL,
	`type` text,
	`status` text NOT NULL,
	`balance_cents` integer,
	`provider_code` text,
	`merchant_name` text,
	`merchant_cnpj` text,
	`payment_method` text,
	`payer_name` text,
	`payer_document` text,
	`receiver_name` text,
	`receiver_document` text,
	`cc_installment_number` integer,
	`cc_total_installments` integer,
	`cc_total_amount_cents` integer,
	`cc_purchase_date` text,
	`cc_bill_id` text,
	`category_id` integer,
	`category_source` text,
	`is_internal` integer DEFAULT false NOT NULL,
	`internal_reason` text,
	`internal_pair_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_run_id` integer NOT NULL,
	`deleted_at` text,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tx_matrix` ON `transactions` (`month`,`category_id`,`signed_cents`) WHERE deleted_at IS NULL AND is_internal = 0;--> statement-breakpoint
CREATE INDEX `idx_tx_acct_day` ON `transactions` (`account_id`,`posted_on`);--> statement-breakpoint
CREATE INDEX `idx_tx_fp` ON `transactions` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_tx_run` ON `transactions` (`account_id`,`last_seen_run_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_bill` ON `transactions` (`cc_bill_id`);