CREATE TABLE `waitlist_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`nickname` text NOT NULL,
	`owner_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `waitlist_entry_location_created_idx` ON `waitlist_entry` (`location_id`,`created_at`);