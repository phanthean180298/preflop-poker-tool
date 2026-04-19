/**
 * Preflop GTO Engine
 *
 * Combos are suit-collapsed:
 *   AKs = suited (4 combos raw, treated as 1 category)
 *   AKo = offsuit (12 combos raw, treated as 1 category)
 *   AA  = pair (6 combos raw)
 *
 * Actions: RFI (raise first in), Call/3bet/Fold vs aggression
 *
 * Required inputs for accurate output:
 *   - stack_bb: effective stack in big blinds
 *   - position: varies by table size (see TABLE_POSITIONS)
 *   - vs_position: who raised before (for vs_rfi / vs_3bet)
 *   - action: 'rfi' | 'vs_rfi' | 'vs_3bet'
 *   - hand: e.g. 'AKs', 'AKo', 'QQ', '72o'
 *   - ante_bb: ante in BB (0 = no ante, 0.1 = 10% ante MTT)
 *   - table_size: 5 | 6 | 7 | 8 | 9
 */

/** Position lists per table size (order = UTG → SB → BB) */
const TABLE_POSITIONS = {
  5: ["EP", "CO", "BTN", "SB", "BB"],
  6: ["EP", "MP", "CO", "BTN", "SB", "BB"],
  7: ["UTG", "MP", "HJ", "CO", "BTN", "SB", "BB"],
  8: ["UTG", "UTG1", "MP", "HJ", "CO", "BTN", "SB", "BB"],
  9: ["UTG", "UTG1", "UTG2", "HJ", "CO", "BTN", "SB", "BB"],
};

// Default 6-max positions (backward compat)
const POSITIONS = TABLE_POSITIONS[6];
const POSITION_INDEX = Object.fromEntries(POSITIONS.map((p, i) => [p, i]));

/**
 * Get position index and positions array for a given table size.
 * Returns normalized index 0 (tightest/UTG) → n-3 (BTN), n-2 (SB), n-1 (BB)
 */
function getPositionInfo(position, tableSize = 6) {
  const positions = TABLE_POSITIONS[tableSize] || TABLE_POSITIONS[6];
  const idx = positions.indexOf(position);
  // Fall back to 6-max POSITION_INDEX for backward compat
  const fallbackIdx = POSITION_INDEX[position] ?? 2;
  return {
    positions,
    idx: idx >= 0 ? idx : fallbackIdx,
    total: positions.length,
    isSB: position === "SB",
    isBB: position === "BB",
    isBTN: position === "BTN",
    playersToAct: idx >= 0 ? positions.length - idx - 1 : 3,
  };
}

/**
 * Push/fold mode threshold (≤ 15bb)
 */
function isPushFoldStack(stackBB) {
  return stackBB <= 15;
}

/**
 * Basic hand strength score (0-100) for preflop, suit-collapsed.
 */
const HAND_STRENGTH = (() => {
  const ranks = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A",
  ];
  const rankVal = Object.fromEntries(ranks.map((r, i) => [r, i]));

  return function (hand) {
    if (hand.length === 2 && hand[0] === hand[1]) {
      return 50 + rankVal[hand[0]] * 4;
    }
    const suited = hand.endsWith("s");
    const h = hand.replace(/[so]$/, "");
    const r1 = rankVal[h[0]] ?? -1;
    const r2 = rankVal[h[1]] ?? -1;
    if (r1 < 0 || r2 < 0) return 0;
    const high = Math.max(r1, r2);
    const low = Math.min(r1, r2);
    const gap = high - low;
    let score = high * 2.5 + low * 1.5 - gap * 1.2;
    if (suited) score += 3;
    return Math.max(0, Math.min(99, score));
  };
})();

/**
 * Estimate fold equity for RFI based on number of players left to act.
 * Each player folds with ~90% prob independently.
 */
function estimateFoldEquity(playersToAct) {
  return Math.pow(0.9, Math.max(1, playersToAct - 1)); // exclude BB
}

/**
 * Estimate chip EV for RFI scenario (in BB).
 */
