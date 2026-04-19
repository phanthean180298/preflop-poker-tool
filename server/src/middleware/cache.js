/**
 * Cache middleware for repeated GTO queries.
 * Uses SQLite query_cache table for persistence across restarts.
 * LRU-style: most-hit queries are served fastest.
 */
const { getDB } = require("../utils/db");

function makeCacheKey(params) {
  // Deterministic key from sorted params
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .reduce((o, k) => {
        o[k] = params[k];
        return o;
      }, {})
  );
}

function getCached(key) {
  const db = getDB();
  const row = db
    .prepare("SELECT result FROM query_cache WHERE cache_key = ?")
    .get(key);
  if (row) {
    db.prepare(
      "UPDATE query_cache SET hit_count = hit_count + 1, last_hit = ? WHERE cache_key = ?"
    ).run(Date.now(), key);
    return JSON.parse(row.result);
  }
  return null;
}

function setCache(key, result) {
  const db = getDB();
  db.prepare(
    `
    INSERT INTO query_cache (cache_key, result, hit_count, last_hit)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(cache_key) DO UPDATE SET hit_count = hit_count + 1, last_hit = excluded.last_hit
  `
  ).run(key, JSON.stringify(result), Date.now());
}

module.exports = { makeCacheKey, getCached, setCache };
