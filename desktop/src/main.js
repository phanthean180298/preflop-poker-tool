import "./style.css";

const API = "http://localhost:3001/api";
const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

// ─── State
const state = {
  scenario: "rfi",
  position: "BTN",
  vsPosition: "EP",
  stackBB: 40,
  anteBB: 0.1,
  rfiSizeBB: 2.5,
  threeBetSizeBB: 7.5,
  tableSize: 6,
  positions: ["EP", "MP", "CO", "BTN", "SB", "BB"],
  selectedHand: null,
  rangeCache: {},
  sessionId: null,
  queryCount: 0,
  icm: {
    enabled: false,
    heroIdx: 0,
    stacks: [],
    prizes: [],
    playersRemaining: 9,
    totalPlayers: 1000,
    result: null,
    payjumpInfo: null,
  },
  tournament: {
    stage: "mid", // "early"|"mid"|"bubble"|"itm"|"ft"
    bounty: 0, // villain bounty
    heroBounty: 0,
    buyin: 10,
  },
  importedRange: null,
  refImage: null,
  positionCache: {},
  multiway: {
    active: true,
    actions: {}, // pos -> "fold"|"limp"|"raise"|"call"|"3bet"|"4bet"|"allin"
  },
  analyzeApiKey: localStorage.getItem("openai_api_key") || "",
  geminiApiKey: localStorage.getItem("gemini_api_key") || "",
  analyzeModel: (function () {
    const VALID_MODELS = [
      "local-ocr",
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gpt-4o-mini",
      "gpt-4o",
    ];
    const saved = localStorage.getItem("analyze_model");
    if (saved && VALID_MODELS.includes(saved)) return saved;
    localStorage.setItem("analyze_model", "gemini-2.5-flash");
    return "gemini-2.5-flash";
  })(),
  lastAnalysis: null,
};

// ─── HTML
document.getElementById("app").innerHTML = `
<div class="topbar">
  <div class="topbar-logo">&#9824; <span>GTO</span> Preflop</div>
  <div class="topbar-sep"></div>
  <div class="topbar-field">
    <label>Table</label>
    <select id="tableSizeSelect" style="width:52px">
      <option value="5">5-max</option>
      <option value="6" selected>6-max</option>
      <option value="7">7-max</option>
      <option value="8">8-max</option>
      <option value="9">9-max</option>
    </select>
  </div>
  <div class="topbar-sep"></div>
  <div class="topbar-field">
    <label>Stack</label>
    <input id="stackInput" type="number" value="40" min="1" max="500" step="1" style="width:55px"/>
    <label>BB</label>
  </div>
  <div class="topbar-field">
    <label>Ante</label>
    <input id="anteInput" type="number" value="0.1" min="0" max="2" step="0.05" style="width:50px"/>
    <label>BB</label>
  </div>
  <div class="topbar-sep"></div>
  <div class="scenario-tabs" id="scenarioTabs">
    <button data-val="rfi" class="active">RFI</button>
    <button data-val="vs_rfi">vs RFI</button>
    <button data-val="vs_3bet">vs 3bet</button>
  </div>
  <div class="topbar-field" id="vsPositionField" style="display:none">
    <label>vs</label>
    <select id="vsPositionSelect" style="width:70px"></select>
  </div>
  <div class="topbar-sep"></div>
  <button class="topbar-btn" id="importJsonBtn" title="Import JSON range">&#8679; JSON</button>
  <button class="topbar-btn analyze-btn" id="importImgBtn" title="Import &amp; analyze screenshot with AI">&#129302; Analyze</button>
  <input type="file" id="fileJsonInput" accept=".json" style="display:none"/>
  <input type="file" id="fileImgInput" accept="image/*" style="display:none"/>
  <button class="topbar-btn" id="icmToggleBtn" title="Toggle ICM panel">ICM</button>
  <div id="serverStatus" class="server-pill loading">Connecting&#8230;</div>
</div>
<div class="pos-tabs" id="posTabs"></div>
<div class="action-seq-bar" id="actionSeqBar"></div>
<div class="body" id="mainBody">
  <div class="range-area">
    <div class="range-header">
      <div class="range-title" id="rangeTitle">BTN &mdash; RFI &mdash; 40bb</div>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:#e83c3c"></div>Raise</div>
        <div class="legend-item"><div class="legend-dot" style="background:#3c8fe8"></div>Call</div>
        <div class="legend-item"><div class="legend-dot" style="background:linear-gradient(135deg,#e83c3c 50%,#3060b0 50%)"></div>Mixed</div>
        <div class="legend-item"><div class="legend-dot" style="background:#1e2745"></div>Fold</div>
      </div>
      <button class="btn-load" id="loadRangeBtn" style="width:auto;padding:5px 14px;margin-left:auto">Load Range</button>
    </div>
    <div class="range-grid-wrap">
      <div class="range-grid" id="rangeGrid"></div>
    </div>
  </div>
  <div class="right-panel">
    <div class="panel-tabs">
      <button class="panel-tab active" data-tab="overview">Overview</button>
      <button class="panel-tab" data-tab="ev">EV</button>
      <button class="panel-tab" data-tab="icm">ICM</button>
      <button class="panel-tab" data-tab="settings">Settings</button>
    </div>
    <div class="panel-body" id="panelBody">
      <div class="empty-panel"><div class="icon">&#9824;</div><div>Click a hand on the grid<br/>or load a range to begin</div></div>
    </div>
  </div>
</div>
<div id="imgOverlay" class="img-overlay" style="display:none">
  <div class="img-modal">
    <button class="img-close" id="imgClose">&#10005;</button>
    <img id="refImg" src="" alt="Reference"/>
    <div class="img-modal-bar">
      <button class="btn-load" id="imgAnalyzeAgainBtn" style="margin:0;width:auto;padding:6px 18px">&#129302; Analyze this image</button>
      <span style="font-size:11px;color:var(--muted)">Requires OpenAI API key in Settings</span>
    </div>
  </div>
</div>
<div class="statusbar">
  Session: <strong id="sessionId">&mdash;</strong>
  <span class="sep">|</span> Hands: <strong id="queryCount">0</strong>
  <span class="sep">|</span> Table: <strong id="tableLabel">6-max</strong>
  <span class="sep" id="icmStatusSep" style="display:none">|</span>
  <span id="icmStatusText" style="display:none"></span>
</div>
`;

// ─── Helpers
function rangeKey() {
  const base = `${state.position}|${state.stackBB}|${state.anteBB}|${state.tableSize}`;
  const seqStr = Object.entries(state.multiway.actions)
    .sort()
    .map(([p, a]) => `${p}:${a}`)
    .join(",");
  return seqStr ? `${base}|mw:${seqStr}` : base;
}
function actionTag(action, freq) {
  if (action === "fold") return "fold";
  if (freq != null && freq < 0.92)
    return action === "raise" ? "mixed" : "mixed-call";
  if (action === "raise") return state.stackBB <= 15 ? "allin" : "raise";
  return "call";
}

// Build proportional gradient background matching GTO+ style:
// Red=raise/aggr | Green=call | Navy=fold
function cellBg(d) {
  const RAISE = "#e84040";
  const CALL = "#3db554";
  const FOLD = "#131828";

  const strat = d.adjusted_strategy || d.strategy;
  if (!strat) {
    if (d.action === "fold") return FOLD;
    if (d.action === "call") return CALL;
    return RAISE;
  }

  let aggr = 0,
    call = 0,
    fold = 0;
  for (const [a, p] of Object.entries(strat)) {
    if (a === "fold") fold += p;
    else if (a === "call" || a === "limp") call += p;
    else aggr += p;
  }
  const total = aggr + call + fold;
  if (total < 0.01) return FOLD;

  const ra = aggr / total;
  const rc = call / total;
  const rf = fold / total;

  // Pure single color
  if (ra > 0.995) return RAISE;
  if (rc > 0.995) return CALL;
  if (rf > 0.995) return FOLD;

  // Proportional horizontal gradient: raise | call | fold
  const p1 = (ra * 100).toFixed(1);
  const p2 = ((ra + rc) * 100).toFixed(1);
  const stops = [];
  if (ra > 0.01) stops.push(`${RAISE} 0%`, `${RAISE} ${p1}%`);
  if (rc > 0.01) stops.push(`${CALL} ${p1}%`, `${CALL} ${p2}%`);
  if (rf > 0.01) stops.push(`${FOLD} ${p2}%`, `${FOLD} 100%`);
  if (stops.length < 4) return ra > rc ? RAISE : rc > rf ? CALL : FOLD;
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
function pct(v) {
  return Math.round((v ?? 1) * 100);
}
function handType(hand) {
  if (hand.length === 2) return "Pair";
  return hand.endsWith("s") ? "Suited" : "Offsuit";
}
function rawCombos(hand) {
  return hand.length === 2 ? 6 : hand.endsWith("s") ? 4 : 12;
}
function evColor(ev) {
  if (ev > 0.15) return "var(--ev-pos)";
  if (ev < -0.1) return "var(--ev-neg)";
  return "var(--muted2)";
}
function evLabel(ev) {
  if (ev == null) return "—";
  const sign = ev >= 0 ? "+" : "";
  return `${sign}${ev.toFixed(2)} BB`;
}

// ─── Position tabs
function buildPosTabs() {
  const container = document.getElementById("posTabs");
  container.innerHTML = state.positions
    .map(
      (p) => `
    <button class="pos-tab${
      p === state.position ? " active" : ""
    }" data-pos="${p}">
      <div class="pos-name">${p}</div>
      <div class="pos-stack">${state.stackBB}bb</div>
      <div class="pos-range-bar" id="tabBar-${p}"></div>
    </button>
  `
    )
    .join("");

  const vsSel = document.getElementById("vsPositionSelect");
  vsSel.innerHTML = state.positions
    .filter((p) => p !== "BB")
    .map(
      (p) => `<option${p === state.vsPosition ? " selected" : ""}>${p}</option>`
    )
    .join("");
}

// ─── Range grid
function buildEmptyGrid() {
  const grid = document.getElementById("rangeGrid");
  grid.innerHTML = "";
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hand = cellHand(i, j);
      const cell = document.createElement("div");
      cell.className = "range-cell";
      cell.id = `cell-${hand}`;
      cell.textContent = hand;
      cell.title = hand;
      cell.addEventListener("click", () => onCellClick(hand, cell));
      grid.appendChild(cell);
    }
  }
}