function calcRFI_EV(
  strength,
  playersToAct,
  anteBB,
  tableSize,
  sizeBB,
  stackBB
) {
  const deadMoney = 1.5 + anteBB * tableSize; // SB + BB + antes
  const foldEquity = estimateFoldEquity(playersToAct);
  const equity = 0.35 + (strength / 100) * 0.3; // 35-65% range

  const evRaise =
    foldEquity * (deadMoney + sizeBB) +
    (1 - foldEquity) * (equity * (deadMoney + sizeBB * 2) - sizeBB) -
    sizeBB;

  return {
    raise: Math.round(evRaise * 100) / 100,
    fold: 0,
  };
}

/**
 * Estimate chip EV for vs_rfi scenario (in BB).
 */
function calcVsRFI_EV(strength, anteBB, tableSize, rfiSizeBB, threeBetSize) {
  const deadMoney = 1.5 + anteBB * tableSize;
  const equity = 0.3 + (strength / 100) * 0.35;

  // Call EV
  const potIfCall = deadMoney + rfiSizeBB * 2;
  const callEV = equity * potIfCall - rfiSizeBB;

  // 3bet EV
  const feFacing3bet = 0.58;
  const potIf3betFold = deadMoney + rfiSizeBB + threeBetSize;
  const potIf3betCall = deadMoney + threeBetSize * 2;
  const threeBetEV =
    feFacing3bet * potIf3betFold +
    (1 - feFacing3bet) * ((equity + 0.04) * potIf3betCall - threeBetSize) -
    threeBetSize;

  return {
    raise: Math.round(threeBetEV * 100) / 100,
    call: Math.round(callEV * 100) / 100,
    fold: 0,
  };
}

/**
 * Estimate chip EV for vs_3bet scenario (in BB).
 */
function calcVs3Bet_EV(strength, threeBetSizeBB, fourBetSize) {
  const equity = 0.32 + (strength / 100) * 0.36;
  const pot = threeBetSizeBB * 2 + 1;

  // Call EV
  const callEV = equity * pot - threeBetSizeBB;

  // 4bet EV
  const feFacing4bet = 0.6;
  const pot4betFold = pot + fourBetSize;
  const pot4betCall = pot + fourBetSize * 2;
  const fourBetEV =
    feFacing4bet * pot4betFold +
    (1 - feFacing4bet) * ((equity + 0.05) * pot4betCall - fourBetSize) -
    fourBetSize;

  return {
    raise: Math.round(fourBetEV * 100) / 100,
    call: Math.round(callEV * 100) / 100,
    fold: 0,
  };
}

/**
 * RFI (Raise First In) strategy
 */
function getRFI({ hand, position, stackBB, anteBB = 0, tableSize = 6 }) {
  const strength = HAND_STRENGTH(hand);
  const { idx: posIdx, playersToAct } = getPositionInfo(position, tableSize);

  // Base threshold per normalized position (0=UTG, n-3=BTN)
  const normalized = posIdx / Math.max(1, tableSize - 3); // 0 to ~1
  const baseThreshold = 72 - normalized * 34; // 72 (UTG) → 38 (BTN)

  let threshold = baseThreshold;
  if (anteBB > 0) threshold -= anteBB * 15;

  if (isPushFoldStack(stackBB)) {
    threshold -= (15 - stackBB) * 2.5 + normalized * 10;
  }

  // BB never RFIs (posts big blind, different scenario)
  if (position === "BB") {
    return {
      action: "fold",
      freq: 0,
      sizeBB: 0,
      pushFoldMode: isPushFoldStack(stackBB),
      ev: { raise: 0, fold: 0 },
    };
  }

  const shouldRaise = strength >= threshold;

  let freq = 1;
  if (Math.abs(strength - threshold) < 5) {
    freq = Math.max(0.1, Math.min(0.9, 0.5 + (strength - threshold) / 10));
  }

  let sizeBB = posIdx < 2 ? 3.0 : posIdx < 4 ? 2.5 : 2.2;
  if (isPushFoldStack(stackBB)) sizeBB = stackBB;

  const ev = calcRFI_EV(
    strength,
    playersToAct,
    anteBB,
    tableSize,
    sizeBB,
    stackBB
  );

  return {
    action: shouldRaise ? "raise" : "fold",
    freq: shouldRaise ? freq : Math.max(0, 1 - freq < 0.1 ? 0 : 1 - freq),
    sizeBB: shouldRaise ? sizeBB : 0,
    pushFoldMode: isPushFoldStack(stackBB),
    ev,
  };
}

