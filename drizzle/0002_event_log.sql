CREATE TABLE `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`location_id` text NOT NULL,
	`machine_id` text,
	`minutes` integer,
	`prev_remaining_sec` integer
);
--> statement-breakpoint
CREATE INDEX `event_log_location_at_idx` ON `event_log` (`location_id`,`at`);--> statement-breakpoint
CREATE INDEX `event_log_at_idx` ON `event_log` (`at`);--> statement-breakpoint
CREATE INDEX `event_log_machine_kind_at_idx` ON `event_log` (`machine_id`,`kind`,`at`);