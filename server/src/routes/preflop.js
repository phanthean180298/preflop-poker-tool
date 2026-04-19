const express = require("express");
const router = express.Router();
const { query, TABLE_POSITIONS } = require("../engine/preflop");
const { lookupStrategy, loaderStats } = require("../engine/cfr_loader");
const { adjustStrategy, bestAction } = require("../engine/ev");
const {
  parseActionSequence,
  applyMultiwayAdjust,
} = require("../engine/multiway");
const { makeCacheKey, getCached, setCache } = require("../middleware/cache");
const { logAction, getLogStats } = require("../middleware/logger");

/**
 * POST /api/preflop/query
 * Body:
 * {
 *   action: 'rfi' | 'vs_rfi' | 'vs_3bet',
 *   hand: 'AKs' | 'QQ' | '72o' | ...
 *   position: 'EP'|'MP'|'CO'|'BTN'|'SB'|'BB',
 *   vs_position: 'EP'|...|null,   // required for vs_rfi, vs_3bet
 *   stack_bb: number,             // effective stack in BB
 *   ante_bb: number,              // ante size in BB (0 if no ante)
 *   rfi_size_bb: number,          // size of open raise (for vs_rfi)
 *   three_bet_size_bb: number     // size of 3bet (for vs_3bet)
 * }
 */
