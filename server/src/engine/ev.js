/**
 * EV Engine — Tournament adjustments for preflop strategy.
 *
 * Pipeline:
 *   chipEV (from CFR)
 *   → × ICM risk factor     (stage-based)
 *   → + bounty EV           (PKO)
 *   → × buy-in factor       (player tendencies)
 *   = totalEV
 *
 * All functions are pure and synchronous — no I/O.
 */

"use strict";

// ─── 1. ICM Risk Factor ───────────────────────────────────────────────────────
//
// Approximates the $ value lost per chip-EV unit due to ICM pressure.
// Risk factor < 1 means each chip risked is worth less than face value.
//
// Basis: Malmuth-Harville approximation, simplified to stage buckets.
// "early"  → ICM pressure near zero (chip-EV ≈ $EV)
// "bubble" → maximum risk aversion (chip-EV >> $EV)
// "ft"     → high risk but bounty/pay-jump corrects upward in PKO

const ICM_RISK = {
  early: 1.0,
  mid: 0.92,
  bubble: 0.58,
  itm: 0.76,
  ft: 0.52,
};

// Dynamic risk: tightens further when stack is short vs field avg
function icmRiskFactor({
  stage = "mid",
  stackBB = 25,
  playersLeft = 100,
  totalPlayers = 1000,
}) {
  const base = ICM_RISK[stage] ?? ICM_RISK.mid;

  // Bubble factor: more pressure when near money, bigger field
  if (stage === "bubble") {
    const fieldSize = totalPlayers > 0 ? Math.log10(totalPlayers) : 1;
    const distanceFactor = Math.max(0.5, 1 - 5 / Math.max(1, playersLeft));
    return Math.max(0.35, (base * distanceFactor) / (fieldSize * 0.15 + 0.85));
  }

  // Short-stack correction: short stacks care less about ICM (shove-or-fold territory)
  if (stackBB <= 15) {
    return Math.min(1.0, base + 0.15);
  }

  return base;
}

// ─── 2. Bounty EV (PKO) ───────────────────────────────────────────────────────
//
// Formula:
//   bountyEV = p_win × villain_bounty × bounty_fraction
//   bounty_fraction = bountySize / buyIn  (how big bounty is relative to buy-in)
//
// p_win is estimated from hand strength score passed in.
// This is added on top of chip EV — bounty is a pure upside that
// doesn't factor into ICM chip risk.

function bountyEV({
  pWin = 0.5, // estimated equity vs villain
  villainBounty = 0, // villain's bounty prize ($)
  heroBounty = 0, // hero's bounty (affects hero's own risk when called)
  buyIn = 10, // tournament buy-in ($)
  stackBB = 25, // effective stack (for coverage check)
  effectiveStack = null, // override if different
}) {
  if (!villainBounty || villainBounty <= 0) return 0;

  const effStack = effectiveStack ?? stackBB;

  // Fraction of buy-in the bounty represents
  const bountyFrac = buyIn > 0 ? villainBounty / buyIn : 0;

  // Coverage multiplier: if villain is covered (we have more chips),
  // chance of capturing bounty ≈ p_win.
  // If we're the shorter stack, we only capture if we bust them, which
  // in a coinflip is approximately p_win × coverage_ratio.
  const coverageRatio = Math.min(1, effStack / Math.max(effStack, 20));

  // Bounty value we expect to capture
  const expectedCapture = pWin * coverageRatio * villainBounty;

  // Hero risk: we also have a bounty on our head.
  // The opponent gets heroBounty × (1 − p_win) if they bust us.
  // This creates an asymmetric incentive: opponent calls wider vs us.
  // We model this as a slight downward pressure on our adjusted EV.
  const heroBountyRisk =
    heroBounty > 0 ? (1 - pWin) * (heroBounty / buyIn) * 0.3 : 0;

  return expectedCapture * bountyFrac - heroBountyRisk;
}

