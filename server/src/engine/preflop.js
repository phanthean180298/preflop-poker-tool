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
 *   - stack_bb: effective stack in big blinds (e.g. 20, 40, 100)
 *   - position: EP|MP|CO|BTN|SB|BB
 *   - vs_position: none|EP|MP|CO|BTN|SB|BB (who raised before)
 *   - action: 'rfi' | 'vs_rfi' | 'vs_3bet' | 'vs_4bet'
 *   - hand: e.g. 'AKs', 'AKo', 'QQ', '72o'
 *   - ante_bb: ante in BB (0 = no ante, 0.1 = 10% ante common in MTT)
 */

const POSITIONS = ["EP", "MP", "CO", "BTN", "SB", "BB"];
const POSITION_INDEX = Object.fromEntries(POSITIONS.map((p, i) => [p, i]));

/**
 * Stack-adjusted push/fold threshold (simplified Nash-approximation).
 * For very short stacks (<= 15bb), we shift to push/fold mode.
 */
function isPushFoldStack(stackBB) {
  return stackBB <= 15;
}

/**
 * Basic hand strength score (0-100) for preflop, suit-collapsed.
 * Used to rank hands within a range.
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
    // Pairs: AA=100, KK=96, ...
    if (hand.length === 2 && hand[0] === hand[1]) {
      return 50 + rankVal[hand[0]] * 4;
    }
    const suited = hand.endsWith("s");
    const offsuit = hand.endsWith("o");
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
 * RFI (Raise First In) strategy
 * Returns: { action: 'raise'|'fold', freq: 0-1, sizeBB: number }
 */
function getRFI({ hand, position, stackBB, anteBB = 0 }) {
  const strength = HAND_STRENGTH(hand);
  const posIdx = POSITION_INDEX[position] ?? 2;

  // Tighter from EP, looser from BTN/SB
  // Threshold decreases (looser) as position improves
  const baseThresholds = { EP: 72, MP: 65, CO: 55, BTN: 42, SB: 38, BB: 999 };
  let threshold = baseThresholds[position] ?? 60;

  // Ante increases aggression (more dead money)
  if (anteBB > 0) threshold -= anteBB * 15;

  // Short stack: wider shove range (Nash push/fold approximation)
  // At 10bb BTN, shoving range is ~75% of hands
  if (isPushFoldStack(stackBB)) {
    threshold -= (15 - stackBB) * 2.5 + posIdx * 2;
  }

  const shouldRaise = strength >= threshold;

  // Mixed strategy for borderline hands (within 5 pts of threshold)
  let freq = 1;
  if (Math.abs(strength - threshold) < 5) {
    freq = 0.5 + (strength - threshold) / 10;
    freq = Math.max(0.1, Math.min(0.9, freq));
  }

  // Raise size: 2.2-2.5bb standard, 3x from early, push if short
  let sizeBB = 2.2;
  if (posIdx < 2) sizeBB = 3;
  else if (posIdx < 4) sizeBB = 2.5;
  if (isPushFoldStack(stackBB)) sizeBB = stackBB; // shove

  return {
    action: shouldRaise ? "raise" : "fold",
    freq: shouldRaise ? freq : 1 - freq < 0.1 ? 0 : 1 - freq,
    sizeBB: shouldRaise ? sizeBB : 0,
    pushFoldMode: isPushFoldStack(stackBB),
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
}) {
  const strength = HAND_STRENGTH(hand);
  const posIdx = POSITION_INDEX[position] ?? 2;
  const vsIdx = POSITION_INDEX[vsPosition] ?? 0;
  const positionAdvantage = posIdx > vsIdx ? 1 : 0; // in position vs raiser

  // 3bet thresholds (value + bluffs)
  let threeBetThreshold = positionAdvantage ? 78 : 83;
  let callThreshold = positionAdvantage ? 55 : 60;

  if (isPushFoldStack(stackBB)) {
    // Short stack: jam or fold, no call
    threeBetThreshold = 70;
    callThreshold = 999; // no calling
  }

  // Ante adjustment
  if (anteBB > 0) {
    threeBetThreshold -= anteBB * 10;
    callThreshold -= anteBB * 8;
  }

  let action, freq, sizeBB;

  if (strength >= threeBetThreshold) {
    action = "raise"; // 3bet
    freq = strength >= threeBetThreshold + 5 ? 1 : 0.7;
    sizeBB = isPushFoldStack(stackBB) ? stackBB : rfiSizeBB * 3;
  } else if (strength >= callThreshold && !isPushFoldStack(stackBB)) {
    action = "call";
    freq = 1;
    sizeBB = rfiSizeBB;
  } else {
    action = "fold";
    freq = 1;
    sizeBB = 0;
  }

  return { action, freq, sizeBB, pushFoldMode: isPushFoldStack(stackBB) };
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
}) {
  const strength = HAND_STRENGTH(hand);
  const posIdx = POSITION_INDEX[position] ?? 2;
  const vsIdx = POSITION_INDEX[vsPosition] ?? 0;
  const ip = posIdx > vsIdx;

  let fourBetThreshold = ip ? 88 : 91;
  let callThreshold = ip ? 70 : 74;

  if (isPushFoldStack(stackBB)) {
    fourBetThreshold = 82;
    callThreshold = 999;
  }

  let action, freq, sizeBB;
  if (strength >= fourBetThreshold) {
    action = "raise"; // 4bet
    freq = 1;
    sizeBB = isPushFoldStack(stackBB) ? stackBB : threeBetSizeBB * 2.5;
  } else if (strength >= callThreshold && !isPushFoldStack(stackBB)) {
    action = "call";
    freq = 1;
    sizeBB = threeBetSizeBB;
  } else {
    action = "fold";
    freq = 1;
    sizeBB = 0;
  }

  return { action, freq, sizeBB, pushFoldMode: isPushFoldStack(stackBB) };
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

module.exports = { query, HAND_STRENGTH, POSITIONS, isPushFoldStack };
