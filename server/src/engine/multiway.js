/**
 * Multiway Preflop State Engine
 *
 * Handles situations where multiple players act before Hero:
 *   UTG raise → MP call → Hero (BTN)
 *   UTG raise → CO 3bet → Hero (BB)
 *   UTG raise → MP call → CO 3bet → Hero
 *   SB limp → Hero (BB)
 *
 * Design: NO new solver trees.
 * Instead, map complex sequences → compressed state → reuse existing spots.
 * Apply multiway adjustments on top of the base CFR strategy.
 */

"use strict";

const { TABLE_POSITIONS } = require("./preflop");

// Post-flop position order: higher index = more IP (acts later post-flop).
// Pre-flop order: SB/BB post last pre-flop, but act first post-flop.
// We build a separate post-flop order map for IP/OOP detection.
function buildPostflopOrder(positions) {
  // Pre-flop: [..., BTN, SB, BB]
  // Post-flop: SB, BB, UTG, ..., BTN
  const blinds = positions.filter((p) => p === "SB" || p === "BB");
  const nonBlinds = positions.filter((p) => p !== "SB" && p !== "BB");
  const postflopOrder = [...blinds, ...nonBlinds];
  return Object.fromEntries(postflopOrder.map((p, i) => [p, i]));
}

/**
 * Parse a preflop action sequence into a compressed state.
 *
 * @param {Array<{pos: string, action: string}>} actions
 *   - pos:    position name (e.g. "UTG", "CO", "BTN", "BB")
 *   - action: "raise" | "open" | "3bet" | "4bet" | "call" | "limp" | "fold" | "hero"
 *   'hero' marks Hero's position — no action yet, Hero is deciding.
 *
 * @param {number} [tableSize=6]
 *
 * @returns {{
 *   hero_pos: string,
 *   open_pos: string|null,
 *   aggressor_pos: string|null,
 *   callers_count: number,
 *   pot_type: "SRP"|"3BP"|"4BP",
 *   spot_type: "open"|"vs_open"|"vs_3bet"|"vs_4bet",
 *   position_relation: "IP"|"OOP"
 * }}
 *
 * @example
 * // UTG raise → MP call → BTN (hero)
 * parseActionSequence([
 *   { pos: 'UTG', action: 'raise' },
 *   { pos: 'MP',  action: 'call'  },
 *   { pos: 'BTN', action: 'hero'  },
 * ])
 * // → { hero_pos:'BTN', open_pos:'UTG', aggressor_pos:'UTG',
 * //     callers_count:1, pot_type:'SRP', spot_type:'vs_open', position_relation:'IP' }
 *
 * @example
 * // UTG raise → CO 3bet → BTN (hero)
 * parseActionSequence([
 *   { pos: 'UTG', action: 'raise' },
 *   { pos: 'CO',  action: '3bet'  },
 *   { pos: 'BTN', action: 'hero'  },
 * ])
 * // → { hero_pos:'BTN', open_pos:'UTG', aggressor_pos:'CO',
 * //     callers_count:0, pot_type:'3BP', spot_type:'vs_3bet', position_relation:'IP' }
 */
function parseActionSequence(actions, tableSize = 6) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("actions must be a non-empty array of {pos, action}");
  }

  const positions = TABLE_POSITIONS[tableSize] || TABLE_POSITIONS[6];
  const preflopOrder = Object.fromEntries(positions.map((p, i) => [p, i]));
  const postflopOrder = buildPostflopOrder(positions);

  let heroPos = null;
  let openPos = null; // first aggressor (raiser / open-limper)
  let aggressorPos = null; // last aggressor (handles 3bet/4bet)
  let callersCount = 0;
  let betLevel = 0; // 0=no bet, 1=open raise, 2=3bet, 3=4bet

  for (const entry of actions) {
    if (!entry || !entry.pos || !entry.action) {
      throw new Error(`Invalid action entry: ${JSON.stringify(entry)}`);
    }

    const pos = entry.pos.toUpperCase().trim();
    const act = entry.action.toLowerCase().trim();

    if (act === "hero") {
      heroPos = pos;
      continue;
    }

    if (act === "fold") continue;

    if (act === "raise" || act === "open") {
      if (!openPos) openPos = pos;
      aggressorPos = pos;
      betLevel = Math.max(betLevel, 1);
    } else if (act === "3bet") {
      if (!openPos) openPos = pos;
      aggressorPos = pos;
      betLevel = Math.max(betLevel, 2);
    } else if (act === "4bet") {
      aggressorPos = pos;
      betLevel = Math.max(betLevel, 3);
    } else if (act === "limp") {
      // Limp = no raise, but marks open_pos if nobody else opened
      if (!openPos) openPos = pos;
      // aggressorPos stays null (no raise yet)
      betLevel = Math.max(betLevel, 0);
    } else if (act === "call") {
      // Don't count the BB defending post-open as a "caller" in callers_count
      // Only count voluntary callers (i.e. not the BB calling at original 1BB)
      callersCount++;
    }
  }

  if (!heroPos) {
    throw new Error(
      "No 'hero' action found in sequence. Mark Hero's position with action: 'hero'."
    );
  }

  // Determine pot type
  let potType;
  if (betLevel >= 3) potType = "4BP";
  else if (betLevel === 2) potType = "3BP";
  else potType = "SRP";

  // Determine spot type (what Hero is facing)
  let spotType;
  if (!aggressorPos || betLevel === 0) {
    spotType = "open"; // Hero opens or nothing happened
  } else if (potType === "SRP") {
    spotType = "vs_open";
  } else if (potType === "3BP") {
    spotType = "vs_3bet";
  } else {
    spotType = "vs_4bet";
  }

  // IP/OOP: use post-flop position order
  // Higher post-flop index = acts later post-flop = IP
  let positionRelation = "OOP";
  if (aggressorPos && heroPos) {
    const heroPostflop = postflopOrder[heroPos] ?? -1;
    const aggrPostflop = postflopOrder[aggressorPos] ?? -1;
    if (heroPostflop > aggrPostflop) positionRelation = "IP";
  } else if (!aggressorPos && heroPos) {
    // No aggressor yet (hero opening or limp pot): doesn't matter
    positionRelation = "IP";
  }

  return {
    hero_pos: heroPos,
    open_pos: openPos,
    aggressor_pos: aggressorPos,
    callers_count: callersCount,
    pot_type: potType,
    spot_type: spotType,
    position_relation: positionRelation,
  };
}

