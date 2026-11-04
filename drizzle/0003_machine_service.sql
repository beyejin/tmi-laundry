ALTER TABLE `machine_state` ADD `out_of_service` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `machine_state` ADD `service_note` text;