function cellHand(i, j) {
  if (i === j) return RANKS[i] + RANKS[j];
  if (i < j) return RANKS[i] + RANKS[j] + "s";
  return RANKS[j] + RANKS[i] + "o";
}

function applyRangeToGrid(rangeData) {
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hand = cellHand(i, j);
      const cell = document.getElementById(`cell-${hand}`);
      if (!cell) continue;
      cell.classList.remove("loading");
      const d = rangeData[hand];
      if (d) {
        cell.dataset.action = actionTag(d.action, d.freq);
        cell.style.background = cellBg(d);
        cell.style.color = d.action === "fold" ? "#5a6488" : "#fff";
        const evStr = d.ev ? ` · EV: ${evLabel(d.ev[d.action])}` : "";
        cell.title = `${hand} → ${d.action.toUpperCase()} ${pct(d.freq)}%${
          d.sizeBB > 0 ? ` (${d.sizeBB.toFixed(1)}bb)` : ""
        }${evStr}`;
      } else {
        delete cell.dataset.action;
        cell.style.background = "";
        cell.style.color = "";
      }
    }
  }
  updateTabBar(state.position, rangeData);
}

function showLoadingGrid() {
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hand = cellHand(i, j);
      const cell = document.getElementById(`cell-${hand}`);
      if (cell) {
        cell.className = "range-cell loading";
        delete cell.dataset.action;
      }
    }
  }
}

function updateTabBar(pos, rangeData) {
  const bar = document.getElementById(`tabBar-${pos}`);
  if (!bar) return;
  let r = 0,
    c = 0,
    f = 0;
  Object.values(rangeData).forEach((d) => {
    if (d.action === "raise") r++;
    else if (d.action === "call") c++;
    else f++;
  });
  const total = r + c + f || 1;
  bar.innerHTML = `
    <div class="pb raise" style="width:${Math.round(
      (r / total) * 22
    )}px;min-width:${r > 0 ? 2 : 0}px"></div>
    <div class="pb call"  style="width:${Math.round(
      (c / total) * 22
    )}px;min-width:${c > 0 ? 2 : 0}px"></div>
    <div class="pb fold"  style="width:${Math.round(
      (f / total) * 22
    )}px;min-width:${f > 0 ? 2 : 0}px"></div>
  `;
}

// ─── Right panel
function renderOverviewEmpty() {
  document.getElementById("panelBody").innerHTML = `
    <div class="empty-panel">
      <div class="icon">&#9824;</div>
      <div>Click a hand on the grid<br/>or load a range to begin</div>
    </div>`;
}

