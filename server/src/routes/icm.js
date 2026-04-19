const express = require("express");
const router = express.Router();
const {
  icm,
  icmEquityPct,
  icmPressure,
  payJumpInfo,
  icmPushEV,
} = require("../engine/icm");

/**
 * POST /api/icm/equity
 * Calculate ICM equity for all players at the table.
 * Body: {
 *   stacks: [1000, 2000, 1500, ...],   // chip stacks
 *   prizes: [500, 300, 200],            // prize amounts (sorted desc)
 *   currency: "USD"                     // optional
 * }
 */
router.post("/equity", (req, res) => {
  try {
    const { stacks, prizes } = req.body;
    if (!Array.isArray(stacks) || !Array.isArray(prizes)) {
      return res
        .status(400)
        .json({ error: "stacks and prizes must be arrays" });
    }
    if (stacks.some((s) => s < 0) || prizes.some((p) => p < 0)) {
      return res
        .status(400)
        .json({ error: "Stacks and prizes must be non-negative" });
    }

    const equity = icm(stacks, prizes);
    const equityPct = icmEquityPct(stacks, prizes);
    const totalPrize = prizes.reduce((a, b) => a + b, 0);
    const totalChips = stacks.reduce((a, b) => a + b, 0);

    const players = stacks.map((stack, i) => ({
      index: i,
      stack,
      chipPct: totalChips > 0 ? (stack / totalChips) * 100 : 0,
      equity: Math.round(equity[i] * 100) / 100,
      equityPct: Math.round(equityPct[i] * 100) / 100,
      pressure: Math.round(icmPressure(stacks, prizes, i) * 100) / 100,
    }));

    res.json({ players, totalPrize, totalChips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/icm/payjump
 * Get pay jump info for a specific player (hero).
 * Body: {
 *   stacks: [...],
 *   prizes: [...],
 *   hero_idx: 0,
 *   players_remaining: 18    // total players remaining in tournament
 * }
 */
router.post("/payjump", (req, res) => {
  try {
    const { stacks, prizes, hero_idx = 0, players_remaining } = req.body;
    if (!Array.isArray(stacks) || !Array.isArray(prizes)) {
      return res
        .status(400)
        .json({ error: "stacks and prizes must be arrays" });
    }

    const remaining = players_remaining ?? stacks.length;
    const info = payJumpInfo(stacks, prizes, hero_idx, remaining);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/icm/push-ev
 * Calculate ICM EV for push vs fold decision.
 * Body: {
 *   stacks: [...],
 *   prizes: [...],
 *   hero_idx: 0,
 *   hand_equity: 0.55,      // estimated equity vs calling range
 *   call_range_freq: 0.30,   // fraction of stack ranges that call
 *   hero_contribution: 1000, // chips hero puts in
 *   pot_chips: 1200          // total pot if called
 * }
 */
router.post("/push-ev", (req, res) => {
  try {
    const {
      stacks,
      prizes,
      hero_idx = 0,
      hand_equity,
      call_range_freq,
      hero_contribution,
      pot_chips,
    } = req.body;
    if (!Array.isArray(stacks) || !Array.isArray(prizes)) {
      return res
        .status(400)
        .json({ error: "stacks and prizes must be arrays" });
    }

    const result = icmPushEV({
      heroIdx: hero_idx,
      stacks,
      prizes,
      handEquity: hand_equity ?? 0.5,
      callRangeFreq: call_range_freq ?? 0.3,
      heroContribution: hero_contribution ?? stacks[hero_idx],
      potChips: pot_chips ?? stacks[hero_idx],
    });

    res.json({
      ...result,
      icmEVDiff: Math.round(result.icmEVDiff * 10000) / 10000,
      recommendation: result.icmEVDiff > 0 ? "push" : "fold",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
