const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { getDB } = require("../utils/db");

/**
 * POST /api/session/start
 * Start a new session (one tournament or study session)
 */
router.post("/start", (req, res) => {
  const db = getDB();
  const id = uuidv4();
  const { stack_bb, position, metadata } = req.body;
  db.prepare(
    `
    INSERT INTO sessions (id, created_at, stack_bb, position, metadata)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(id, Date.now(), stack_bb, position, JSON.stringify(metadata || {}));
  res.json({ session_id: id });
});

/**
 * POST /api/session/:id/log
 * Log a single hand decision to the session
 */
router.post("/:id/log", (req, res) => {
  const db = getDB();
  const { id } = req.params;
  const { action_history, result, vs_position } = req.body;

  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Session not found" });

  db.prepare(
    `
    UPDATE sessions SET action_history = ?, result = ?, vs_position = ? WHERE id = ?
  `
  ).run(
    JSON.stringify(action_history),
    JSON.stringify(result),
    vs_position,
    id
  );

  res.json({ ok: true });
});

/**
 * GET /api/session/list
 * List recent sessions (last 30)
 */
router.get("/list", (req, res) => {
  const db = getDB();
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 30")
    .all();
  res.json(
    rows.map((r) => ({
      ...r,
      action_history: r.action_history ? JSON.parse(r.action_history) : null,
      result: r.result ? JSON.parse(r.result) : null,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
    }))
  );
});

/**
 * GET /api/session/stats
 * Basic stats: most queried positions, hands, cache hits
 */
router.get("/stats", (req, res) => {
  const db = getDB();
  const totalSessions = db
    .prepare("SELECT COUNT(*) as c FROM sessions")
    .get().c;
  const topCached = db
    .prepare(
      "SELECT cache_key, hit_count FROM query_cache ORDER BY hit_count DESC LIMIT 10"
    )
    .all();
  res.json({ totalSessions, topCached });
});

module.exports = router;