function renderHandOverview(hand, d) {
  if (!d) {
    renderOverviewEmpty();
    return;
  }
  const tag = actionTag(d.action, d.freq);
  const actionLabel =
    d.pushFoldMode && d.action === "raise" ? "SHOVE" : d.action.toUpperCase();
  const freqPct = pct(d.freq);
  const foldPct = d.action === "fold" ? freqPct : 100 - freqPct;
  const raisePct = d.action === "raise" ? freqPct : 0;
  const callPct = d.action === "call" ? freqPct : 0;
  const rc = rawCombos(hand);
  const activeCombos = Math.round(((rc * freqPct) / 100) * 10) / 10;

  const evHtml = d.ev
    ? `
    <div class="ev-inline">
      ${
        d.ev.raise != null
          ? `<span class="ev-tag ${d.ev.raise >= 0 ? "pos" : "neg"}">${
              d.action === "raise"
                ? d.pushFoldMode
                  ? "Shove"
                  : "Raise"
                : "3bet"
            } ${evLabel(d.ev.raise)}</span>`
          : ""
      }
      ${
        d.ev.call != null
          ? `<span class="ev-tag ${
              d.ev.call >= 0 ? "pos" : "neg"
            }">Call ${evLabel(d.ev.call)}</span>`
          : ""
      }
      <span class="ev-tag neutral">Fold +0.00 BB</span>
    </div>`
    : "";

  document.getElementById("panelBody").innerHTML = `
    <div class="hand-badge">
      <div class="hand-name">${hand}</div>
      <div class="hand-type">${handType(hand)}</div>
      ${
        d.cached
          ? '<div class="hand-type" style="color:#38d9a9">&#9889;</div>'
          : ""
      }
    </div>
    <div class="advice-card">
      <div class="advice-action ${tag}">${actionLabel}</div>
      ${
        d.sizeBB > 0
          ? `<div class="advice-row">Size <span>${d.sizeBB.toFixed(
              1
            )} BB</span></div>`
          : ""
      }
      <div class="advice-row">Frequency <span>${freqPct}%</span></div>
      <div class="advice-row">Stack <span>${state.stackBB} BB${
    state.anteBB > 0 ? ` · ${state.anteBB}bb ante` : ""
  }</span></div>
      <div class="advice-row">Mode <span>${
        d.pushFoldMode ? "Push/Fold" : "Standard"
      }</span></div>
      <div class="advice-row">Table <span>${state.tableSize}-max</span></div>
    </div>
    ${evHtml}
    <div class="freq-stack">
      ${
        raisePct > 0
          ? `<div class="freq-seg raise" style="flex:${raisePct}"></div>`
          : ""
      }
      ${
        callPct > 0
          ? `<div class="freq-seg call"  style="flex:${callPct}"></div>`
          : ""
      }
      ${
        foldPct > 0
          ? `<div class="freq-seg fold"  style="flex:${foldPct}"></div>`
          : ""
      }
    </div>
    <div class="action-boxes">
      <div class="action-box raise">
        <div class="ab-label">${d.pushFoldMode ? "Shove" : "Raise"}</div>
        <div class="ab-pct">${raisePct}%</div>
        <div class="ab-combos">${raisePct > 0 ? activeCombos : 0} comb</div>
        ${
          d.ev && d.ev.raise != null
            ? `<div class="ab-ev ${d.ev.raise >= 0 ? "pos" : "neg"}">${evLabel(
                d.ev.raise
              )}</div>`
            : ""
        }
      </div>
      <div class="action-box call">
        <div class="ab-label">Call</div>
        <div class="ab-pct">${callPct}%</div>
        <div class="ab-combos">${callPct > 0 ? activeCombos : 0} comb</div>
        ${
          d.ev && d.ev.call != null
            ? `<div class="ab-ev ${d.ev.call >= 0 ? "pos" : "neg"}">${evLabel(
                d.ev.call
              )}</div>`
            : ""
        }
      </div>
      <div class="action-box fold">
        <div class="ab-label">Fold</div>
        <div class="ab-pct">${foldPct}%</div>
        <div class="ab-combos">${
          Math.round(((rc * foldPct) / 100) * 10) / 10
        } comb</div>
        <div class="ab-ev neutral">+0.00 BB</div>
      </div>
    </div>
    <div id="pos-cmp-section" class="ev-section" style="margin-top:12px">
      <div class="pos-cmp-loading">Loading positions…</div>
    </div>
  `;
  // async: fetch all positions and update the section in-place
  fetchAllPositions(hand).then((posResults) =>
    renderPositionComparison(hand, posResults)
  );
}

function renderEVPanel(hand, d) {
  if (!d || !d.ev) {
    document.getElementById(
      "panelBody"
    ).innerHTML = `<div class="empty-panel"><div>No EV data.<br/>Load a range first.</div></div>`;
    return;
  }
  const ev = d.ev;
  const actions = [
    { key: "raise", label: d.pushFoldMode ? "Shove" : "Raise", val: ev.raise },
    { key: "call", label: "Call", val: ev.call ?? null },
    { key: "fold", label: "Fold", val: 0 },
  ].filter((a) => a.val !== null);

  const bestAction = actions.reduce(
    (best, a) => ((a.val ?? -999) > (best.val ?? -999) ? a : best),
    actions[0]
  );

  document.getElementById("panelBody").innerHTML = `
    <div class="hand-badge">
      <div class="hand-name">${hand}</div>
      <div class="hand-type">${handType(hand)}</div>
    </div>
    <div class="ev-section">
      <div class="ev-title">Chip EV Estimate (per action)</div>
      ${actions
        .map(
          (a) => `
        <div class="ev-row${a.key === bestAction.key ? " ev-best" : ""}">
          <div class="ev-action-label ${a.key}">${a.label}</div>
          <div class="ev-bar-wrap">
            <div class="ev-bar">
              <div class="ev-bar-fill ${(a.val ?? 0) >= 0 ? "pos" : "neg"}"
                style="width:${Math.min(
                  100,
                  (Math.abs(a.val ?? 0) / 5) * 100
                )}%"></div>
            </div>
          </div>
          <div class="ev-value" style="color:${evColor(a.val ?? 0)}">${evLabel(
            a.val ?? 0
          )}</div>
          ${
            a.key === bestAction.key
              ? '<div class="ev-best-badge">Best</div>'
              : ""
          }
        </div>
      `
        )
        .join("")}
    </div>
    ${
      d.factors
        ? renderFactorsSection(d)
        : state.icm.result
        ? renderICMEVInline(d)
        : `<div class="ev-hint">Enable ICM panel for tournament-adjusted EV.</div>`
    }
    <div class="ev-disclaimer">
      EV values are estimates based on fold equity models.<br/>
      Use as directional guidance, not exact GTO solutions.
    </div>
  `;
}

function renderFactorsSection(d) {
  const f = d.factors;
  if (!f) return "";
  const strat = d.adjusted_strategy || {};
  const rows = [
    { label: "ICM Risk", val: f.icm_risk, pct: true, invert: true },
    { label: "Bounty EV", val: f.bounty_ev, pct: false, isBB: true },
    { label: "Buy-in Factor", val: f.buy_in_factor, pct: false, mult: true },
    { label: "Stack Factor", val: f.stack_factor, pct: false, mult: true },
    { label: "Aggr. Mult.", val: f.aggr_mult, pct: false, mult: true },
  ];
  const stageColors = {
    early: "var(--ev-pos)",
    mid: "var(--muted2)",
    bubble: "var(--danger)",
    itm: "var(--warn)",
    ft: "var(--danger)",
  };
  const stage = state.tournament.stage;
  return `
    <div class="ev-section" style="margin-top:12px">
      <div class="ev-title">Tournament Factors
        <span style="margin-left:6px;font-size:10px;padding:1px 6px;border-radius:10px;
          background:${
            stageColors[stage] || "var(--muted2)"
          };color:#fff">${stage.toUpperCase()}</span>
      </div>
      ${rows
        .map((row) => {
          const v = row.val ?? 0;
          const display = row.isBB
            ? `${v > 0 ? "+" : ""}${v.toFixed(2)} BB`
            : row.mult
            ? `×${v.toFixed(3)}`
            : row.pct
            ? `${Math.round(v * 100)}%`
            : v.toFixed(3);
          const good = row.invert ? v < 0.6 : v > 1;
          const color = row.isBB
            ? v > 0
              ? "var(--ev-pos)"
              : "var(--muted2)"
            : good
            ? "var(--ev-pos)"
            : v === 1 || (!row.invert && v === 1.0)
            ? "var(--muted2)"
            : "var(--warn)";
          return `<div class="ev-row"><div class="ev-action-label">${row.label}</div><div class="ev-value" style="color:${color}">${display}</div></div>`;
        })
        .join("")}
      ${
        d.adjusted_strategy
          ? `
        <div style="margin-top:8px;font-size:11px;color:var(--muted)">
          Adjusted: ${Object.entries(strat)
            .map(([a, v]) => `${a} ${Math.round(v * 100)}%`)
            .join(" · ")}
        </div>`
          : ""
      }
    </div>`;
}

function renderICMEVInline(d) {
  const icmResult = state.icm.result;
  if (!icmResult) return "";
  const pressure = icmResult.players?.[state.icm.heroIdx]?.pressure ?? 0;
  const pressureLabel =
    pressure < 0.2 ? "Low" : pressure < 0.5 ? "Medium" : "High";
  const pressureColor =
    pressure < 0.2
      ? "var(--ev-pos)"
      : pressure < 0.5
      ? "var(--warn)"
      : "var(--danger)";
  return `
    <div class="ev-section" style="margin-top:12px">
      <div class="ev-title">ICM Context</div>
      <div class="ev-row">
        <div class="ev-action-label">ICM Pressure</div>
        <div class="ev-value" style="color:${pressureColor}">${pressureLabel} (${Math.round(
    pressure * 100
  )}%)</div>
      </div>
      <div class="ev-row">
        <div class="ev-action-label">Your Equity</div>
        <div class="ev-value">${(
          icmResult.players?.[state.icm.heroIdx]?.equityPct ?? 0
        ).toFixed(2)}%</div>
      </div>
      <div class="ev-note" style="font-size:11px;color:var(--muted);margin-top:6px">
        High ICM pressure &#8594; avoid marginal gambles even if chip-EV positive.
      </div>
    </div>`;
}

function renderRangeSummary(rangeData) {
  let raise = 0,
    call = 0,
    fold = 0;
  Object.entries(rangeData).forEach(([hand, d]) => {
    const raw = rawCombos(hand);
    if (d.action === "raise") raise += raw * (d.freq ?? 1);
    else if (d.action === "call") call += raw * (d.freq ?? 1);
    else fold += raw;
  });
  const total = raise + call + fold || 1;
  const rP = Math.round((raise / total) * 100);
  const cP = Math.round((call / total) * 100);
  const fP = 100 - rP - cP;
  document.getElementById("panelBody").innerHTML = `
    <div class="range-stats">
      <div class="range-stats-title">${
        state.position
      } ${state.scenario.toUpperCase()} · ${state.tableSize}-max · ${
    state.stackBB
  }bb</div>
      <div class="range-stat-row">Raise / Shove <span>${rP}%</span></div>
      <div class="range-stat-row">Call <span>${cP}%</span></div>
      <div class="range-stat-row">Fold <span>${fP}%</span></div>
      <div class="range-stat-row">Total combos <span>${Math.round(
        total
      )}</span></div>
    </div>
    <div class="freq-stack" style="height:12px;margin-bottom:18px">
      <div class="freq-seg raise" style="flex:${rP}"></div>
      <div class="freq-seg call"  style="flex:${cP}"></div>
      <div class="freq-seg fold"  style="flex:${fP}"></div>
    </div>
    <div class="action-boxes">
      <div class="action-box raise"><div class="ab-label">Raise</div><div class="ab-pct">${rP}%</div><div class="ab-combos">${Math.round(
    raise
  )} comb</div></div>
      <div class="action-box call"><div class="ab-label">Call</div><div class="ab-pct">${cP}%</div><div class="ab-combos">${Math.round(
    call
  )} comb</div></div>
      <div class="action-box fold"><div class="ab-label">Fold</div><div class="ab-pct">${fP}%</div><div class="ab-combos">${Math.round(
    fold
  )} comb</div></div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:8px">Click any hand for details.</p>
  `;
}

function renderICMPanel() {
  const icmState = state.icm;
  if (icmState.stacks.length === 0) {
    icmState.stacks = Array.from({ length: state.tableSize }, (_, i) =>
      i === icmState.heroIdx
        ? state.stackBB * 100
        : Math.round(state.stackBB * 100 * (0.7 + Math.random() * 0.6))
    );
    icmState.prizes = [500, 300, 200, 100, 50];
    icmState.playersRemaining = 18;
  }
  document.getElementById("panelBody").innerHTML = `
    <div class="icm-panel">
      <div class="icm-section-title">Tournament Setup</div>
      <div class="input-group">
        <label>Players remaining (total)</label>
        <input id="icmPlayersRemaining" type="number" value="${
          icmState.playersRemaining
        }" min="2" max="10000" step="1"/>
      </div>
      <div class="input-group">
        <label>Hero seat (0-indexed)</label>
        <input id="icmHeroIdx" type="number" value="${
          icmState.heroIdx
        }" min="0" max="${state.tableSize - 1}" step="1"/>
      </div>
      <div class="icm-section-title" style="margin-top:12px">Chip Stacks at Table</div>
      <div id="icmStacksGrid" class="icm-stacks-grid">
        ${icmState.stacks
          .map(
            (s, i) => `
          <div class="icm-stack-row${i === icmState.heroIdx ? " hero" : ""}">
            <label>${i === icmState.heroIdx ? "You" : "Seat " + (i + 1)}</label>
            <input type="number" class="icm-stack-input" data-idx="${i}" value="${s}" min="0" step="100"/>
          </div>`
          )
          .join("")}
      </div>
      <button class="btn-mini" id="icmAddSeat">+ Add seat</button>
      <div class="icm-section-title" style="margin-top:12px">Prize Structure</div>
      <div id="icmPrizesGrid" class="icm-stacks-grid">
        ${icmState.prizes
          .map(
            (p, i) => `
          <div class="icm-stack-row">
            <label>${i + 1}${["st", "nd", "rd"][i] || "th"} place</label>
            <input type="number" class="icm-prize-input" data-idx="${i}" value="${p}" min="0" step="10"/>
          </div>`
          )
          .join("")}
      </div>
      <button class="btn-mini" id="icmAddPrize">+ Add prize tier</button>
      <button class="btn-load" id="calcIcmBtn" style="margin-top:14px">Calculate ICM</button>
      ${icmState.result ? renderICMResult(icmState.result) : ""}
    </div>
  `;
  document.querySelectorAll(".icm-stack-input").forEach((inp) => {
    inp.addEventListener("change", (e) => {
      icmState.stacks[Number(e.target.dataset.idx)] = Number(e.target.value);
    });
  });
  document.querySelectorAll(".icm-prize-input").forEach((inp) => {
    inp.addEventListener("change", (e) => {
      icmState.prizes[Number(e.target.dataset.idx)] = Number(e.target.value);
    });
  });
  document
    .getElementById("icmPlayersRemaining")
    .addEventListener("change", (e) => {
      icmState.playersRemaining = Number(e.target.value);
    });
  document.getElementById("icmHeroIdx").addEventListener("change", (e) => {
    icmState.heroIdx = Number(e.target.value);
    renderICMPanel();
  });
  document.getElementById("icmAddSeat").addEventListener("click", () => {
    icmState.stacks.push(4000);
    renderICMPanel();
  });
  document.getElementById("icmAddPrize").addEventListener("click", () => {
    icmState.prizes.push(10);
    renderICMPanel();
  });
  document.getElementById("calcIcmBtn").addEventListener("click", calculateICM);
}

function renderICMResult(result) {
  if (!result || !result.players) return "";
  const hero = result.players[state.icm.heroIdx];
  if (!hero) return "";
  const payjump = state.icm.payjumpInfo;
  const pressure = hero.pressure;
  const pressureLabel =
    pressure < 0.2
      ? "Low &#128994;"
      : pressure < 0.5
      ? "Medium &#128993;"
      : pressure < 0.75
      ? "High &#128308;"
      : "Extreme &#128308;";
  return `
    <div class="icm-result">
      <div class="icm-section-title">ICM Results</div>
      <div class="icm-result-row"><span>Your equity</span><strong>${hero.equityPct.toFixed(
        2
      )}%</strong></div>
      <div class="icm-result-row"><span>Chip %</span><strong>${hero.chipPct.toFixed(
        1
      )}%</strong></div>
      <div class="icm-result-row"><span>$ Equity</span><strong>$${hero.equity.toFixed(
        0
      )}</strong></div>
      <div class="icm-result-row"><span>ICM Pressure</span><strong>${pressureLabel}</strong></div>
      ${
        payjump
          ? `
        <div class="icm-result-row"><span>Players to bubble</span><strong>${
          payjump.bubblesAway
        }</strong></div>
        <div class="icm-result-row"><span>ITM</span><strong>${
          payjump.inTheMoney ? "&#10003; Yes" : "&#10007; No"
        }</strong></div>
        <div class="icm-result-row"><span>Next pay jump</span><strong>+$${payjump.jumpAmount.toFixed(
          0
        )}</strong></div>
        <div class="icm-result-row"><span>On bubble</span><strong>${
          payjump.onBubble ? "&#9888; YES" : "No"
        }</strong></div>
      `
          : ""
      }
      <div class="icm-advice" style="color:${
        pressure > 0.5
          ? "var(--danger)"
          : pressure > 0.2
          ? "var(--warn)"
          : "var(--ev-pos)"
      }">
        ${
          pressure > 0.65
            ? "Extreme ICM pressure — fold equity is gold, avoid marginal all-ins."
            : pressure > 0.4
            ? "High ICM pressure — tighten ranges, especially vs aggression."
            : pressure > 0.2
            ? "Moderate ICM pressure — slight range adjustment recommended."
            : "Low ICM pressure — play close to chip-EV."
        }
      </div>
    </div>`;
}

function renderSettingsPanel() {
  const STAGES = ["early", "mid", "bubble", "itm", "ft"];
  document.getElementById("panelBody").innerHTML = `
    <div class="input-panel">
      <div class="input-group">
        <label>Open raise size (BB)</label>
        <input id="s-rfiSize" type="number" value="${
          state.rfiSizeBB
        }" min="2" max="6" step="0.5"/>
      </div>
      <div class="input-group">
        <label>3bet size (BB)</label>
        <input id="s-3betSize" type="number" value="${
          state.threeBetSizeBB
        }" min="5" max="30" step="0.5"/>
      </div>
      <div style="margin-top:14px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">Tournament Context</div>
      <div class="input-group">
        <label>Stage</label>
        <select id="s-stage">${STAGES.map(
          (s) =>
            '<option value="' +
            s +
            '"' +
            (s === state.tournament.stage ? " selected" : "") +
            ">" +
            s.charAt(0).toUpperCase() +
            s.slice(1) +
            "</option>"
        ).join("")}</select>
      </div>
      <div class="input-group">
        <label>Buy-in ($)</label>
        <input id="s-buyin" type="number" value="${
          state.tournament.buyin
        }" min="0" max="10000" step="1"/>
      </div>
      <div class="input-group">
        <label>Villain bounty ($)</label>
        <input id="s-bounty" type="number" value="${
          state.tournament.bounty
        }" min="0" step="1"/>
      </div>
      <div class="input-group">
        <label>Hero bounty ($)</label>
        <input id="s-heroBounty" type="number" value="${
          state.tournament.heroBounty
        }" min="0" step="1"/>
      </div>
      <div style="margin-top:14px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">AI Screenshot Analysis</div>
      <div class="input-group">
        <label>Model</label>
        <select id="s-model">
          <option value="local-ocr"${
            state.analyzeModel === "local-ocr" ? " selected" : ""
          }>&#127968; Local OCR (no API key)</option>
          <option value="gemini-2.5-flash"${
            state.analyzeModel === "gemini-2.5-flash" ? " selected" : ""
          }>gemini-2.5-flash (free, best)</option>
          <option value="gemini-flash-latest"${
            state.analyzeModel === "gemini-flash-latest" ? " selected" : ""
          }>gemini-flash-latest (free, alias)</option>
          <option value="gpt-4o-mini"${
            state.analyzeModel === "gpt-4o-mini" ? " selected" : ""
          }>gpt-4o-mini (OpenAI)</option>
          <option value="gpt-4o"${
            state.analyzeModel === "gpt-4o" ? " selected" : ""
          }>gpt-4o (OpenAI)</option>
        </select>
      </div>
      <div id="s-gemini-row" style="${
        state.analyzeModel.startsWith("gemini") ? "" : "display:none"
      }">
        <div class="input-group">
          <label>Gemini API Key</label>
          <input id="s-geminikey" type="password" value="${
            state.geminiApiKey
          }" placeholder="AIza…" style="flex:1;font-family:monospace;font-size:10px"/>
        </div>
      </div>
      <div id="s-openai-row" style="${
        !state.analyzeModel.startsWith("gemini") &&
        state.analyzeModel !== "local-ocr"
          ? ""
          : "display:none"
      }">
        <div class="input-group">
          <label>OpenAI API Key</label>
          <input id="s-apikey" type="password" value="${
            state.analyzeApiKey
          }" placeholder="sk-…" style="flex:1;font-family:monospace;font-size:10px"/>
        </div>
      </div>
      ${
        state.analyzeModel === "local-ocr"
          ? `<div class="ev-note" style="color:var(--warn);margin-top:4px;font-size:10px">⚠ Local OCR: extracts stacks/blinds/tournament info. Card rank via OCR, suit via color. Position must be set manually.</div>`
          : ""
      }
      <div style="margin-top:14px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">Import</div>
      <button class="btn-load" id="s-importJson" style="margin-top:6px">Import JSON Range</button>
      <button class="btn-load" id="s-importImg" style="margin-top:6px;background:var(--surface2)">Import Reference Image</button>
      ${
        state.refImage
          ? `<button class="btn-load" id="s-viewImg" style="margin-top:6px;background:#333">View Reference Image</button>`
          : ""
      }
      ${
        state.importedRange
          ? `<div class="ev-note" style="color:var(--ev-pos);margin-top:8px">&#10003; Custom range loaded</div>`
          : ""
      }
    </div>`;
  document.getElementById("s-rfiSize").addEventListener("input", (e) => {
    state.rfiSizeBB = Number(e.target.value);
  });
  document.getElementById("s-3betSize").addEventListener("input", (e) => {
    state.threeBetSizeBB = Number(e.target.value);
  });
  document.getElementById("s-stage").addEventListener("change", (e) => {
    state.tournament.stage = e.target.value;
  });
  document.getElementById("s-buyin").addEventListener("input", (e) => {
    state.tournament.buyin = Number(e.target.value);
  });
  document.getElementById("s-bounty").addEventListener("input", (e) => {
    state.tournament.bounty = Number(e.target.value);
  });
  document.getElementById("s-heroBounty").addEventListener("input", (e) => {
    state.tournament.heroBounty = Number(e.target.value);
  });
  document.getElementById("s-model").addEventListener("change", (e) => {
    state.analyzeModel = e.target.value;
    localStorage.setItem("analyze_model", state.analyzeModel);
    const isGemini = state.analyzeModel.startsWith("gemini");
    const isLocal = state.analyzeModel === "local-ocr";
    const gr = document.getElementById("s-gemini-row");
    const or = document.getElementById("s-openai-row");
    if (gr) gr.style.display = isGemini ? "" : "none";
    if (or) or.style.display = !isGemini && !isLocal ? "" : "none";
    renderSettingsPanel();
  });
  document.getElementById("s-geminikey").addEventListener("input", (e) => {
    state.geminiApiKey = e.target.value.trim();
    localStorage.setItem("gemini_api_key", state.geminiApiKey);
  });
  const apikeyEl = document.getElementById("s-apikey");
  if (apikeyEl)
    apikeyEl.addEventListener("input", (e) => {
      state.analyzeApiKey = e.target.value.trim();
      localStorage.setItem("openai_api_key", state.analyzeApiKey);
    });
  document
    .getElementById("s-importJson")
    .addEventListener("click", () =>
      document.getElementById("fileJsonInput").click()
    );
  document
    .getElementById("s-importImg")
    .addEventListener("click", () =>
      document.getElementById("fileImgInput").click()
    );
  const viewBtn = document.getElementById("s-viewImg");
  if (viewBtn) viewBtn.addEventListener("click", showRefImage);
}

// ─── Multiway action sequence strip ──────────────────────────────────────────

/**
 * Compute bet level (0=no bet, 1=open, 2=3bet, 3=4bet) as of position's turn.
 * Looks at actions assigned to positions BEFORE pos in preflop order.
 */
function getStripBetLevel(upToPos) {
  let level = 0;
  for (const pos of state.positions) {
    if (pos === upToPos) break;
    const act = state.multiway.actions[pos];
    if (act === "raise" || act === "limp")
      level = Math.max(level, act === "raise" ? 1 : 0);
    if (act === "allin") level = Math.max(level, 1);
    if (act === "3bet") level = Math.max(level, 2);
    if (act === "4bet") level = Math.max(level, 3);
  }
  return level;
}

/** Returns available action list for a position given prior sequence state. */
function getStripActions(pos) {
  const level = getStripBetLevel(pos);
  const stack = state.stackBB;
  const rfi = state.rfiSizeBB || 2.5;
  const tbet = state.threeBetSizeBB || 7.5;
  const fbet = Math.round(tbet * 2.5 * 2) / 2;

  if (level === 0) {
    return [
      { key: "fold", label: "Fold" },
      { key: "limp", label: "Limp" },
      { key: "raise", label: `Raise ${rfi}` },
      { key: "allin", label: `All-in ${stack}` },
    ];
  }
  if (level === 1) {
    return [
      { key: "fold", label: "Fold" },
      { key: "call", label: "Call" },
      { key: "3bet", label: `3bet ${tbet}` },
      { key: "allin", label: `All-in ${stack}` },
    ];
  }
  if (level === 2) {
    return [
      { key: "fold", label: "Fold" },
      { key: "call", label: "Call" },
      { key: "4bet", label: `4bet ${fbet}` },
      { key: "allin", label: `All-in ${stack}` },
    ];
  }
  // level >= 3
  return [
    { key: "fold", label: "Fold" },
    { key: "call", label: "Call" },
    { key: "allin", label: `All-in ${stack}` },
  ];
}

/**
 * Build action_sequence array for the API, with state.position as hero.
 * Only includes positions with explicitly set actions that come before hero
 * in preflop order.
 */
function buildActionSequenceForAPI() {
  const seq = [];
  let found = false;
  for (const pos of state.positions) {
    if (pos === state.position) {
      seq.push({ pos, action: "hero" });
      found = true;
      break;
    }
    const act = state.multiway.actions[pos];
    if (act) seq.push({ pos, action: act });
  }
  if (!found) seq.push({ pos: state.position, action: "hero" });
  return seq;
}

/**
 * Build action_sequence for any targetPos as hero (used for position comparison).
 * Includes all set actions up to targetPos in preflop order.
 */
function buildSeqForPosition(targetPos) {
  const seq = [];
  let found = false;
  for (const pos of state.positions) {
    if (pos === targetPos) {
      seq.push({ pos, action: "hero" });
      found = true;
      break;
    }
    const act = state.multiway.actions[pos];
    if (act) seq.push({ pos, action: act });
  }
  if (!found) seq.push({ pos: targetPos, action: "hero" });
  return seq;
}

/** Render the action-sequence strip */
function renderActionSeqStrip() {
  const bar = document.getElementById("actionSeqBar");
  if (!bar) return;

  // Auto-detect current position: first position with no assigned action
  const currentPos =
    state.positions.find((p) => !state.multiway.actions[p]) ??
    state.positions[state.positions.length - 1];

  // Sync state.position so API calls use the correct position
  if (state.position !== currentPos) {
    state.position = currentPos;
    document
      .querySelectorAll(".pos-tab")
      .forEach((t) =>
        t.classList.toggle("active", t.dataset.pos === currentPos)
      );
  }

  const currentIdx = state.positions.indexOf(currentPos);

  const cards = state.positions
    .map((pos, i) => {
      const isCurrent = pos === currentPos;
      const selectedAct = state.multiway.actions[pos];
      const actions = getStripActions(pos);
      const actionBtns = actions
        .map((a) => {
          const isSel = selectedAct === a.key;
          const cls = `aseq-btn${isSel ? " selected" : ""} ${a.key}`;
          return `<button class="${cls}" data-pos="${pos}" data-act="${a.key}">${a.label}</button>`;
        })
        .join("");

      let cardCls = "aseq-card";
      if (isCurrent) cardCls += " current";
      else if (i > currentIdx) cardCls += " future";
      if (selectedAct === "fold") cardCls += " folded";
      else if (selectedAct) cardCls += " acted";

      return `
      <div class="${cardCls}" data-pos="${pos}">
        <div class="aseq-pos-name">${pos}</div>
        <div class="aseq-stack">${state.stackBB}bb</div>
        <div class="aseq-actions">${actionBtns}</div>
      </div>`;
    })
    .join("");

  // Sequence summary label
  const seqParts = state.positions
    .filter((p) => state.multiway.actions[p])
    .map((p) => {
      const a = state.multiway.actions[p];
      const color =
        a === "fold" ? "#4a5580" : a === "call" ? "#3c8fe8" : "#e83c3c";
      return `<span style="color:${color}">${p} <b>${a}</b></span>`;
    });
  const seqLabel = seqParts.length
    ? `${seqParts.join(
        " → "
      )} → <span style="color:#00e8b0">${currentPos} ?</span>`
    : `<span style="color:var(--muted)">Set actions to define the sequence</span>`;

  bar.innerHTML = `
    <div class="aseq-header">
      <div class="aseq-seq-label">${seqLabel}</div>
      <button class="aseq-clear" id="clearSeqBtn">&#10005; Clear</button>
    </div>
    <div class="aseq-scroll">${cards}</div>`;

  // Wire action-button clicks
  bar.querySelectorAll(".aseq-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const { pos, act } = e.currentTarget.dataset;
      if (state.multiway.actions[pos] === act) {
        delete state.multiway.actions[pos]; // toggle off
      } else {
        state.multiway.actions[pos] = act;
      }
      // Hero auto-advances — invalidate all caches
      state.positionCache = {};
      state.rangeCache = {};
      renderActionSeqStrip();
      loadFullRange();
    });
  });

  bar.querySelector("#clearSeqBtn")?.addEventListener("click", () => {
    state.multiway.actions = {};
    state.positionCache = {};
    state.rangeCache = {};
    renderActionSeqStrip();
    loadFullRange();
  });
}

// ─── ICM calculation
async function calculateICM() {
  const btn = document.getElementById("calcIcmBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Calculating...";
  }
  try {
    const { stacks, prizes, heroIdx, playersRemaining } = state.icm;
    const [eqRes, pjRes] = await Promise.all([
      fetch(`${API}/icm/equity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stacks, prizes }),
      }).then((r) => r.json()),
      fetch(`${API}/icm/payjump`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stacks,
          prizes,
          hero_idx: heroIdx,
          players_remaining: playersRemaining,
        }),
      }).then((r) => r.json()),
    ]);
    state.icm.result = eqRes;
    state.icm.payjumpInfo = pjRes;
    state.icm.enabled = true;
    const hero = eqRes.players?.[heroIdx];
    if (hero) {
      document.getElementById("icmStatusSep").style.display = "";
      document.getElementById("icmStatusText").style.display = "";
      document.getElementById(
        "icmStatusText"
      ).textContent = `ICM: ${hero.equityPct.toFixed(
        1
      )}% equity · pressure ${Math.round(hero.pressure * 100)}%`;
    }
    renderICMPanel();
  } catch (err) {
    alert("ICM calculation failed: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Calculate ICM";
    }
  }
}

