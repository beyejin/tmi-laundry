import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const machineState = sqliteTable("machine_state", {
  id: text("id").primaryKey(),
  endsAt: integer("ends_at"),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull(),
});
