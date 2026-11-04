import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const machineState = sqliteTable("machine_state", {
  id: text("id").primaryKey(),
  endsAt: integer("ends_at"),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull(),
});
export const users = sqliteTable("tmi_users", {
  id: text("id").primaryKey().notNull(), email: text("email").notNull(),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey().notNull(), userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("auth_sessions_user").on(t.userId), index("auth_sessions_expiry").on(t.expiresAt)]);
export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey().notNull(), browserHash: text("browser_hash").notNull(),
  nonce: text("nonce").notNull(), codeVerifier: text("code_verifier").notNull(),
  returnTo: text("return_to").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("oauth_states_expiry").on(t.expiresAt)]);
export const queueMeta = sqliteTable("queue_meta", {
  id: integer("id").primaryKey(), revision: integer("revision").notNull(), sequence: integer("sequence").notNull(),
  paused: integer("paused").notNull(), writeToken: text("write_token").notNull(),
}, (t) => [check("queue_meta_singleton", sql`${t.id} = 1`)]);
export const queueRecords = sqliteTable("queue_records", {
  kind: text("kind").notNull(), id: text("id").notNull(), pool: text("pool"), ownerId: text("owner_id"),
  participantId: text("participant_id"), status: text("status").notNull(), active: integer("active").notNull(),
  createdAt: integer("created_at").notNull(), data: text("data").notNull(),
}, (t) => [primaryKey({ columns: [t.kind, t.id] }), index("queue_records_active").on(t.active, t.kind),
  index("queue_records_owner").on(t.ownerId, t.kind, sql`${t.createdAt} DESC`),
  index("queue_records_participant").on(t.participantId, t.kind, sql`${t.createdAt} DESC`),
  check("queue_records_json", sql`json_valid(${t.data})`)]);
export const queueRequests = sqliteTable("queue_requests", {
  userId: text("user_id").notNull(), requestId: text("request_id").notNull(),
  command: text("command").notNull(), createdAt: integer("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.requestId] })]);
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey().notNull(), userId: text("user_id").notNull().references(() => users.id),
  p256dh: text("p256dh").notNull(), auth: text("auth").notNull(), active: integer("active").notNull().default(1),
  updatedAt: integer("updated_at").notNull(), lastTestAt: integer("last_test_at").notNull().default(0),
}, (t) => [index("push_subscriptions_user").on(t.userId, t.active)]);
