import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const machineState = sqliteTable("machine_state", {
  id: text("id").primaryKey(),
  endsAt: integer("ends_at"),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull(),
});

export const waitlistEntry = sqliteTable("waitlist_entry", {
  id: text("id").primaryKey(),
  locationId: text("location_id").notNull(),
  nickname: text("nickname").notNull(),
  ownerHash: text("owner_hash").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("waitlist_entry_location_created_idx").on(table.locationId, table.createdAt)]);