// ─── Cell interaction
function onCellClick(hand, cell) {
  document
    .querySelectorAll(".range-cell.selected")
    .forEach((c) => c.classList.remove("selected"));
  cell.classList.add("selected");
  state.selectedHand = hand;
  const key = rangeKey();
  const rangeData = state.importedRange || state.rangeCache[key];
  const d = rangeData ? rangeData[hand] : null;
  const activeTab =
    document.querySelector(".panel-tab.active")?.dataset.tab ?? "overview";
  if (d) {
    if (activeTab === "ev") renderEVPanel(hand, d);
    else renderHandOverview(hand, d);
  } else {
    fetchSingleHand(hand);
  }
}

// ─── Position comparison

// Positions that can meaningfully open (not BB for RFI)
function openPositions() {
  if (state.scenario === "rfi")
    return state.positions.filter((p) => p !== "BB");
  return state.positions;
}

async function fetchAllPositions(hand) {
  const seqStr = Object.entries(state.multiway.actions)
    .sort()
    .map(([p, a]) => `${p}:${a}`)
    .join(",");
  const cacheKey = `pos:${hand}:${state.stackBB}:${state.tournament.stage}:${seqStr}`;
  if (state.positionCache[cacheKey]) return state.positionCache[cacheKey];

  const positions = state.positions;

  const results = await Promise.allSettled(
    positions.map((pos) => {
      const body = {
        hand,
        action_sequence: buildSeqForPosition(pos),
        table_size: state.tableSize,
        stack_bb: state.stackBB,
        stage: state.tournament.stage,
        bounty: state.tournament.bounty,
        hero_bounty: state.tournament.heroBounty,
        buyin: state.tournament.buyin,
      };
      return fetch(`${API}/preflop/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((raw) => ({ pos, ...mapActionResponse(raw) }))
        .catch(() => ({ pos, error: true }));
    })
  );

  const map = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && !r.value.error) map[positions[i]] = r.value;
  });
  state.positionCache[cacheKey] = map;
  return map;
}

const ACTION_HEX = {
  raise: "#e83c3c",
  "3bet": "#e83c3c",
  "4bet": "#c0392b",
  call: "#3c8fe8",
  fold: "#4a5580",
};

function renderPositionComparison(hand, posResults) {
  const section = document.getElementById("pos-cmp-section");
  if (!section) return;

  const visiblePositions = openPositions().filter((p) => posResults[p]);
  if (visiblePositions.length === 0) {
    section.innerHTML = "";
    return;
  }

  const rows = visiblePositions
    .map((p) => {
      const d = posResults[p];
      const freq = Math.round((d.freq ?? 1) * 100);
      const color = ACTION_HEX[d.action] || "#888";
      const isCur = p === state.position;
      return `
      <div class="pos-cmp-row${isCur ? " current" : ""}">
        <div class="pos-cmp-pos">${p}</div>
        <div class="pos-cmp-action" style="color:${color}">${d.action.toUpperCase()}</div>
        <div class="pos-cmp-bar-wrap">
          <div class="pos-cmp-bar" style="width:${freq}%;background:${color}"></div>
        </div>
        <div class="pos-cmp-freq">${freq}%</div>
      </div>`;
    })
    .join("");

  section.innerHTML = `
    <div class="ev-title" style="margin-bottom:8px">
      All Positions &mdash; ${hand}
      <span style="margin-left:4px;font-size:9px;color:var(--muted)">${state.scenario.toUpperCase()} ${
    state.stackBB
  }bb</span>
    </div>
    <div class="pos-cmp-list">${rows}</div>`;
}

// Map FE scenario to BE spot_type
const SCENARIO_TO_SPOT_TYPE = {
  rfi: "open",
  vs_rfi: "vs_open",
  vs_3bet: "vs_3bet",
  vs_4bet: "vs_4bet",
};

// Map /action response to the FE display format
function mapActionResponse(raw) {
  const strat = raw.adjusted_strategy || raw.strategy || {};
  const action =
    raw.best_action || Object.keys(strat).find((a) => a !== "fold") || "fold";
  const freq = strat[action] ?? 1;
  // Derive per-action EV hints from factors (directional only)
  let ev = null;
  if (raw.factors) {
    const f = raw.factors;
    const aggrBonus =
      (f.bounty_ev || 0) / Math.max(1, state.tournament.buyin || 10);
    const aggrKey = Object.keys(strat).find(
      (a) => a === "raise" || a === "3bet" || a === "4bet"
    );
    const callKey = Object.keys(strat).find((a) => a === "call");
    if (aggrKey || callKey) {
      ev = {};
      if (aggrKey)
        ev.raise =
          Math.round(
            ((strat[aggrKey] ?? 0) * (f.aggr_mult ?? 1) * 2 - 0.5 + aggrBonus) *
              100
          ) / 100;
      if (callKey)
        ev.call =
          Math.round(
            ((strat[callKey] ?? 0) * 1.5 - 0.4 + aggrBonus * 0.5) * 100
          ) / 100;
    }
  }
  return {
    action,
    freq,
    sizeBB:
      action === "fold"
        ? 0
        : state.scenario === "rfi"
        ? state.rfiSizeBB
        : state.threeBetSizeBB,
    pushFoldMode: state.stackBB <= 15,
    cached: false,
    fallback: raw.fallback ?? false,
    spot: raw.spot,
    strategy: raw.strategy,
    adjusted_strategy: raw.adjusted_strategy,
    factors: raw.factors,
    ev,
  };
}

async function fetchSingleHand(hand) {
  try {
    const body = {
      hand,
      action_sequence: buildActionSequenceForAPI(),
      table_size: state.tableSize,
      stack_bb: state.stackBB,
      players_left: state.icm.playersRemaining,
      total_players: state.icm.totalPlayers,
      stage: state.tournament.stage,
      bounty: state.tournament.bounty,
      hero_bounty: state.tournament.heroBounty,
      buyin: state.tournament.buyin,
    };
    const r = await fetch(`${API}/preflop/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await r.json();
    if (raw.error) throw new Error(raw.error);
    const d = mapActionResponse(raw);
    state.queryCount++;
    document.getElementById("queryCount").textContent = state.queryCount;
    const activeTab =
      document.querySelector(".panel-tab.active")?.dataset.tab ?? "overview";
    if (activeTab === "ev") renderEVPanel(hand, d);
    else renderHandOverview(hand, d);
    const cell = document.getElementById(`cell-${hand}`);
    if (cell) {
      cell.dataset.action = actionTag(d.action, d.freq);
      cell.style.background = cellBg(d);
      cell.style.color = d.action === "fold" ? "#5a6488" : "#fff";
      cell.classList.remove("loading");
    }
    renderActionSeqStrip();
    logSession(body, d);
  } catch (err) {
    document.getElementById(
      "panelBody"
    ).innerHTML = `<div class="empty-panel"><div style="color:#ff6b6b">${err.message}</div></div>`;
  }
}

async function loadFullRange() {
  const key = rangeKey();
  const btn = document.getElementById("loadRangeBtn");
  const cached = state.importedRange || state.rangeCache[key];
  if (cached) {
    applyRangeToGrid(cached);
    renderRangeSummary(cached);
    updateRangeTitle();
    renderActionSeqStrip();
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading...";
  }
  showLoadingGrid();
  try {
    const seq = buildActionSequenceForAPI();
    const body = {
      action_sequence: seq,
      table_size: state.tableSize,
      stack_bb: state.stackBB,
      stage: state.tournament.stage,
      bounty: state.tournament.bounty,
      hero_bounty: state.tournament.heroBounty,
      buyin: state.tournament.buyin,
      players_left: state.icm.playersRemaining,
      total_players: state.icm.totalPlayers,
    };
    const r = await fetch(`${API}/preflop/range-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const range = data.range;
    state.rangeCache[key] = range;
    applyRangeToGrid(range);
    renderRangeSummary(range);
    updateRangeTitle();
    renderActionSeqStrip();
  } catch (err) {
    alert("Failed to load range: " + err.message);
    buildEmptyGrid();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Load Range";
    }
  }
}

// ─── Import JSON
function handleJsonImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      let range = data.range || data;
      if (typeof range !== "object" || Array.isArray(range))
        throw new Error("Invalid format");
      const sampleKeys = Object.keys(range).slice(0, 3);
      for (const k of sampleKeys) {
        if (!range[k].action) throw new Error(`Missing 'action' for hand ${k}`);
      }
      state.importedRange = range;
      if (data.position) state.position = data.position;
      if (data.stack_bb) state.stackBB = Number(data.stack_bb);
      if (data.table_size) {
        state.tableSize = Number(data.table_size);
        updatePositions(state.tableSize);
      }
      applyRangeToGrid(range);
      renderRangeSummary(range);
      updateRangeTitle();
      alert("Range imported: " + Object.keys(range).length + " combos loaded.");
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  };
  reader.readAsText(file);
}

// ─── Import Image
function handleImgImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    state.refImage = e.target.result;
    showRefImage();
  };
  reader.readAsDataURL(file);
}

function showRefImage() {
  if (!state.refImage) return;
  document.getElementById("refImg").src = state.refImage;
  document.getElementById("imgOverlay").style.display = "flex";
}

// ─── Utilities
function updateRangeTitle() {
  const t = document.getElementById("rangeTitle");
  const vsStr = state.scenario !== "rfi" ? ` vs ${state.vsPosition}` : "";
  const importedStr = state.importedRange ? " [imported]" : "";
  t.textContent = `${
    state.position
  }${vsStr} — ${state.scenario.toUpperCase()} — ${state.stackBB}bb${
    state.anteBB > 0 ? ` · ${state.anteBB}bb ante` : ""
  }${importedStr}`;
}

function updateTopbarVisibility() {
  const s = state.scenario;
  document.getElementById("vsPositionField").style.display =
    s !== "rfi" ? "" : "none";
}

async function updatePositions(tableSize) {
  try {
    const r = await fetch(`${API}/preflop/positions?table_size=${tableSize}`);
    const data = await r.json();
    state.positions = data.positions;
    if (!state.positions.includes(state.position)) {
      state.position =
        state.positions.find((p) => p === "BTN") ||
        state.positions[state.positions.length - 3];
    }
    buildPosTabs();
    document.getElementById("tableLabel").textContent = `${tableSize}-max`;
    document.getElementById("posTabs").addEventListener("click", onPosTabClick);
    state.multiway.actions = {}; // reset when table layout changes
    renderActionSeqStrip();
    return data.positions;
  } catch {
    const fallback = {
      5: ["EP", "CO", "BTN", "SB", "BB"],
      6: ["EP", "MP", "CO", "BTN", "SB", "BB"],
      7: ["UTG", "MP", "HJ", "CO", "BTN", "SB", "BB"],
      8: ["UTG", "UTG1", "MP", "HJ", "CO", "BTN", "SB", "BB"],
      9: ["UTG", "UTG1", "UTG2", "HJ", "CO", "BTN", "SB", "BB"],
    };
    state.positions = fallback[tableSize] || fallback[6];
    buildPosTabs();
    document.getElementById("posTabs").addEventListener("click", onPosTabClick);
    state.multiway.actions = {};
    renderActionSeqStrip();
    return state.positions;
  }
}

function onPosTabClick(e) {
  const tab = e.target.closest(".pos-tab");
  if (!tab) return;
  state.position = tab.dataset.pos;
  document
    .querySelectorAll(".pos-tab")
    .forEach((t) => t.classList.toggle("active", t === tab));
  updateRangeTitle();
  const key = rangeKey();
  const cached = state.rangeCache[key];
  if (cached) {
    applyRangeToGrid(cached);
    renderRangeSummary(cached);
  } else {
    buildEmptyGrid();
    renderOverviewEmpty();
  }
}

async function checkServer() {
  const el = document.getElementById("serverStatus");
  try {
    const r = await fetch(`${API.replace("/api", "")}/health`);
    const d = await r.json();
    if (d.status === "ok") {
      el.textContent = "● Server OK";
      el.className = "server-pill ok";
      return true;
    }
  } catch {}
  el.textContent = "● Offline";
  el.className = "server-pill err";
  return false;
}

async function startSession() {
  try {
    const r = await fetch(`${API}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stack_bb: state.stackBB,
        position: state.position,
        metadata: { scenario: state.scenario, tableSize: state.tableSize },
      }),
    });
    const d = await r.json();
    state.sessionId = d.session_id;
    document.getElementById("sessionId").textContent =
      d.session_id.slice(0, 8) + "...";
  } catch {}
}

