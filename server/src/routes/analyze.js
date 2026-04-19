/**
 * POST /api/analyze/table
 *
 * Accepts a poker table screenshot (base64 data URL or raw base64),
 * calls OpenAI GPT-4o vision to extract all relevant game state,
 * then calls the EV engine to return the optimal action.
 *
 * Body:
 * {
 *   image:   "<base64 data URL>",  // required
 *   model:   "gpt-4o-mini",        // optional, default gpt-4o-mini
 *   api_key: "<OpenAI key>"        // optional if OPENAI_API_KEY env is set
 * }
 *
 * Response:
 * {
 *   extracted: { ... },   // raw extracted table state
 *   action:    { ... },   // /preflop/action result
 *   error?:    "..."      // present only on failure
 * }
 */

const express = require("express");
const router = express.Router();
const { lookupStrategy } = require("../engine/cfr_loader");
const { adjustStrategy, bestAction } = require("../engine/ev");

// ─── Extraction prompt ──────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are a professional poker analyst. Analyze this poker table screenshot and extract ALL available information in JSON format.

Extract the following fields (use null if not visible or unclear):

{
  "hero_hand": "7h6c",            // hero's hole cards (e.g. "AKs", "76o", "QQ")
  "hero_pos": "SB",               // hero position: UTG/UTG1/MP/HJ/CO/BTN/SB/BB
  "hero_stack_bb": 29.9,          // hero stack in BB
  "villain_stacks": {             // all visible villain stacks (position → BB)
    "BTN": 30.5,
    "CO": 46.5,
    "UTG": 28.5
  },
  "vpip": {                       // VPIP stat shown as a small number in the BOTTOM-LEFT corner of each player's avatar chip
    "BTN": 40,
    "SB": 29,
    "UTG": 0
  },
  "bounties": {                   // PKO bounty per player — the number shown ON TOP of (above) the player's avatar chip (NOT the vpip number at bottom-left)
    "SB": 29,
    "BTN": 40
  },
  "pot_bb": 50.9,                 // current pot size in BB
  "street": "preflop",           // preflop / flop / turn / river
  "board": [],                    // board cards as strings e.g. ["Ah","Kd","2s"]
  "available_actions": ["fold", "call", "raise"],  // buttons visible for hero
  "call_amount_bb": 29.9,         // size of call action in BB if visible
  "raise_amount_bb": null,        // min-raise or bet size if visible
  "blinds": { "sb": 50, "bb": 100 },   // blind levels (chip values)
  "ante_bb": 0,                   // ante in BB if visible
  "table_size": 8,                // number of seats at table
  "players_remaining": 54,        // total players left in tournament (from lobby/header)
  "total_players": 110,           // starting field size if visible
  "tournament_level": 4,          // current blind level / stage number
  "level_time_remaining": "01:45", // time left in this blind level
  "prize_pool": "T$7.71",         // prize / current payout if visible
  "ranking": "54/110",            // hero's current ranking
  "late_reg": true,               // whether late registration is still open
  "table_name": "Bàn 12"          // table number if visible
}