/**
 * Facing RFI: call / 3bet / fold
 */
function getVsRFI({
  hand,
  position,
  vsPosition,
  stackBB,
  rfiSizeBB = 2.5,
  anteBB = 0,
  tableSize = 6,
}) {
  const strength = HAND_STRENGTH(hand);
  const { idx: posIdx } = getPositionInfo(position, tableSize);
  const { idx: vsIdx } = getPositionInfo(vsPosition, tableSize);
  const positionAdvantage = posIdx > vsIdx ? 1 : 0;

  let threeBetThreshold = positionAdvantage ? 78 : 83;
  let callThreshold = positionAdvantage ? 55 : 60;

  if (isPushFoldStack(stackBB)) {
    threeBetThreshold = 70;
    callThreshold = 999;
  }

  if (anteBB > 0) {
    threeBetThreshold -= anteBB * 10;
    callThreshold -= anteBB * 8;
  }

  const threeBetSize = rfiSizeBB * 3;
  let action, freq, sizeBB;

  if (strength >= threeBetThreshold) {
    action = "raise";
    freq = strength >= threeBetThreshold + 5 ? 1 : 0.7;
    sizeBB = isPushFoldStack(stackBB) ? stackBB : threeBetSize;
  } else if (strength >= callThreshold && !isPushFoldStack(stackBB)) {
    action = "call";
    freq = 1;
    sizeBB = rfiSizeBB;
  } else {
    action = "fold";
    freq = 1;
    sizeBB = 0;
  }

  const ev = calcVsRFI_EV(strength, anteBB, tableSize, rfiSizeBB, threeBetSize);

  return { action, freq, sizeBB, pushFoldMode: isPushFoldStack(stackBB), ev };
}

/**
 * Facing 3bet
 */
function getVs3Bet({
  hand,
  position,
  vsPosition,
  stackBB,
  threeBetSizeBB = 7.5,
  tableSize = 6,
}) {
  const strength = HAND_STRENGTH(hand);
  const { idx: posIdx } = getPositionInfo(position, tableSize);
  const { idx: vsIdx } = getPositionInfo(vsPosition, tableSize);
  const ip = posIdx > vsIdx;

  let fourBetThreshold = ip ? 88 : 91;
  let callThreshold = ip ? 70 : 74;

  if (isPushFoldStack(stackBB)) {
    fourBetThreshold = 82;
    callThreshold = 999;
  }

  const fourBetSize = threeBetSizeBB * 2.5;
  let action, freq, sizeBB;

  if (strength >= fourBetThreshold) {
    action = "raise";
    freq = 1;
    sizeBB = isPushFoldStack(stackBB) ? stackBB : fourBetSize;
  } else if (strength >= callThreshold && !isPushFoldStack(stackBB)) {
    action = "call";
    freq = 1;
    sizeBB = threeBetSizeBB;
  } else {
    action = "fold";
    freq = 1;
    sizeBB = 0;
  }

  const ev = calcVs3Bet_EV(strength, threeBetSizeBB, fourBetSize);

  return { action, freq, sizeBB, pushFoldMode: isPushFoldStack(stackBB), ev };
}

/**
 * Master query function
 */
function query(params) {
  const { action } = params;
  switch (action) {
    case "rfi":
      return getRFI(params);
    case "vs_rfi":
      return getVsRFI(params);
    case "vs_3bet":
      return getVs3Bet(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

module.exports = {
  query,
  HAND_STRENGTH,
  POSITIONS,
  TABLE_POSITIONS,
  isPushFoldStack,
  getPositionInfo,
};