function logSession(body, result) {
  if (!state.sessionId) return;
  fetch(`${API}/session/${state.sessionId}/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action_history: body,
      result,
      vs_position: state.vsPosition,
    }),
  }).catch(() => {});
}

// ─── Screenshot Analysis

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function analyzeScreenshot(file) {
  const isLocal = state.analyzeModel === "local-ocr";
  const isGemini = state.analyzeModel.startsWith("gemini");
  const activeKey = isGemini ? state.geminiApiKey : state.analyzeApiKey;
  if (!isLocal && !activeKey) {
    document
      .querySelectorAll(".panel-tab")
      .forEach((t) =>
        t.classList.toggle("active", t.dataset.tab === "settings")
      );
    renderSettingsPanel();
    const focusId = isGemini ? "s-geminikey" : "s-apikey";
    document.getElementById(focusId)?.focus();
    const providerName = isGemini ? "Gemini" : "OpenAI";
    alert(
      `Please enter your ${providerName} API key in the Settings panel first.`
    );
    return;
  }

  // Show analyzing state in panel
  document
    .querySelectorAll(".panel-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === "overview"));
  document.getElementById("panelBody").innerHTML = `
    <div class="analyze-loading">
      <div class="analyze-spinner"></div>
      <div class="analyze-status">Analyzing screenshot&hellip;</div>
      <div class="analyze-substatus">Extracting table state with AI</div>
    </div>`;

  const analyzeBtn = document.getElementById("analyzeBtn");
  if (analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "⏳";
  }

  try {
    const base64 = await fileToBase64(file);

    const resp = await fetch(`${API}/analyze/table`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: base64,
        model: state.analyzeModel,
        api_key: state.analyzeApiKey || undefined,
        gemini_api_key: state.geminiApiKey || undefined,
      }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    state.lastAnalysis = data;

    // Auto-apply extracted state
    const ex = data.extracted;
    if (ex._hero_pos && state.positions.includes(ex._hero_pos)) {
      state.position = ex._hero_pos;
      document
        .querySelectorAll(".pos-tab")
        .forEach((t) =>
          t.classList.toggle("active", t.dataset.pos === state.position)
        );
    }
    if (ex.hero_stack_bb) {
      state.stackBB = Number(ex.hero_stack_bb);
      const si = document.getElementById("stackInput");
      if (si) si.value = state.stackBB;
      document.querySelectorAll(".pos-tab .pos-stack").forEach((el) => {
        el.textContent = `${state.stackBB}bb`;
      });
    }
    if (ex.players_remaining)
      state.icm.playersRemaining = Number(ex.players_remaining);
    if (ex.total_players) state.icm.totalPlayers = Number(ex.total_players);
    if (ex._stage) state.tournament.stage = ex._stage;
    if (ex.bounties && ex._villain_pos && ex.bounties[ex._villain_pos]) {
      state.tournament.bounty = Number(ex.bounties[ex._villain_pos]);
    }
    if (ex.bounties && ex._hero_pos && ex.bounties[ex._hero_pos]) {
      state.tournament.heroBounty = Number(ex.bounties[ex._hero_pos]);
    }
    state.positionCache = {}; // invalidate

    // Sync scenario tab from extracted spot type
    const SPOT_TO_SCENARIO = {
      open: "rfi",
      vs_open: "vs_rfi",
      vs_3bet: "vs_3bet",
      vs_4bet: "vs_4bet",
    };
    if (ex._spot_type && SPOT_TO_SCENARIO[ex._spot_type]) {
      state.scenario = SPOT_TO_SCENARIO[ex._spot_type];
      document
        .querySelectorAll("#scenarioTabs button")
        .forEach((b) =>
          b.classList.toggle("active", b.dataset.val === state.scenario)
        );
      updateTopbarVisibility();
    }

    // Sync villain position
    if (ex._villain_pos && state.positions.includes(ex._villain_pos)) {
      state.vsPosition = ex._villain_pos;
      const sel = document.getElementById("vsPositionSelect");
      if (sel) sel.value = state.vsPosition;
    }

    // Update position tab stack labels
    document.querySelectorAll(".pos-tab .pos-stack").forEach((el) => {
      el.textContent = `${state.stackBB}bb`;
    });

    // Select the extracted hand in the grid
    if (ex._normalized_hand) {
      state.selectedHand = ex._normalized_hand;
      document
        .querySelectorAll(".range-cell.selected")
        .forEach((c) => c.classList.remove("selected"));
      const cell = document.getElementById(`cell-${ex._normalized_hand}`);
      if (cell) {
        cell.classList.add("selected");
        if (data.action?.best_action) {
          cell.dataset.action = actionTag(
            data.action.best_action,
            (data.action.adjusted_strategy || {})[data.action.best_action]
          );
        }
        cell.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    updateRangeTitle();
    renderAnalysisPanel(data, base64);

    // Store reference image
    state.refImage = base64;
  } catch (err) {
    document.getElementById("panelBody").innerHTML = `
      <div class="empty-panel">
        <div style="color:#ff6b6b;margin-bottom:8px">&#9888; Analysis failed</div>
        <div style="font-size:11px;color:var(--muted)">${err.message}</div>
      </div>`;
  } finally {
    if (analyzeBtn) {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "🤖 Analyze";
    }
  }
}

const ACTION_COLOR = {
  raise: "#e83c3c",
  "3bet": "#e83c3c",
  "4bet": "#c0392b",
  call: "#3c8fe8",
  fold: "#4a5580",
  shove: "#c0392b",
};
const ACTION_BG = {
  raise: "rgba(232,60,60,0.12)",
  "3bet": "rgba(232,60,60,0.12)",
  "4bet": "rgba(192,57,43,0.12)",
  call: "rgba(60,143,232,0.12)",
  fold: "rgba(74,85,128,0.12)",
  shove: "rgba(192,57,43,0.12)",
};

function renderAnalysisPanel(data, base64Img) {
  const ex = data.extracted;
  const act = data.action;
  const hand = ex._normalized_hand || ex.hero_hand || "?";

  const villainStacks = ex.villain_stacks || {};
  const vpip = ex.vpip || {};
  const bounties = ex.bounties || {};

  const stackRows = Object.entries(villainStacks)
    .map(([pos, bb]) => {
      const v =
        vpip[pos] != null
          ? `<span class="az-vpip">VPIP ${vpip[pos]}</span>`
          : "";
      const b =
        bounties[pos] != null
          ? `<span class="az-bounty">🔥${bounties[pos]}</span>`
          : "";
      return `<div class="az-player-row">
      <span class="az-pos">${pos}</span>
      <span class="az-stack">${bb} BB</span>
      ${v}${b}
    </div>`;
    })
    .join("");

  const heroVpip = vpip[ex._hero_pos] != null ? vpip[ex._hero_pos] : null;
  const heroBounty =
    bounties[ex._hero_pos] != null ? bounties[ex._hero_pos] : null;

  const actionHtml = act
    ? (() => {
        const best = act.best_action || "?";
        const strat = act.adjusted_strategy || act.strategy || {};
        const color = ACTION_COLOR[best] || "#888";
        const bg = ACTION_BG[best] || "rgba(128,128,128,0.1)";
        const stratRows = Object.entries(strat)
          .map(
            ([a, v]) =>
              `<div class="az-strat-row">
        <span style="color:${
          ACTION_COLOR[a] || "#888"
        }">${a.toUpperCase()}</span>
        <div class="pos-cmp-bar-wrap" style="flex:1;margin:0 6px">
          <div class="pos-cmp-bar" style="width:${Math.round(
            v * 100
          )}%;background:${ACTION_COLOR[a] || "#888"}"></div>
        </div>
        <span>${Math.round(v * 100)}%</span>
      </div>`
          )
          .join("");
        const factorsHtml = act.factors
          ? Object.entries(act.factors)
              .map(
                ([k, v]) =>
                  `<span class="az-factor">${k.replace(/_/g, " ")}: ${
                    typeof v === "number" ? v.toFixed(2) : v
                  }</span>`
              )
              .join("")
          : "";
        return `
      <div class="az-action-card" style="background:${bg};border:1px solid ${color}40">
        <div class="az-action-label" style="color:${color}">${best.toUpperCase()}</div>
        <div class="az-action-spot">${act.spot || ""} · ${hand}${
          act.fallback ? " <span class='az-fallback'>heuristic</span>" : ""
        }</div>
        <div class="az-strat-list">${stratRows}</div>
        ${factorsHtml ? `<div class="az-factors">${factorsHtml}</div>` : ""}
      </div>`;
      })()
    : `<div class="az-no-action">Could not determine action — hand not extracted</div>`;

  const tournHtml = [
    ex.tournament_level && `Level ${ex.tournament_level}`,
    ex.blinds && `Blinds ${ex.blinds.sb}/${ex.blinds.bb}`,
    ex.level_time_remaining && `Time ${ex.level_time_remaining}`,
    ex._stage && `Stage: <b>${ex._stage.toUpperCase()}</b>`,
    ex.players_remaining &&
      ex.total_players &&
      `${ex.players_remaining}/${ex.total_players} players`,
    ex.ranking && `Rank ${ex.ranking}`,
    ex.prize_pool && `Prize ${ex.prize_pool}`,
    ex.late_reg && `<span style="color:var(--warn)">Late Reg</span>`,
  ]
    .filter(Boolean)
    .join(" &middot; ");

  document.getElementById("panelBody").innerHTML = `
    <div class="az-panel">
      <div class="az-thumb-row">
        <img src="${base64Img}" class="az-thumb" alt="Screenshot"/>
        <div class="az-hero-info">
          <div class="az-hand">${hand}</div>
          <div class="az-pos-badge">${ex._hero_pos || "?"}</div>
          <div class="az-hero-stack">${ex.hero_stack_bb || "?"}BB</div>
          ${
            heroVpip != null
              ? `<div class="az-vpip">VPIP ${heroVpip}</div>`
              : ""
          }
          ${
            heroBounty != null
              ? `<div class="az-bounty">🔥${heroBounty}</div>`
              : ""
          }
        </div>
      </div>

      ${tournHtml ? `<div class="az-tourn-bar">${tournHtml}</div>` : ""}

      <div class="az-section-title">Optimal Action</div>
      ${actionHtml}

      ${
        stackRows
          ? `
        <div class="az-section-title" style="margin-top:10px">Table — ${
          ex.table_size || "?"
        }‑handed</div>
        <div class="az-players">${stackRows}</div>`
          : ""
      }

      ${
        ex.board && ex.board.length
          ? `
        <div class="az-section-title" style="margin-top:10px">Board (${
          ex.street || "?"
        })</div>
        <div class="az-board">${ex.board
          .map((c) => `<span class="az-card">${c}</span>`)
          .join("")}</div>`
          : ""
      }

      ${ex.pot_bb ? `<div class="az-pot">Pot: ${ex.pot_bb} BB</div>` : ""}

      <button class="btn-mini" id="az-reanalyze" style="margin-top:10px;width:100%">Re-analyze with /action</button>
    </div>`;

  // Re-analyze: fetch all positions for the extracted hand
  document
    .getElementById("az-reanalyze")
    ?.addEventListener("click", async () => {
      if (!ex._normalized_hand) return;
      state.selectedHand = ex._normalized_hand;
      const posResults = await fetchAllPositions(ex._normalized_hand);
      renderPositionComparison(ex._normalized_hand, posResults);
      // Also update grid cell if matching
      const cell = document.getElementById(`cell-${ex._normalized_hand}`);
      if (cell && act) {
        cell.dataset.action = actionTag(
          act.best_action,
          (act.adjusted_strategy || {})[act.best_action]
        );
      }
    });
}

// ─── Event wiring
document.getElementById("scenarioTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.scenario = btn.dataset.val;
  state.positionCache = {};
  document
    .querySelectorAll("#scenarioTabs button")
    .forEach((b) => b.classList.toggle("active", b === btn));
  updateTopbarVisibility();
  updateRangeTitle();
  state.importedRange = null;
  buildEmptyGrid();
  renderOverviewEmpty();
});

document.querySelectorAll(".panel-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".panel-tab")
      .forEach((t) => t.classList.toggle("active", t === tab));
    switch (tab.dataset.tab) {
      case "settings":
        return renderSettingsPanel();
      case "icm":
        return renderICMPanel();
      case "ev": {
        if (state.selectedHand) {
          const d = (state.importedRange || state.rangeCache[rangeKey()])?.[
            state.selectedHand
          ];
          return renderEVPanel(state.selectedHand, d);
        }
        return renderOverviewEmpty();
      }
      default: {
        const rd = state.importedRange || state.rangeCache[rangeKey()];
        if (rd && state.selectedHand)
          return renderHandOverview(state.selectedHand, rd[state.selectedHand]);
        if (rd) return renderRangeSummary(rd);
        return renderOverviewEmpty();
      }
    }
  });
});

document
  .getElementById("loadRangeBtn")
  .addEventListener("click", loadFullRange);

document
  .getElementById("tableSizeSelect")
  .addEventListener("change", async (e) => {
    state.tableSize = Number(e.target.value);
    state.importedRange = null;
    await updatePositions(state.tableSize);
    updateRangeTitle();
    buildEmptyGrid();
    renderOverviewEmpty();
    loadFullRange();
  });

document.getElementById("stackInput").addEventListener("change", (e) => {
  state.stackBB = Number(e.target.value);
  state.positionCache = {};
  document.querySelectorAll(".pos-tab .pos-stack").forEach((el) => {
    el.textContent = `${state.stackBB}bb`;
  });
  updateRangeTitle();
});
document.getElementById("anteInput").addEventListener("change", (e) => {
  state.anteBB = Number(e.target.value);
  updateRangeTitle();
});
document.getElementById("vsPositionSelect").addEventListener("change", (e) => {
  state.vsPosition = e.target.value;
  state.positionCache = {};
  updateRangeTitle();
});

document
  .getElementById("importJsonBtn")
  .addEventListener("click", () =>
    document.getElementById("fileJsonInput").click()
  );
document.getElementById("fileJsonInput").addEventListener("change", (e) => {
  if (e.target.files[0]) handleJsonImport(e.target.files[0]);
  e.target.value = "";
});
document
  .getElementById("importImgBtn")
  .addEventListener("click", () =>
    document.getElementById("fileImgInput").click()
  );
document.getElementById("fileImgInput").addEventListener("change", (e) => {
  if (e.target.files[0]) analyzeScreenshot(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("imgAnalyzeAgainBtn").addEventListener("click", () => {
  document.getElementById("imgOverlay").style.display = "none";
  document.getElementById("fileImgInput").click();
});
document.getElementById("imgClose").addEventListener("click", () => {
  document.getElementById("imgOverlay").style.display = "none";
});
document.getElementById("icmToggleBtn").addEventListener("click", () => {
  document
    .querySelectorAll(".panel-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === "icm"));
  renderICMPanel();
});

// ─── Init
(async () => {
  buildEmptyGrid();
  updateTopbarVisibility();
  await updatePositions(state.tableSize);
  updateRangeTitle();
  await checkServer();
  setInterval(checkServer, 15000);
  await startSession();
  loadFullRange();
})();