/**
 * Adjust a base CFR strategy for multiway pots.
 *
 * Principles:
 *  - More callers = more likely someone has a strong hand = reduce bluffs, fold more
 *  - 3BP/4BP multiway = extra tightening on top
 *  - IP reduces the penalty slightly (better to continue in position)
 *
 * The adjustment is additive on fold and multiplicative on aggression.
 *
 * @param {Object} strategy  Base strategy, e.g. { fold: 0.2, call: 0.5, raise: 0.3 }
 * @param {Object} state     Compressed state from parseActionSequence (or manually built)
 * @returns {{ adjusted: Object, multiway_factors: Object }}
 *
 * @example
 * applyMultiwayAdjust({ fold: 0.2, call: 0.5, raise: 0.3 }, {
 *   callers_count: 2,
 *   pot_type: 'SRP',
 *   position_relation: 'IP',
 * })
 * // → adjusted folds more, raises less
 */
function applyMultiwayAdjust(strategy, state) {
  const {
    callers_count = 0,
    pot_type = "SRP",
    position_relation = "OOP",
  } = state;

  // No multiway adjustment needed for heads-up SRP
  if (callers_count === 0 && pot_type === "SRP") {
    return {
      adjusted: { ...strategy },
      multiway_factors: {
        callers_count: 0,
        aggression_penalty: 0,
        fold_boost: 0,
        pot_type,
        position_relation,
      },
    };
  }

  const adj = { ...strategy };
  const actions = Object.keys(adj);

  const aggressiveKey =
    actions.find((a) => a === "raise" || a === "3bet" || a === "4bet") ?? null;
  const foldKey = actions.includes("fold") ? "fold" : null;

  // Per-caller aggression penalty (IP reduces it slightly)
  const ipBonus = position_relation === "IP" ? 0.03 : 0;
  const perCallerPenalty = Math.max(0, 0.14 - ipBonus);

  // Pot-type extra tightening
  const potPenalty = pot_type === "4BP" ? 0.15 : pot_type === "3BP" ? 0.08 : 0;

  // Combined penalty, capped so we never zero out value bets completely
  const aggressionPenalty = Math.min(
    0.72,
    callers_count * perCallerPenalty + potPenalty
  );

  // Fold absorbs the lion's share of removed aggression
  const foldBoost = aggressionPenalty * 0.75;

  if (aggressiveKey !== null) {
    adj[aggressiveKey] = Math.max(
      0,
      adj[aggressiveKey] * (1 - aggressionPenalty)
    );
  }
  if (foldKey !== null) {
    adj[foldKey] = Math.min(1, adj[foldKey] + foldBoost);
  }

  // Re-normalize to sum = 1
  const total = actions.reduce((s, a) => s + Math.max(0, adj[a] ?? 0), 0);
  const normalized = {};
  if (total > 0) {
    for (const [a, v] of Object.entries(adj)) {
      normalized[a] = Math.round((Math.max(0, v) / total) * 10000) / 10000;
    }
  } else {
    for (const a of actions)
      normalized[a] = Math.round(10000 / actions.length) / 10000;
  }

  // Fix floating-point drift on last key
  const normSum = Object.values(normalized).reduce((s, v) => s + v, 0);
  if (normSum !== 1.0 && actions.length > 0) {
    const last = actions[actions.length - 1];
    normalized[last] =
      Math.round((normalized[last] + (1.0 - normSum)) * 10000) / 10000;
  }

  return {
    adjusted: normalized,
    multiway_factors: {
      callers_count,
      aggression_penalty: Math.round(aggressionPenalty * 1000) / 1000,
      fold_boost: Math.round(foldBoost * 1000) / 1000,
      pot_type,
      position_relation,
    },
  };
}

module.exports = { parseActionSequence, applyMultiwayAdjust };