// ─── 3. Buy-in Factor ─────────────────────────────────────────────────────────
//
// High buy-in → players are more risk-averse → we should be slightly tighter
// when bluffing, but also can exploit their tightness with more thin value.
//
// Low buy-in ($1–$5) → recreational players → call wider → less bluffing.
// High buy-in ($200+) → regulars → fold to aggression more → more bluffing.
//
// Returns a multiplier on aggression:
//   < 1 → reduce bluff frequency
//   > 1 → increase bluff frequency / 3bet / isolation

function buyInFactor(buyIn = 10) {
  if (buyIn <= 0) return 1.0;
  // Logistic curve centered around $10
  // $1  → 0.82 (rec pool, tighten bluffs)
  // $10 → 1.00 (neutral)
  // $50 → 1.08 (good reg pool, slight more bluff)
  // $200→ 1.14 (tough pool, significantly more bluff vs their tight folds)
  const x = Math.log10(Math.max(0.1, buyIn)); // 0 at $1, 2 at $100
  return 0.82 + 0.16 * Math.min(1, x / 2);
}

// ─── 4. Stack Pressure ────────────────────────────────────────────────────────
//
// SPR (Stack-to-Pot Ratio) affects calling/folding thresholds.
// Very short stacks → push-or-fold, widen shove/call ranges.

function stackPressureFactor(stackBB = 25) {
  if (stackBB <= 10) return 1.35; // shove-or-fold: widen significantly
  if (stackBB <= 15) return 1.18;
  if (stackBB <= 20) return 1.08;
  if (stackBB >= 80) return 0.95; // deep: tighten opening, more 3bet/fold
  return 1.0;
}

// ─── 5. Total EV ──────────────────────────────────────────────────────────────
//
// totalEV = chipEV × icmRisk + bountyEV
//
// Note: chipEV here is in bb units from the CFR solver.
// bountyEV is in $ units but normalized to buy-in for comparison.

function totalEV({ chipEV, icmRisk, bEV }) {
  return chipEV * icmRisk + bEV;
}

// ─── 6. Strategy Adjuster ─────────────────────────────────────────────────────
//
// Takes base CFR strategy {fold, call, raise/3bet/4bet}
// Applies tournament context adjustments.
// Returns adjusted strategy (re-normalized).
//
// Adjustment principles:
//   bubble    → reduce bluff freq (reduce raise/3bet/4bet for marginal hands)
//   bounty    → increase call/shove freq when bounty EV is significant
//   short stk → increase shove freq
//   rec pool  → reduce bluff freq
//   deep/tough→ increase 3bet/fold combos

/**
 * @param {Object} baseStrategy    e.g. { fold: 0.3, call: 0.4, raise: 0.3 }
 * @param {Object} ctx             tournament context
 * @returns {{ adjusted: Object, factors: Object }}
 */
