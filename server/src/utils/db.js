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

    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_cache_hit ON query_cache(hit_count DESC);
  `);

  console.log("SQLite DB initialized at", DB_PATH);
  return db;
}

function getDB() {
  if (!db) throw new Error("DB not initialized. Call initDB() first.");
  return db;
}

module.exports = { initDB, getDB };
