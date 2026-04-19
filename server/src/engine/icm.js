/**
 * ICM (Independent Chip Model) Engine
 * Uses Malmuth-Harville algorithm for equity calculation.
 *
 * ICM translates chip stacks into tournament equity ($EV).
 * Key uses in poker:
 *   - ICM pressure: near bubble/pay jump, gambles cost more than chips suggest
 *   - Push/fold decisions adjusted by ICM pressure factor
 *   - Pay jump awareness: how much $ is at stake with each decision
 */

/**
 * Malmuth-Harville ICM
 * @param {number[]} stacks - chip stacks for each player
 * @param {number[]} prizes - prize amounts sorted descending (e.g. [1000, 600, 400])
 * @returns {number[]} dollar equity for each player
 */
function icm(stacks, prizes) {
  const n = stacks.length;
  if (n === 0 || prizes.length === 0) return [];
  if (n === 1) return [prizes[0]];

  const k = Math.min(prizes.length, n);
  const memo = new Map();

  // Returns equity array contributions from prize place `place` onwards
  // given players represented by bitmask `mask` still competing
  function solve(mask, place) {
    if (place >= k) return new Array(n).fill(0);

    const key = `${mask},${place}`;
    if (memo.has(key)) return memo.get(key);

    const result = new Array(n).fill(0);
    const active = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        active.push(i);
        total += stacks[i];
      }
    }

    if (total === 0) return result;

    for (const w of active) {
      const p = stacks[w] / total;
      result[w] += p * prizes[place];

      const sub = solve(mask ^ (1 << w), place + 1);
      for (let i = 0; i < n; i++) {
        result[i] += p * sub[i];
      }
    }

    memo.set(key, result);
    return result;
  }

  return solve((1 << n) - 1, 0);
}

/**
 * ICM equity as percentage of total prize pool
 */
function icmEquityPct(stacks, prizes) {
  const equity = icm(stacks, prizes);
  const total = prizes.reduce((a, b) => a + b, 0);
  return equity.map((e) => (total > 0 ? (e / total) * 100 : 0));
}

/**
 * ICM pressure factor for player `heroIdx`.
 * 0 = no pressure (early in tournament, no pay jump nearby)
 * 1 = maximum pressure (on exact bubble)
 *
 * Formula: compare EV(chip change) vs ICM(chip change)
 * Simplified: pressure = 1 - (marginal ICM value / marginal chip value)
 */