function adjustStrategy(baseStrategy, ctx) {
  const {
    stage = "mid",
    stackBB = 25,
    villainStackBB = 25,
    playersLeft = 100,
    totalPlayers = 1000,
    bounty = 0, // villain bounty
    heroBounty = 0,
    buyIn = 10,
    pWin = 0.5,
    spotType = "vs_open", // open | vs_open | vs_3bet | vs_4bet
  } = ctx;

  const icmRisk = icmRiskFactor({ stage, stackBB, playersLeft, totalPlayers });
  const bEV = bountyEV({
    pWin,
    villainBounty: bounty,
    heroBounty,
    buyIn,
    stackBB,
  });
  const buyFactor = buyInFactor(buyIn);
  const stkFactor = stackPressureFactor(stackBB);
  const effStack = Math.min(stackBB, villainStackBB);

  // ── Copy base strategy ─────────────────────────────────────────────────────
  const adj = { ...baseStrategy };
  const actions = Object.keys(adj);

  // Determine which action is "aggressive" (raise / 3bet / 4bet / shove)
  const aggressiveKey =
    actions.find((a) => a === "raise" || a === "3bet" || a === "4bet") ?? null;
  const foldKey = actions.includes("fold") ? "fold" : null;
  const callKey = actions.includes("call") ? "call" : null;

  // ── Apply adjustments ──────────────────────────────────────────────────────
  let aggrMult = buyFactor * stkFactor;

  // ICM risk reduction: tighten aggression on bubble/ft
  if (icmRisk < 0.7) {
    // Bubble / FT: reduce bluffs, keep value bets
    // We reduce aggression proportional to how low pWin is (bluff = low pWin)
    const bluffPenalty = pWin < 0.52 ? (1 - icmRisk) * 0.8 : 0;
    aggrMult *= 1 - bluffPenalty;
  }

  // Bounty bonus: if bEV is meaningful, shift toward call/raise
  const bountyBonus = bEV > 0.5 ? Math.min(0.2, bEV / buyIn) : 0;

  // Apply to aggressive action
  if (aggressiveKey && adj[aggressiveKey] !== undefined) {
    adj[aggressiveKey] = Math.max(
      0,
      adj[aggressiveKey] * aggrMult + bountyBonus * 0.6
    );
  }

  // Bounty also boosts call
  if (callKey && adj[callKey] !== undefined && bEV > 0.3) {
    adj[callKey] = Math.min(1, adj[callKey] + bountyBonus * 0.4);
  }

  // Short-stack push/fold: collapse strategy toward raise/fold only
  if (effStack <= 12 && spotType !== "vs_4bet") {
    // Merge call into raise
    if (callKey && aggressiveKey) {
      adj[aggressiveKey] =
        (adj[aggressiveKey] ?? 0) + (adj[callKey] ?? 0) * 0.7;
      adj[callKey] = (adj[callKey] ?? 0) * 0.3;
    }
  }

  // ── Re-normalize ───────────────────────────────────────────────────────────
  const total = Object.values(adj).reduce((s, v) => s + Math.max(0, v), 0);
  const normalized = {};
  if (total > 0) {
    for (const [a, v] of Object.entries(adj)) {
      normalized[a] = Math.round((Math.max(0, v) / total) * 10000) / 10000;
    }
  } else {
    // Degenerate: uniform
    for (const a of actions)
      normalized[a] = Math.round(10000 / actions.length) / 10000;
  }

  // Fix floating-point drift
  const normTotal = Object.values(normalized).reduce((s, v) => s + v, 0);
  if (normTotal !== 1.0 && actions.length > 0) {
    const last = actions[actions.length - 1];
    normalized[last] =
      Math.round((normalized[last] + (1.0 - normTotal)) * 10000) / 10000;
  }

  return {
    adjusted: normalized,
    factors: {
      icm_risk: Math.round(icmRisk * 1000) / 1000,
      bounty_ev: Math.round(bEV * 1000) / 1000,
      buy_in_factor: Math.round(buyFactor * 1000) / 1000,
      stack_factor: Math.round(stkFactor * 1000) / 1000,
      aggr_mult: Math.round(aggrMult * 1000) / 1000,
    },
  };
}

// ─── 7. Best Action Picker ────────────────────────────────────────────────────

/**
 * Returns the action with highest frequency in the (adjusted) strategy.
 * Breaks ties: prefer raise > call > fold.
 */
function bestAction(strategy) {
  const PREF = { "4bet": 5, "3bet": 4, raise: 3, call: 2, fold: 1 };
  let best = null,
    bestFreq = -1;
  for (const [a, freq] of Object.entries(strategy)) {
    const score = freq + (PREF[a] ?? 0) * 0.0001;
    if (score > bestFreq) {
      bestFreq = score;
      best = a;
    }
  }
  return best;
}

module.exports = {
  icmRiskFactor,
  bountyEV,
  buyInFactor,
  stackPressureFactor,
  totalEV,
  adjustStrategy,
  bestAction,
};
