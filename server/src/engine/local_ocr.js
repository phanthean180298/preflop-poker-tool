/**
 * local_ocr.js
 *
 * Local image analysis using Tesseract.js (OCR) + Sharp (image processing).
 * No cloud API required. Extracts:
 *   - Stack sizes, pot, blinds, tournament info  → via OCR + regex
 *   - Card ranks                                 → via OCR on cropped card region
 *   - Suited / offsuit                           → via color sampling of card backgrounds
 *
 * Limitations vs Gemini:
 *   - Position detection is unreliable (requires AI reasoning about table layout)
 *   - Accuracy depends on image resolution and poker client style
 */

const Tesseract = require("tesseract.js");
const sharp = require("sharp");

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert base64 string to Buffer */
function b64ToBuffer(base64) {
  const clean = base64.replace(/^data:image\/[a-z]+;base64,/, "");
  return Buffer.from(clean, "base64");
}

/** Get image dimensions */
async function getImageInfo(buffer) {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height, channels: meta.channels };
}

/**
 * Sample average RGB color in a rectangular region.
 * Skips near-black (<30 total) and near-white (>700 total) pixels to avoid
 * sampling background/text rather than card fill color.
 */
async function sampleRegionColor(buffer, left, top, width, height) {
  // Clamp to image bounds handled by sharp (it throws on out-of-bounds)
  const { data, info } = await sharp(buffer)
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels; // should be 3 after removeAlpha
  let rSum = 0,
    gSum = 0,
    bSum = 0,
    count = 0;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const total = r + g + b;
    if (total < 40 || total > 700) continue; // skip black/white
    rSum += r;
    gSum += g;
    bSum += b;
    count++;
  }
  if (count === 0) return { r: 128, g: 128, b: 128 };
  return { r: rSum / count, g: gSum / count, b: bSum / count };
}

/**
 * Determine if two sampled colors are similar enough to be the same suit.
 * Threshold is in terms of Euclidean distance in RGB space.
 */
