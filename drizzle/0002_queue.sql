-- Queue transitions use one compare-and-swap token; each entity keeps its own durable history.
CREATE TABLE queue_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  paused INTEGER NOT NULL,
  write_token TEXT NOT NULL
);
CREATE TABLE queue_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  pool TEXT,
  owner_id TEXT,
  participant_id TEXT,
  status TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (kind, id)
);
CREATE INDEX queue_records_active ON queue_records (active, kind);
CREATE INDEX queue_records_owner ON queue_records (owner_id, kind, created_at DESC);
CREATE INDEX queue_records_participant ON queue_records (participant_id, kind, created_at DESC);
CREATE TABLE queue_requests (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
