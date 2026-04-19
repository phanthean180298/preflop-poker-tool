const express = require("express");
const router = express.Router();
const { query, TABLE_POSITIONS } = require("../engine/preflop");
const { makeCacheKey, getCached, setCache } = require("../middleware/cache");

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

module.exports = router;