function isSameColor(c1, c2, threshold = 35) {
  const dist = Math.sqrt(
    (c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2
  );
  return dist < threshold;
}

// ─── Card suit detection via color ──────────────────────────────────────────

/**
 * Detect whether hero's two hole cards are suited or offsuit.
 * Strategy: sample the background color of each card in the bottom-center
 * region of the image. If colors match → suited, else → offsuit.
 *
 * The hero card region heuristic works for most full-table poker clients
 * (Natural8, GGPoker, CoinPoker) where cards are displayed prominently
 * at the bottom-center of the screen.
 */
async function detectSuited(buffer, imgW, imgH) {
  // Hero cards sit in the bottom 35% of the image, horizontally centered.
  // First card ≈ 33-42% of width, second card ≈ 44-53% of width.
  const cardTop = Math.floor(imgH * 0.6);
  const cardH = Math.floor(imgH * 0.22);
  const card1L = Math.floor(imgW * 0.33);
  const card2L = Math.floor(imgW * 0.44);
  const cardW = Math.floor(imgW * 0.09);

  // Safety: ensure extracted region is within bounds
  if (
    card1L + cardW > imgW ||
    card2L + cardW > imgW ||
    cardTop + cardH > imgH
  ) {
    return null; // Cannot determine
  }

  try {
    const c1 = await sampleRegionColor(buffer, card1L, cardTop, cardW, cardH);
    const c2 = await sampleRegionColor(buffer, card2L, cardTop, cardW, cardH);
    return isSameColor(c1, c2) ? "s" : "o";
  } catch {
    return null;
  }
}

// ─── OCR ────────────────────────────────────────────────────────────────────

/**
 * Run Tesseract OCR on a preprocessed version of the image.
 * Preprocessing: greyscale + normalize + sharpen for better digit recognition.
 */
async function runOCR(buffer) {
  const preprocessed = await sharp(buffer)
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .png()
    .toBuffer();

  const {
    data: { text },
  } = await Tesseract.recognize(preprocessed, "eng", {
    logger: () => {},
  });
  return text;
}

/**
 * Run OCR on just the hero card region (bottom-center) for card rank detection.
 * Returns OCR text of that cropped area.
 */
async function runCardRegionOCR(buffer, imgW, imgH) {
  const left = Math.floor(imgW * 0.28);
  const top = Math.floor(imgH * 0.58);
  const width = Math.floor(imgW * 0.44);
  const height = Math.floor(imgH * 0.3);

  if (left + width > imgW || top + height > imgH) return "";

  try {
    const cardCrop = await sharp(buffer)
      .extract({ left, top, width, height })
      .greyscale()
      .normalize()
      .sharpen({ sigma: 2 })
      // Scale up 2x for better OCR on small card text
      .resize(width * 2, height * 2, { kernel: "lanczos3" })
      .png()
      .toBuffer();

    const {
      data: { text },
    } = await Tesseract.recognize(cardCrop, "eng", {
      logger: () => {},
      tessedit_char_whitelist: "23456789TJQKAtjqka ",
    });
    return text;
  } catch {
    return "";
  }
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

const RANKS = "23456789TJQKA";

/** Normalize a single rank token */
function normRank(r) {
  const u = r.toUpperCase().replace("10", "T").replace("0", "");
  if (RANKS.includes(u)) return u;
  return null;
}

/** Extract all BB-denominated values from text → sorted desc */
function parseAllStacks(text) {
  const stacks = [];
  const re = /(\d+\.?\d*)\s*BB/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (v > 0.4 && v < 5000) stacks.push(v);
  }
  return stacks;
}

function parsePot(text) {
  // "Tổng Pot : 50.9 BB" / "Total Pot: 50.9 BB" / "Pot 50.9BB"
  const m = text.match(
    /(?:Tổng\s*Pot|Total\s*Pot|Pot)\s*[:\|]?\s*(\d+\.?\d*)\s*BB/i
  );
  return m ? parseFloat(m[1]) : null;
}

function parseBlinds(text) {
  // "Blinds 50 | 100" / "50 | 100" / "50/100"
  const m = text.match(/(?:Blinds?\s+)?(\d+)\s*[|\/]\s*(\d+)/i);
  if (!m) return null;
  return { sb: parseInt(m[1]), bb: parseInt(m[2]) };
}

function parseTournamentInfo(text) {
  // Level: "Cấp độ 4" / "Level 4"
  const levelM = text.match(/(?:Cấp\s*(?:độ\s*)?|Level\s*)(\d+)/i);

  // Players: "54 / 110" or "54/110"
  const rankM = text.match(/(\d{1,4})\s*\/\s*(\d{2,5})(?!\s*BB)/);

  // Time remaining: "01:45"
  const timeM = text.match(/(\d{2}:\d{2})(?!:\d)/);

  // Prize pool: "T$7.71" or "$7.71"
  const prizeM = text.match(/T?\$[\d.]+/);

  // Late reg
  const lateReg = /late\s*reg|đăng\s*ký\s*trễ/i.test(text);

  return {
    tournament_level: levelM ? parseInt(levelM[1]) : null,
    players_remaining: rankM ? parseInt(rankM[1]) : null,
    total_players: rankM ? parseInt(rankM[2]) : null,
    ranking: rankM ? `${rankM[1]}/${rankM[2]}` : null,
    level_time_remaining: timeM ? timeM[1] : null,
    prize_pool: prizeM ? prizeM[0] : null,
    late_reg: lateReg,
  };
}

/** Extract card ranks from the hero card region OCR text */
function parseCardRanks(cardText, fullText) {
  const candidates = [];

  // Look for rank tokens in card OCR
  const tokens = (cardText + " " + fullText)
    .split(/[\s,\-\n\r]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const tok of tokens) {
    const r = normRank(tok);
    if (r && !candidates.includes(r)) candidates.push(r);
    if (candidates.length >= 2) break;
  }
  return candidates;
}

/** Build the hero hand string from ranks + suited/offsuit */
function buildHand(ranks, suited) {
  if (ranks.length < 2) return null;
  const [r1, r2] = ranks;
  if (r1 === r2) return r1 + r2; // pair
  const hi = RANKS.indexOf(r1) >= RANKS.indexOf(r2) ? r1 : r2;
  const lo = RANKS.indexOf(r1) >= RANKS.indexOf(r2) ? r2 : r1;
  return hi + lo + (suited ?? "o");
}

// ─── Main analyzer ───────────────────────────────────────────────────────────

async function analyzeLocal(base64Image) {
  const buffer = b64ToBuffer(base64Image);
  const { width, height } = await getImageInfo(buffer);

  // Run OCR + color detection in parallel
  const [fullText, cardText, suited] = await Promise.all([
    runOCR(buffer),
    runCardRegionOCR(buffer, width, height),
    detectSuited(buffer, width, height),
  ]);

  // Parse fields
  const stacks = parseAllStacks(fullText);
  const pot = parsePot(fullText);
  const blinds = parseBlinds(fullText);
  const tournInfo = parseTournamentInfo(fullText);
  const cardRanks = parseCardRanks(cardText, fullText);
  const heroHand = buildHand(cardRanks, suited);

  // Hero stack heuristic: use median stack value (hero sits center-bottom)
  const sorted = [...stacks].sort((a, b) => a - b);
  const heroStack = sorted[Math.floor(sorted.length / 2)] ?? null;

  return {
    hero_hand: heroHand,
    hero_pos: null, // Cannot reliably detect locally — user should set manually
    hero_stack_bb: heroStack,
    villain_stacks: {}, // Individual attribution requires AI
    vpip: {},
    bounties: {},
    pot_bb: pot,
    street: "preflop",
    board: [],
    available_actions: [],
    call_amount_bb: null,
    raise_amount_bb: null,
    blinds,
    ante_bb: 0,
    table_size: null,
    ...tournInfo,
    table_name: null,
    _method: "local-ocr",
    _note:
      "Position detection unavailable locally — please set manually in the position tabs.",
  };
}

module.exports = { analyzeLocal };
