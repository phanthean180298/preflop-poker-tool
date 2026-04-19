/**
 * CFR Strategy Loader — production-ready
 *
 * Features:
 *   - Reads version.json to find current strategy version
 *   - Loads compact format (arrays) on startup, once
 *   - Builds flat Map<"spot:hand", strategy> → O(1) lookup
 *   - Hand normalization (case-insensitive, rank-ordered)
 *   - Spot resolution from (position, vs, facing)
 *   - Fallback strategy (hand-strength heuristic) when solver data missing
 *   - Rollback support: loadVersion(tag)
 */

"use strict";

const path = require("path");
const fs = require("fs");

// ─── Paths ────────────────────────────────────────────────────────────────────

const SOLVER_OUTPUT = path.resolve(__dirname, "../../../solver/output");
const VERSION_FILE = path.join(SOLVER_OUTPUT, "version.json");

// ─── In-memory state ─────────────────────────────────────────────────────────

/** @type {Map<string, Object>|null} Flat lookup map "spot:hand" → strategy */
let _lookup = null;
/** @type {Object|null} Full parsed JSON (schema + data) */
let _raw = null;
/** @type {string|null} Currently loaded version tag */
let _version = null;
/** Load time in ms */
let _loadMs = 0;
/** Number of entries in the map */
let _entries = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RANKS = "23456789TJQKA";

/**
 * Normalize hand string.
 * "aks" → "AKs",  "aa" → "AA",  "72O" → "72o",  "ka" → "AKo" (reordered)
 */
function normalizeHand(hand) {
  if (!hand || typeof hand !== "string") return null;
  const h = hand.trim();

  if (h.length === 2) {
    const b = h.toUpperCase();
    if (RANKS.indexOf(b[0]) < 0) return null;
    return b;
  }

  if (h.length === 3) {
    const body = h.slice(0, 2).toUpperCase();
    const suffix = h[2].toLowerCase();
    if (suffix !== "s" && suffix !== "o") return null;
    const r1 = RANKS.indexOf(body[0]);
    const r2 = RANKS.indexOf(body[1]);
    if (r1 < 0 || r2 < 0) return null;
    const hi = r1 >= r2 ? body[0] : body[1];
    const lo = r1 >= r2 ? body[1] : body[0];
    return hi + lo + suffix;
  }

  return null;
}

/**
 * Resolve spot name from (position, vs, facing) OR from a compressed state object.
 *
 * Compressed state (from spec):
 *   { hero_pos, villain_pos, spot_type: "open"|"vs_open"|"vs_3bet"|"vs_4bet" }
 *
 * Legacy params:
 *   position, vs, facing: "rfi"|"vs_rfi"|"3bet"|"4bet"
 *
 * Spot name format (matches solver output):
 *   BTN_RFI
 *   BB_vs_BTN
 *   BTN_vs_3bet_BB
 *   BB_vs_4bet_BTN
 */
function resolveSpot(position, vs, facing) {
  const pos = (position || "").toUpperCase().trim();
  const opp = (vs || "").toUpperCase().trim();
  const face = (facing || "").toLowerCase().trim();

  // spot_type aliases (compressed state)
  if (!face || face === "rfi" || face === "open") {
    if (pos) return `${pos}_RFI`;
  }
  if (
    face === "vs_open" ||
    face === "vs_rfi" ||
    face === "call" ||
    face === "defend"
  ) {
    if (pos && opp) return `${pos}_vs_${opp}`;
  }
  if (face === "3bet" || face === "vs_3bet") {
    if (pos && opp) return `${pos}_vs_3bet_${opp}`;
  }
  if (face === "4bet" || face === "vs_4bet") {
    if (pos && opp) return `${pos}_vs_4bet_${opp}`;
  }
  if (pos && opp) return `${pos}_vs_${opp}`;
  return null;
}

// ─── Fallback strategy (hand-strength heuristic) ─────────────────────────────

const _RANK_VAL = Object.fromEntries(
  [..."23456789TJQKA"].map((r, i) => [r, i])
);

function _handStrength(hand) {
  if (!hand) return 0;
  if (hand.length === 2) return (_RANK_VAL[hand[0]] + 1) / 13.0;
  const suited = hand.endsWith("s");
  const body = hand.slice(0, 2);
  const r1 = _RANK_VAL[body[0]] ?? 0;
  const r2 = _RANK_VAL[body[1]] ?? 0;
  const hi = Math.max(r1, r2),
    lo = Math.min(r1, r2);
  const gap = hi - lo;
  const score = (hi * 2.5 + lo * 1.5 - gap * 1.5) / 52.0 + (suited ? 0.04 : 0);
  return Math.min(1.0, Math.max(0.0, score));
}

function _r4(n) {
  return Math.round(n * 10000) / 10000;
}

