CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES tmi_users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  last_test_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id, active);
