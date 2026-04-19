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

/**
 * Multi-stack profiles:
 *   _profiles[stackBB] = Map<"spot:hand", strategy>
 *   _raws[stackBB]     = raw JSON object
 *
 * Falls back to legacy single-file format (100BB only).
 */
let _profiles = {}; // { 15: Map, 20: Map, 25: Map, ... }
let _raws = {}; // { 15: raw, 20: raw, ... }
let _version = null;
let _loadMs = 0;

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

// ─── Position aliasing ────────────────────────────────────────────────────────
//
// The CFR solver is trained on 8-max positions:
//   UTG, UTG1, MP, HJ, CO, BTN, SB, BB
//
// The app front-end uses shorter 6-max labels that must be mapped to solver names.
// Mapping rationale (positions-before-button):
//   EP (1st in 6-max, 3 behind BTN) → UTG (1st in 8-max)
//   MP (2nd in 6-max, 2 behind BTN) → HJ  (4th in 8-max, also 2 behind BTN)
//   CO, BTN, SB, BB — same in both

const POS_ALIAS = {
  EP: "UTG",
  UTG2: "UTG", // 9-max alias
};

function normalizePos(pos) {
  if (!pos) return pos;
  const p = pos.toUpperCase().trim();
  return POS_ALIAS[p] || p;
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
  const pos = normalizePos(position || "");
  const opp = normalizePos(vs || "");
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
 * Automatically detects multi-stack subdirs (stack_15/, stack_30/, …) and
 * falls back to legacy single-file format for older versions.
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

  const vDir = path.join(SOLVER_OUTPUT, version);
  if (!fs.existsSync(vDir)) {
    console.warn(`[cfr_loader] Version directory not found: ${vDir}`);
    return false;
  }

  const t0 = Date.now();
  const newProfiles = {};
  const newRaws = {};

  // ── Try multi-stack subdirs first ─────────────────────────────────────────
  let found = false;
  try {
    for (const entry of fs.readdirSync(vDir)) {
      const m = entry.match(/^stack_(\d+)$/);
      if (!m) continue;
      const stackBB = parseInt(m[1], 10);
      const stratFile = path.join(vDir, entry, "preflop_strategies.json");
      if (!fs.existsSync(stratFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(stratFile, "utf8"));
        newProfiles[stackBB] = _buildLookupMap(raw);
        newRaws[stackBB] = raw;
        found = true;
      } catch (e) {
        console.warn(`[cfr_loader] Failed to load ${stratFile}: ${e.message}`);
      }
    }
  } catch (_) {}

  // ── Fall back to legacy single-file format ─────────────────────────────────
  if (!found) {
    const stratFile = path.join(vDir, "preflop_strategies.json");
    if (!fs.existsSync(stratFile)) {
      console.warn(`[cfr_loader] No strategy files found in: ${vDir}`);
      return false;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(stratFile, "utf8"));
      newProfiles[100] = _buildLookupMap(raw);
      newRaws[100] = raw;
    } catch (e) {
      console.error("[cfr_loader] Failed to parse strategy file:", e.message);
      return false;
    }
  }

  _profiles = newProfiles;
  _raws = newRaws;
  _version = version;
  _loadMs = Date.now() - t0;

  const stackList = Object.keys(_profiles)
    .sort((a, b) => +a - +b)
    .join(", ");
  const totalEntries = Object.values(_profiles).reduce((s, m) => s + m.size, 0);
  console.log(
    `[cfr_loader] Loaded version=${version}  ` +
      `stacks=[${stackList}]BB  ` +
      `total_entries=${totalEntries}  load=${_loadMs}ms`
  );
  return true;
}

// ─── Closest stack profile ────────────────────────────────────────────────────

function _closestStack(stackBB) {
  const keys = Object.keys(_profiles).map(Number);
  if (keys.length === 0) return null;
  return keys.reduce((best, k) =>
    Math.abs(k - stackBB) < Math.abs(best - stackBB) ? k : best
  );
}

// Eager load on require
loadVersion();

// ─── Auto hot-reload on SIGUSR1 or file change ────────────────────────────────

let _watcher = null;

/**
 * Watch the current strategy file and reload when it changes.
 * Also triggers on SIGUSR1 (sent by train.py --reload).
 */
function startWatcher() {
  if (_watcher) return;

  // Handle SIGUSR1 → immediate reload
  process.on("SIGUSR1", () => {
    console.log("[cfr_loader] SIGUSR1 received — reloading strategies…");
    loadVersion();
  });

  // Watch VERSION_FILE for changes (train.py writes this last)
  if (fs.existsSync(VERSION_FILE)) {
    try {
      _watcher = fs.watch(VERSION_FILE, { persistent: false }, (event) => {
        if (event === "change") {
          // Debounce: wait 200ms for file writes to settle
          if (_watcher._debounce) clearTimeout(_watcher._debounce);
          _watcher._debounce = setTimeout(() => {
            console.log(
              "[cfr_loader] version.json changed — reloading strategies…"
            );
            loadVersion();
          }, 200);
        }
      });
    } catch (_) {
      // fs.watch not available in all environments — silent fallback
    }
  }
}

startWatcher();

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
 * @param {number} [opts.stackBB]   Effective stack in BB (picks closest profile, default 100)
 * @returns {{ spot, hand, strategy, stackProfile?, fallback? } | { error }}
 */
function lookupStrategy({ spot, position, vs, facing, hand, stackBB = 100 }) {
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

  const profileKeys = Object.keys(_profiles).map(Number);
  if (profileKeys.length > 0) {
    const closestStack = _closestStack(stackBB);
    const map = _profiles[closestStack];

    // Try primary spot, then MP→HJ alias fallback
    const strategy =
      map &&
      (map.get(`${resolvedSpot}:${normalHand}`) ||
        map.get(`${resolvedSpot.replace(/\bMP\b/g, "HJ")}:${normalHand}`));
    if (strategy) {
      const usedSpot = map.get(`${resolvedSpot}:${normalHand}`)
        ? resolvedSpot
        : resolvedSpot.replace(/\bMP\b/g, "HJ");
      return {
        spot: usedSpot,
        hand: normalHand,
        strategy,
        stackProfile: closestStack,
      };
    }
  }

  // Fallback: heuristic strategy so the API never hard-errors
  return {
    spot: resolvedSpot,
    hand: normalHand,
    strategy: fallbackStrategy(resolvedSpot, normalHand),
    fallback: true,
    warning:
      profileKeys.length > 0
        ? `Spot/hand not in CFR data (${resolvedSpot}:${normalHand}), using heuristic fallback.`
        : "CFR data not loaded, using heuristic fallback.",
  };
}

/** Returns loader health stats (for /health or monitoring). */
function loaderStats() {
  const stacks = Object.keys(_profiles)
    .map(Number)
    .sort((a, b) => a - b);
  const totalEntries = Object.values(_profiles).reduce((s, m) => s + m.size, 0);
  const firstRaw = stacks.length > 0 ? _raws[stacks[0]] : null;
  return {
    loaded: stacks.length > 0,
    version: _version,
    stacks,
    entries: totalEntries,
    load_ms: _loadMs,
    spots: firstRaw?.spots ?? 0,
    hands: firstRaw?.hands ?? 0,
    generated_at: firstRaw?.generated_at ?? null,
    iterations: firstRaw?.iterations ?? null,
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
