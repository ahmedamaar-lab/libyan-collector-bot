CREATE TABLE IF NOT EXISTS deletion_requests (notification_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT);
CREATE TABLE IF NOT EXISTS collector_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deletion_blocks (seller_ref TEXT PRIMARY KEY);