Rules:
- "hero" is the player whose hole cards are shown face-up (visible cards)
- VPIP: the small number in the BOTTOM-LEFT corner of each player's avatar chip (indicates voluntarily-put-money-in-pot %)
- Bounty (PKO): the number shown ON TOP of / ABOVE each player's avatar chip; do NOT confuse with the bottom-left VPIP number
- Convert all stacks to BB if shown in chips using the BB blind level
- For tournament stage, infer: level 1-4 = "early", 5-8 = "mid", near final tables = "ft", near money bubble = "bubble", in money = "itm"
- Return ONLY valid JSON, no markdown fences, no explanation`;

// ─── Detect provider from model name ──────────────────────────────────────
function isGeminiModel(model) {
  return model.startsWith("gemini");
}

// ─── Strip markdown fences from LLM response ──────────────────────────────
function cleanJSON(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// ─── Call Gemini vision API (free tier: gemini-1.5-flash) ─────────────────
async function callGeminiAPI(base64Image, mimeType, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Image } },
            { text: EXTRACTION_PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 1200 },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg =
      err.error?.message || `Gemini API error: ${response.status}`;
    throw new Error(msg);
  }

  const data = await response.json();
  const content =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return JSON.parse(cleanJSON(content));
}

// ─── Call OpenAI vision API ─────────────────────────────────────────────────
async function callOpenAIAPI(base64Image, mimeType, model, apiKey) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: "high",
              },
            },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `OpenAI API error: ${response.status}`
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  return JSON.parse(cleanJSON(content));
}

// ─── Unified vision dispatcher ─────────────────────────────────────────────
async function callVisionAPI(base64Image, mimeType, model, apiKey) {
  if (isGeminiModel(model)) {
    return callGeminiAPI(base64Image, mimeType, model, apiKey);
  }
  return callOpenAIAPI(base64Image, mimeType, model, apiKey);
}

// ─── Infer tournament stage from level ─────────────────────────────────────
function inferStage(extracted) {
  const level = extracted.tournament_level;
  const remaining = extracted.players_remaining;
  const total = extracted.total_players;

  if (remaining && total) {
    const ratio = remaining / total;
    if (ratio <= 0.1) return "ft";
    if (ratio <= 0.15) return "bubble";
    if (ratio <= 0.5) return "itm";
    if (ratio <= 0.7) return "mid";
    return "early";
  }
  if (level) {
    if (level <= 4) return "early";
    if (level <= 8) return "mid";
    return "itm";
  }
  return "mid";
}

// ─── Infer spot type from visible actions/call amount ───────────────────────
function inferSpotType(extracted) {
  const actions = (extracted.available_actions || []).map((a) =>
    a.toLowerCase()
  );
  const callAmt = Number(extracted.call_amount_bb || 0);
  const stack = Number(extracted.hero_stack_bb || 30);
  if (callAmt > 0 && actions.includes("call")) {
    // Large call relative to stack → likely facing a 3-bet
    if (callAmt / stack > 0.2) return "vs_3bet";
    return "vs_open";
  }
  return "open";
}

// ─── Normalize hand to solver format ────────────────────────────────────────
function normalizeHand(raw) {
  if (!raw) return null;
  // Already normalized like "AKs", "QQ", "76o"
  const clean = raw.replace(/\s+/g, "").toUpperCase();
  if (/^[2-9TJQKA]{2}[SsOo]?$/.test(clean)) return clean;
  // Try to parse "7h 6c" → "76o" or "7h 7d" → "77"
  const cards = clean.match(/[2-9TJQKA][HDCS]/gi);
  if (!cards || cards.length < 2) return clean;
  const RANKS = "23456789TJQKA";
  const r1 = cards[0][0].toUpperCase();
  const r2 = cards[1][0].toUpperCase();
  const s1 = cards[0][1].toUpperCase();
  const s2 = cards[1][1].toUpperCase();
  if (r1 === r2) return r1 + r2;
  const hi = RANKS.indexOf(r1) >= RANKS.indexOf(r2) ? r1 : r2;
  const lo = RANKS.indexOf(r1) >= RANKS.indexOf(r2) ? r2 : r1;
  const suited = s1 === s2 ? "s" : "o";
  return hi + lo + suited;
}

// ─── Map extracted villain stacks to resolve vs/position ────────────────────
function resolveVillainPos(extracted) {
  // For a simple preflop action, we need the most relevant villain
  // Priority: last aggressor or direct left of hero
  const villains = extracted.villain_stacks || {};
  const posOrder = ["UTG", "UTG1", "MP", "HJ", "CO", "BTN", "SB", "BB"];
  const heroPos = (extracted.hero_pos || "").toUpperCase();
  const heroIdx = posOrder.indexOf(heroPos);

  // Find the position that is closest to the left of hero (most relevant villain)
  let best = null;
  let bestDist = Infinity;
  for (const pos of Object.keys(villains)) {
    const idx = posOrder.indexOf(pos.toUpperCase());
    if (idx < 0) continue;
    const dist = (idx - heroIdx + posOrder.length) % posOrder.length;
    if (dist > 0 && dist < bestDist) {
      bestDist = dist;
      best = pos.toUpperCase();
    }
  }
  return best || "BB";
}

// ─── Route handler ──────────────────────────────────────────────────────────
router.post("/table", async (req, res) => {
  const t0 = Date.now();
  const {
    image,
    model = "gemini-1.5-flash",
    api_key,
    gemini_api_key,
  } = req.body;

  // Pick the right key based on model
  const apiKey = isGeminiModel(model)
    ? (gemini_api_key || process.env.GEMINI_API_KEY || api_key)
    : (api_key || process.env.OPENAI_API_KEY);

  if (!apiKey) {
    const providerName = isGeminiModel(model) ? "Gemini" : "OpenAI";
    return res.status(400).json({
      error: `${providerName} API key required. Pass ${isGeminiModel(model) ? "gemini_api_key" : "api_key"} in request body or set ${isGeminiModel(model) ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} environment variable.`,
    });
  }
  if (!image) {
    return res
      .status(400)
      .json({ error: "Missing required field: image (base64 data URL)" });
  }

  // Parse base64 data URL
  let base64, mimeType;
  const dataUrlMatch = image.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    base64 = dataUrlMatch[2];
  } else {
    // Assume raw base64 PNG
    mimeType = "image/png";
    base64 = image;
  }

  let extracted;
  try {
    extracted = await callVisionAPI(base64, mimeType, model, apiKey);
  } catch (err) {
    return res.status(502).json({ error: `Vision API failed: ${err.message}` });
  }

  // Normalize extracted data
  const hand = normalizeHand(extracted.hero_hand);
  const heroPos = (extracted.hero_pos || "BTN").toUpperCase();
  const villainPos = resolveVillainPos(extracted);
  const stackBB = Number(extracted.hero_stack_bb || 30);
  const stage = inferStage(extracted);
  const bounty = Number(Object.values(extracted.bounties || {})[0] || 0);
  const heroBounty = extracted.bounties?.[heroPos] || 0;

  // Spot type: detect from available actions / call amount
  const spotType = inferSpotType(extracted);

  let actionResult = null;
  if (hand) {
    const lookup = lookupStrategy({
      position: heroPos,
      vs: villainPos,
      facing: spotType,
      hand,
    });

    if (!lookup.error) {
      const ctx = {
        stage,
        stackBB,
        villainStackBB: Number(extracted.villain_stacks?.[villainPos] || 30),
        playersLeft: Number(extracted.players_remaining || 100),
        totalPlayers: Number(extracted.total_players || 1000),
        bounty: Number(bounty),
        heroBounty: Number(heroBounty),
        buyIn: 10,
        pWin: 0.5,
        spotType,
      };

      const { adjusted, factors } = adjustStrategy(lookup.strategy, ctx);
      const best = bestAction(adjusted);

      actionResult = {
        spot: lookup.spot,
        hand: lookup.hand,
        strategy: lookup.strategy,
        adjusted_strategy: adjusted,
        best_action: best,
        factors,
        fallback: lookup.fallback ?? false,
      };
    }
  }

  res.json({
    latency_ms: Date.now() - t0,
    extracted: {
      ...extracted,
      _normalized_hand: hand,
      _stage: stage,
      _hero_pos: heroPos,
      _villain_pos: villainPos,
      _spot_type: spotType,
    },
    action: actionResult,
  });
});

module.exports = router;
