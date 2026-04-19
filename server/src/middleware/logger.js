/**
 * Request logger middleware.
 *
 * Logs every preflop /action request to SQLite (request_log table).
 * Fields stored can later power an exploit analysis system:
 *   - which hands/spots users query most
 *   - latency distribution
 *   - strategy delivered (CFR vs fallback)
 *
 * Usage:
 *   const { logAction } = require("./logger");
 *   router.post("/action", (req, res) => {
 *     const t0 = Date.now();
 *     ... compute result ...
 *     logAction(req, result, Date.now() - t0);
 *     res.json(result);
 *   });
 */

"use strict";

const { getDB } = require("../utils/db");

/**
 * Log a preflop /action request.
 *
 * @param {import("express").Request} req
 * @param {Object} result     - { spot, hand, strategy, best_action, fallback?, factors? }
 * @param {number} latencyMs  - response time in ms
 * @param {Object} [ctx]      - tournament context from request body
 */
function logAction(req, result, latencyMs, ctx = {}) {
  try {
    const db = getDB();
    db.prepare(
      `
      INSERT INTO request_log
        (timestamp, ip, spot, hand, strategy, best_action,
         fallback, latency_ms, stage, stack_bb, bounty, buyin,
         players_left, factors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      new Date().toISOString(),
      req.ip || req.socket?.remoteAddress || "unknown",
      result.spot || null,
      result.hand || null,
      result.strategy ? JSON.stringify(result.strategy) : null,
      result.best_action || null,
      result.fallback ? 1 : 0,
      Math.round(latencyMs * 100) / 100,
      ctx.stage ?? null,
      ctx.stack_bb ?? null,
      ctx.bounty ?? null,
      ctx.buyin ?? null,
      ctx.players_left ?? null,
      result.factors ? JSON.stringify(result.factors) : null
    );
  } catch (err) {
    console.warn("[logger] Failed to log request:", err.message);
  }
}

/**
 * Returns aggregated stats from request_log.
 * Useful for exploit analysis / monitoring.
 */
function getLogStats({ limit = 1000 } = {}) {
  try {
    const db = getDB();
    const total = db.prepare("SELECT COUNT(*) AS n FROM request_log").get().n;
    const topSpots = db
      .prepare(
        `
      SELECT spot, COUNT(*) AS count
      FROM request_log
      WHERE spot IS NOT NULL
      GROUP BY spot ORDER BY count DESC LIMIT 10
    `
      )
      .all();
    const topHands = db
      .prepare(
        `
      SELECT hand, COUNT(*) AS count
      FROM request_log
      WHERE hand IS NOT NULL
      GROUP BY hand ORDER BY count DESC LIMIT 10
    `
      )
      .all();
    const latency = db
      .prepare(
        `
      SELECT
        ROUND(AVG(latency_ms), 2)                       AS mean_ms,
        ROUND(MIN(latency_ms), 2)                       AS min_ms,
        ROUND(MAX(latency_ms), 2)                       AS max_ms,
        COUNT(CASE WHEN latency_ms > 50 THEN 1 END)     AS slow_count
      FROM request_log
    `
      )
      .get();
    const fallbacks = db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM request_log WHERE fallback = 1
    `
      )
      .get().n;

    return { total, fallbacks, latency, topSpots, topHands };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { logAction, getLogStats };