function icmPressure(stacks, prizes, heroIdx) {
  if (!stacks || stacks.length < 2 || !prizes || prizes.length === 0) return 0;

  const n = stacks.length;
  const heroStack = stacks[heroIdx];
  const totalChips = stacks.reduce((a, b) => a + b, 0);
  const avgStack = totalChips / n;
  const delta = Math.min(heroStack * 0.1, avgStack * 0.05); // 5% avg stack test

  if (delta === 0) return 0;

  const baseEquity = icm(stacks, prizes);

  // Gain scenario: hero wins `delta` chips from average opponent
  const gainStacks = [...stacks];
  gainStacks[heroIdx] += delta;
  const loseIdx = heroIdx === 0 ? 1 : 0;
  gainStacks[loseIdx] = Math.max(1, gainStacks[loseIdx] - delta);
  const gainEquity = icm(gainStacks, prizes);

  // Loss scenario: hero loses `delta` chips
  const lossStacks = [...stacks];
  lossStacks[heroIdx] = Math.max(1, lossStacks[heroIdx] - delta);
  lossStacks[loseIdx] += delta;
  const lossEquity = icm(lossStacks, prizes);

  const icmGain = gainEquity[heroIdx] - baseEquity[heroIdx];
  const icmLoss = baseEquity[heroIdx] - lossEquity[heroIdx];

  // Chip gain and loss are symmetric in chip-EV sense
  const chipGainValue = delta / totalChips;
  const chipLossValue = delta / totalChips;

  const gainRatio = chipGainValue > 0 ? icmGain / chipGainValue : 1;
  const lossRatio = chipLossValue > 0 ? icmLoss / chipLossValue : 1;

  // Pressure = asymmetry between losing and gaining chips in ICM terms
  // If losing chips costs much more than gaining chips is worth → high pressure
  const raw = lossRatio > 0 ? Math.max(0, 1 - gainRatio / lossRatio) : 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Pay jump information for the hero player.
 * Returns next pay jump amount and bubble distance.
 */
function payJumpInfo(stacks, prizes, heroIdx, playersRemainingTotal) {
  const n = stacks.length; // players at table
  const paidSpots = prizes.length;

  // How many total players until next pay jump
  const bubblesAway = playersRemainingTotal - paidSpots;
  const onBubble = bubblesAway <= 0 && playersRemainingTotal > paidSpots - 1;

  // Current prize position
  const sortedStacks = [...stacks].sort((a, b) => a - b);
  const heroRank = sortedStacks.findIndex((s) => s >= stacks[heroIdx]);

  // Estimated current prize
  const equity = icm(stacks, prizes);
  const currentEquity = equity[heroIdx] || 0;

  // Next pay jump: difference between current prize tier and next
  // Find which prize tier hero is on
  const payIdx = Math.max(0, Math.min(paidSpots - 1, n - 1 - heroRank));
  const nextPayIdx = Math.max(0, payIdx - 1);

  const currentPay = prizes[payIdx] || 0;
  const nextPay = prizes[nextPayIdx] || currentPay;
  const jumpAmount = nextPay - currentPay;

  return {
    bubblesAway: Math.max(0, bubblesAway),
    onBubble: bubblesAway === 1,
    inTheMoney: playersRemainingTotal <= paidSpots,
    currentEquity,
    currentPay,
    nextPay,
    jumpAmount: Math.max(0, jumpAmount),
    icmPressureValue: icmPressure(stacks, prizes, heroIdx),
  };
}

/**
 * ICM-adjusted EV for a push-or-fold decision.
 * @param {object} params
 *   - heroIdx: index of hero in stacks array
 *   - stacks: all player stacks (chips)
 *   - prizes: prize pool structure
 *   - handEquity: estimated equity vs calling range (0-1)
 *   - potChips: total pot in chips if called
 *   - callRangeFreq: fraction of opponents who call
 *   - heroContribution: chips hero puts in if called
 */
function icmPushEV(params) {
  const {
    heroIdx,
    stacks,
    prizes,
    handEquity,
    callRangeFreq,
    heroContribution,
    potChips,
  } = params;
  if (!stacks || stacks.length < 2) return { ev: 0, foldEV: 0, pushEV: 0 };

  const baseEquity = icm(stacks, prizes);
  const heroBase = baseEquity[heroIdx];

  // Fold EV = current ICM equity (unchanged)
  const foldEV = heroBase;

  // Push EV = (1 - callFreq) * (foldEV + foldedPot) + callFreq * (winEV * handEquity + loseEV * (1-handEquity))
  const foldedPot = potChips - heroContribution; // blinds + antes hero picks up when everyone folds

  // Win scenario: hero stacks opponent
  const callerIdx = heroIdx === 0 ? 1 : 0; // simplified: main caller
  const winStacks = [...stacks];
  winStacks[heroIdx] += winStacks[callerIdx] || 0;
  winStacks[callerIdx] = 1; // eliminated (use 1 to avoid 0-chip issues)
  const winEquity = icm(winStacks, prizes);

  // Lose scenario: hero is eliminated or crippled
  const loseStacks = [...stacks];
  loseStacks[heroIdx] = Math.max(1, loseStacks[heroIdx] - heroContribution);
  loseStacks[callerIdx] = (loseStacks[callerIdx] || 0) + heroContribution;
  const loseEquity = icm(loseStacks, prizes);

  const foldedPotStacks = [...stacks];
  foldedPotStacks[heroIdx] += foldedPot;
  const foldedPotEquity = icm(foldedPotStacks, prizes);

  const callFreq = callRangeFreq ?? 0.3;

  const pushEV =
    (1 - callFreq) * foldedPotEquity[heroIdx] +
    callFreq *
      (handEquity * winEquity[heroIdx] +
        (1 - handEquity) * loseEquity[heroIdx]);

  return {
    foldEV,
    pushEV,
    icmEVDiff: pushEV - foldEV,
    pressure: icmPressure(stacks, prizes, heroIdx),
  };
}

module.exports = { icm, icmEquityPct, icmPressure, payJumpInfo, icmPushEV };
