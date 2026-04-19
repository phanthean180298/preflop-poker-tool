const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "../../data/gto.db");
let db;

function initDB() {
  const fs = require("fs");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      stack_bb REAL,
      position TEXT,
      vs_position TEXT,
      action_history TEXT,
      result TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS query_cache (
      cache_key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      hit_count INTEGER DEFAULT 1,
      last_hit INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    NOT NULL,
      ip          TEXT,
      spot        TEXT,
      hand        TEXT,
      strategy    TEXT,
      best_action TEXT,
      fallback    INTEGER DEFAULT 0,
      latency_ms  REAL,
      stage       TEXT,
      stack_bb    REAL,
      bounty      REAL,
      buyin       REAL,
      players_left INTEGER,
      factors     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_created  ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_cache_hit         ON query_cache(hit_count DESC);
    CREATE INDEX IF NOT EXISTS idx_log_spot          ON request_log(spot);
    CREATE INDEX IF NOT EXISTS idx_log_hand          ON request_log(hand);
    CREATE INDEX IF NOT EXISTS idx_log_ts            ON request_log(timestamp);
  `);

  // Migrations: add columns that may not exist in older DB versions
  const migrations = [
    "ALTER TABLE request_log ADD COLUMN best_action TEXT",
    "ALTER TABLE request_log ADD COLUMN stage TEXT",
    "ALTER TABLE request_log ADD COLUMN stack_bb REAL",
    "ALTER TABLE request_log ADD COLUMN bounty REAL",
    "ALTER TABLE request_log ADD COLUMN buyin REAL",
    "ALTER TABLE request_log ADD COLUMN players_left INTEGER",
    "ALTER TABLE request_log ADD COLUMN factors TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (_) {
      /* column already exists — ignore */
    }
  }

  console.log("SQLite DB initialized at", DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error("DB not initialized. Call initDB() first.");
  return db;
}

module.exports = { initDB, getDB };