router.post("/query", (req, res) => {
  try {
    const {
      action,
      hand,
      position,
      vs_position,
      stack_bb,
      ante_bb = 0,
      rfi_size_bb = 2.5,
      three_bet_size_bb = 7.5,
      table_size = 6,
    } = req.body;

    if (!action || !hand || !position || stack_bb == null) {
      return res.status(400).json({
        error: "Missing required fields: action, hand, position, stack_bb",
      });
    }

    const params = {
      action,
      hand: hand.trim(),
      position: position.toUpperCase(),
      vsPosition: vs_position ? vs_position.toUpperCase() : null,
      stackBB: Number(stack_bb),
      anteBB: Number(ante_bb),
      rfiSizeBB: Number(rfi_size_bb),
      threeBetSizeBB: Number(three_bet_size_bb),
      tableSize: Number(table_size),
    };

    const cacheKey = makeCacheKey(params);
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const result = query(params);
    setCache(cacheKey, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/preflop/range?position=BTN&action=rfi&stack_bb=40&ante_bb=0.1
 * Returns full range chart for a position
 */
router.get("/range", (req, res) => {
  try {
    const {
      position,
      action = "rfi",
      stack_bb = 40,
      ante_bb = 0,
      vs_position,
      table_size = 6,
    } = req.query;
    if (!position) return res.status(400).json({ error: "position required" });

    const ranks = [
      "A",
      "K",
      "Q",
      "J",
      "T",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
    ];
    const range = {};

    for (let i = 0; i < ranks.length; i++) {
      for (let j = 0; j < ranks.length; j++) {
        let hand;
        if (i === j) {
          hand = ranks[i] + ranks[j]; // pair
        } else if (i < j) {
          hand = ranks[i] + ranks[j] + "s"; // suited (upper triangle)
        } else {
          hand = ranks[j] + ranks[i] + "o"; // offsuit (lower triangle)
        }

        const params = {
          action,
          hand,
          position: position.toUpperCase(),
          vsPosition: vs_position ? vs_position.toUpperCase() : null,
          stackBB: Number(stack_bb),
          anteBB: Number(ante_bb),
          tableSize: Number(table_size),
        };

        const cacheKey = makeCacheKey(params);
        const cached = getCached(cacheKey);
        const result = cached || query(params);
        if (!cached) setCache(cacheKey, result);
        range[hand] = result;
      }
    }

    res.json({ position, action, stack_bb, table_size, range });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/preflop/positions?table_size=6
 * Returns position list for given table size
 */
router.get("/positions", (req, res) => {
  const { table_size = 6 } = req.query;
  const positions = TABLE_POSITIONS[Number(table_size)] || TABLE_POSITIONS[6];
  res.json({ table_size: Number(table_size), positions });
});

/**
 * POST /api/preflop/action
 * CFR-based strategy lookup (requires solver output JSON to be present).
 *
 * Body:
 * {
 *   "position": "BTN",
 *   "vs": "BB",
 *   "hand": "AKs",
/**
 * POST /api/preflop/action
 *
 * Full tournament-aware decision engine.
 * Accepts both compressed state (hero_pos/villain_pos/spot_type) and
 * legacy params (position/vs/facing).
 *
 * Body (all optional except hand):
 * {
 *   // ── Position / spot ───────────────────────────────────────────
 *   "hero_pos":    "BTN",          // preferred (compressed state)
 *   "villain_pos": "BB",
 *   "spot_type":   "vs_open",      // "open"|"vs_open"|"vs_3bet"|"vs_4bet"
 *   "pot_type":    "SRP",          // "SRP"|"3BP"|"4BP" (informational)
 *   // legacy aliases still accepted:
 *   "position":    "BTN",
 *   "vs":          "BB",
 *   "facing":      "vs_rfi",
 *
 *   "hand": "AKs",
 *
 *   // ── Tournament context (all optional) ─────────────────────────
 *   "stack_bb":          25,
 *   "villain_stack_bb":  18,
 *   "players_left":      120,
 *   "total_players":     1000,
 *   "stage":             "bubble",   // "early"|"mid"|"bubble"|"itm"|"ft"
 *   "bounty":            20,         // villain's bounty prize
 *   "hero_bounty":       15,
 *   "buyin":             10
 * }
 *
 * Response:
 * {
 *   "spot":              "BTN_RFI",
 *   "hand":              "AKs",
 *   "strategy":          { "raise": 0.82, "fold": 0.18 },      // raw CFR
 *   "adjusted_strategy": { "raise": 0.61, "fold": 0.39 },      // tournament-adjusted
 *   "best_action":       "raise",
 *   "factors": {
 *     "icm_risk": 0.58, "bounty_ev": 2.1, "buy_in_factor": 1.0, ...
 *   },
 *   "fallback": false
 * }
 */
// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Auto-detect tournament stage from players_left / total_players ratio.
 * Standard MTT payout: ~15% of field makes money; FT = top ~1%.
 */
function _detectStage(playersLeft, totalPlayers) {
  if (!playersLeft || !totalPlayers || totalPlayers <= 0) return null;
  const ratio = playersLeft / totalPlayers;
  if (ratio > 0.60) return "early";
  if (ratio > 0.20) return "mid";
  if (ratio > 0.08) return "bubble"; // approaching money (15% → bubble zone)
  if (ratio > 0.02) return "itm";
  return "ft";
}

/**
 * Compute the actual BB sizes for each action in a given spot.
 * Mirrors sizing logic in solver/core/game.py.
 * Returns an object like { raise: "2.5BB", fold: "fold" }
 */
function computeActionSizing(spotName, stackBB) {
  if (!spotName) return null;
  const sb = Number(stackBB) || 100;

  const IP_ORDER = { BB: 0, SB: 1, UTG: 2, UTG1: 3, MP: 4, HJ: 5, CO: 6, BTN: 7 };
  function isIp(a, b) { return (IP_ORDER[a] ?? 0) > (IP_ORDER[b] ?? 0); }
  function rfiSize(pos) {
    if (sb <= 15) return sb;
    if (sb <= 20) return 2.0;
    if (sb <= 35) return 2.2;
    return pos === "SB" ? 3.0 : 2.5;
  }
  function tbetSize(rfi, ip) {
    return Math.min(Math.round(rfi * (ip ? 3.0 : 3.5) * 10) / 10, sb);
  }
  function fbetSize(tbet) {
    return Math.min(Math.round(tbet * 2.3 * 10) / 10, sb);
  }
  function bbLabel(n) { return n >= sb ? "allin" : `${n}BB`; }

  const rfiM = spotName.match(/^(\w+)_RFI$/);
  const vs4M = spotName.match(/^(\w+)_vs_4bet_(\w+)$/);
  const vs3M = spotName.match(/^(\w+)_vs_3bet_(\w+)$/);
  const vsRM = spotName.match(/^(\w+)_vs_(\w+)$/);

  if (rfiM) {
    const sz = rfiSize(rfiM[1]);
    return { raise: `raise_${bbLabel(sz)}`, fold: "fold" };
  }
  if (vs4M) {
    const [, actor, opener] = vs4M;
    const rfi = rfiSize(opener);
    const tbet = tbetSize(rfi, isIp(actor, opener));
    const fbet = fbetSize(tbet);
    return { "4bet": `raise_${bbLabel(fbet)}`, call: `call_${bbLabel(tbet)}`, fold: "fold" };
  }
  if (vs3M) {
    const [, opener, tbettor] = vs3M;
    const rfi = rfiSize(opener);
    const tbet = tbetSize(rfi, isIp(tbettor, opener));
    const fbet = fbetSize(tbet);
    return { "4bet": `raise_${bbLabel(fbet)}`, call: `call_${bbLabel(tbet)}`, fold: "fold" };
  }
  if (vsRM) {
    const [, actor, opener] = vsRM;
    const rfi = rfiSize(opener);
    const tbet = tbetSize(rfi, isIp(actor, opener));
    return { "3bet": `raise_${bbLabel(tbet)}`, call: `call_${bbLabel(rfi)}`, fold: "fold" };
  }
  return null;
}

router.post("/action", (req, res) => {
  const t0 = Date.now();

  const {
    // multiway action sequence (new)
    action_sequence,
    table_size: reqTableSize,
    // compressed state
    hero_pos,
    villain_pos,
    spot_type,
    // legacy
    position,
    vs,
    vs_position, // alias for villain_pos / vs
    facing,
    spot,
    // hand
    hand,
    // tournament context
    stack_bb = 100,
    villain_stack_bb = 100,
    players_left = null,
    total_players = null,
    stage = null,          // null → auto-detect from players_left/total_players
    bounty = 0,
    hero_bounty = 0,
    buyin = 10,
  } = req.body;

  // Auto-detect stage from player counts when not explicitly provided
  const resolvedStage =
    stage ||
    _detectStage(Number(players_left), Number(total_players)) ||
    "mid";

  if (!hand) {
    return res.status(400).json({ error: "Missing required field: hand" });
  }

  // ── Parse action_sequence if provided ────────────────────────────────────
  let parsedState = null;
  if (Array.isArray(action_sequence) && action_sequence.length > 0) {
    try {
      parsedState = parseActionSequence(
        action_sequence,
        Number(reqTableSize) || 6
      );
    } catch (e) {
      return res
        .status(400)
        .json({ error: `action_sequence error: ${e.message}` });
    }
  }

  // Resolve position params: action_sequence > compressed state > legacy
  const resolvedPos =
    (parsedState && parsedState.hero_pos) || hero_pos || position || null;
  const resolvedVs =
    (parsedState && parsedState.aggressor_pos) ||
    villain_pos ||
    vs ||
    vs_position ||
    null;
  const resolvedFacing =
    (parsedState && parsedState.spot_type) || spot_type || facing || null;

  const lookup = lookupStrategy({
    spot,
    position: resolvedPos,
    vs: resolvedVs,
    facing: resolvedFacing,
    hand,
    stackBB: Number(stack_bb),
  });

  if (lookup.error) {
    return res.status(400).json({ error: lookup.error });
  }

  // Estimate p_win from hand strength (used by bounty + ICM calcs)
  // Simple: strong hands win more often; EV engine refines this
  const RANKS = "23456789TJQKA";
  function hs(h) {
    if (!h) return 0.5;
    if (h.length === 2) return (RANKS.indexOf(h[0]) + 1) / 13;
    const s = h.endsWith("s"),
      b = h.slice(0, 2);
    const r1 = RANKS.indexOf(b[0]),
      r2 = RANKS.indexOf(b[1]);
    const hi = Math.max(r1, r2),
      lo = Math.min(r1, r2);
    return Math.min(
      1,
      Math.max(0, (hi * 2.5 + lo * 1.5 - (hi - lo) * 1.5 + (s ? 2 : 0)) / 52)
    );
  }
  const pWin = 0.25 + hs(lookup.hand) * 0.55; // scale to [0.25, 0.80]

  const ctx = {
    stage: resolvedStage,
    stackBB: Number(stack_bb),
    villainStackBB: Number(villain_stack_bb),
    playersLeft: players_left != null ? Number(players_left) : 100,
    totalPlayers: total_players != null ? Number(total_players) : 1000,
    bounty: Number(bounty),
    heroBounty: Number(hero_bounty),
    buyIn: Number(buyin),
    pWin,
    spotType: resolvedFacing || "vs_open",
  };

  const { adjusted, factors } = adjustStrategy(lookup.strategy, ctx);

  // ── Multiway adjustment (on top of tournament adjust) ─────────────────────
  let finalStrategy = adjusted;
  let multiwayFactors = null;
  if (
    parsedState &&
    (parsedState.callers_count > 0 || parsedState.pot_type !== "SRP")
  ) {
    const mw = applyMultiwayAdjust(adjusted, parsedState);
    finalStrategy = mw.adjusted;
    multiwayFactors = mw.multiway_factors;
  }

  const best = bestAction(finalStrategy);

  const actionSizing = computeActionSizing(lookup.spot, lookup.stackProfile ?? stack_bb);

  const result = {
    spot: lookup.spot,
    hand: lookup.hand,
    strategy: lookup.strategy,
    adjusted_strategy: finalStrategy,
    best_action: best,
    action_sizing: actionSizing,
    factors,
    stage: resolvedStage,
    stack_profile: lookup.stackProfile ?? 100,
    fallback: lookup.fallback ?? false,
  };
  if (lookup.warning) result.warning = lookup.warning;
  if (multiwayFactors) result.multiway_factors = multiwayFactors;
  if (parsedState) result.parsed_state = parsedState;

  logAction(req, result, Date.now() - t0, req.body);
  res.json(result);
});

/**
 * GET /api/preflop/cfr/stats
 * CFR loader metadata + request log aggregates.
 */
router.get("/cfr/stats", (req, res) => {
  res.json({
    loader: loaderStats(),
    log: getLogStats(),
  });
});

module.exports = router;
