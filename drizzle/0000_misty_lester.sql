CREATE TABLE `machine_state` (
	`id` text PRIMARY KEY NOT NULL,
	`ends_at` integer,
	`updated_at` integer NOT NULL,
	`version` integer NOT NULL
);