function fallbackStrategy(spot, hand) {
  const s = _handStrength(hand);
  const u = (spot || "").toUpperCase();

  if (u.includes("_RFI")) {
    const r = _r4(Math.min(1, Math.max(0, (s - 0.2) / 0.6)));
    return { raise: r, fold: _r4(1 - r) };
  }
  if (u.includes("VS_4BET")) {
    const c = _r4(Math.min(1, Math.max(0, (s - 0.4) / 0.5)));
    return { fold: _r4(1 - c), call: c };
  }
  if (u.includes("VS_3BET")) {
    const fold = _r4(Math.max(0, 1 - s * 1.2));
    const call = _r4(s * 0.3);
    return { fold, call, "4bet": _r4(Math.max(0, 1 - fold - call)) };
  }
  // vs_RFI
  const fold = _r4(Math.max(0, 0.9 - s * 1.1));
  const three = _r4(s > 0.6 ? s * 0.4 : 0);
  return { fold, call: _r4(Math.max(0, 1 - fold - three)), "3bet": three };
}

// ─── Load ─────────────────────────────────────────────────────────────────────

function _buildLookupMap(raw) {
  const schema = raw.schema || {};
  const data = raw.data || {};
  const map = new Map();

  for (const [spot, actions] of Object.entries(schema)) {
    const hands = data[spot];
    if (!hands) continue;
    for (const [hand, probs] of Object.entries(hands)) {
      const strategy = {};
      for (let i = 0; i < actions.length; i++) {
        strategy[actions[i]] = probs[i];
      }
      map.set(`${spot}:${hand}`, strategy);
    }
  }

  return map;
}

/**
 * Load strategies from a version tag (null = read from version.json).
 * Returns true on success.
 */
function loadVersion(tag = null) {
  let version = tag;

  if (!version) {
    if (!fs.existsSync(VERSION_FILE)) {
      console.warn(
        "[cfr_loader] version.json not found. Run the solver first."
      );
      return false;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
      version = meta.current;
    } catch (e) {
      console.warn("[cfr_loader] Failed to parse version.json:", e.message);
      return false;
    }
    if (!version) {
      console.warn("[cfr_loader] No current version in version.json.");
      return false;
    }
  }

  const stratFile = path.join(
    SOLVER_OUTPUT,
    version,
    "preflop_strategies.json"
  );
  if (!fs.existsSync(stratFile)) {
    console.warn(`[cfr_loader] Strategy file not found: ${stratFile}`);
    return false;
  }

  const t0 = Date.now();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(stratFile, "utf8"));
  } catch (e) {
    console.error("[cfr_loader] Failed to parse strategy file:", e.message);
    return false;
  }

  const map = _buildLookupMap(raw);

  _raw = raw;
  _lookup = map;
  _version = version;
  _loadMs = Date.now() - t0;
  _entries = map.size;

  console.log(
    `[cfr_loader] Loaded version=${version}  ` +
      `spots=${raw.spots}  hands=${raw.hands}  ` +
      `entries=${map.size}  load=${_loadMs}ms`
  );
  return true;
}

// Eager load on require
loadVersion();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a strategy.
 *
 * @param {Object} opts
 * @param {string} [opts.spot]      Explicit spot name (overrides position/vs/facing)
 * @param {string} [opts.position]  Acting player position e.g. "BTN"
 * @param {string} [opts.vs]        Opponent position e.g. "BB"
 * @param {string} [opts.facing]    "rfi" | "vs_rfi" | "3bet" | "4bet" | null
 * @param {string}  opts.hand       Hand class e.g. "AKs", "AA"
 * @returns {{ spot, hand, strategy, fallback? } | { error }}
 */
function lookupStrategy({ spot, position, vs, facing, hand }) {
  const resolvedSpot = spot || resolveSpot(position, vs, facing);
  if (!resolvedSpot) {
    return {
      error: `Cannot resolve spot (position=${position}, vs=${vs}, facing=${facing})`,
    };
  }

  const normalHand = normalizeHand(hand);
  if (!normalHand) {
    return { error: `Invalid hand: ${hand}` };
  }

  if (_lookup) {
    const strategy = _lookup.get(`${resolvedSpot}:${normalHand}`);
    if (strategy) {
      return { spot: resolvedSpot, hand: normalHand, strategy };
    }
  }

  // Fallback: heuristic strategy so the API never hard-errors
  return {
    spot: resolvedSpot,
    hand: normalHand,
    strategy: fallbackStrategy(resolvedSpot, normalHand),
    fallback: true,
    warning: _lookup
      ? `Spot/hand not in CFR data (${resolvedSpot}:${normalHand}), using heuristic fallback.`
      : "CFR data not loaded, using heuristic fallback.",
  };
}

/** Returns loader health stats (for /health or monitoring). */
function loaderStats() {
  return {
    loaded: _lookup !== null,
    version: _version,
    entries: _entries,
    load_ms: _loadMs,
    spots: _raw?.spots ?? 0,
    hands: _raw?.hands ?? 0,
    generated_at: _raw?.generated_at ?? null,
    iterations: _raw?.iterations ?? null,
  };
}

module.exports = {
  lookupStrategy,
  loadVersion,
  loaderStats,
  normalizeHand,
  resolveSpot,
  fallbackStrategy,
};
