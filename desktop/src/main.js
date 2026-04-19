import "./style.css";

const API = "http://localhost:3001/api";
const RANKS = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];

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
    result: null,
    payjumpInfo: null,
  },
  importedRange: null,
  refImage: null,
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
  <button class="topbar-btn" id="importImgBtn" title="Import reference image">&#8679; Image</button>
  <input type="file" id="fileJsonInput" accept=".json" style="display:none"/>
  <input type="file" id="fileImgInput" accept="image/*" style="display:none"/>
  <button class="topbar-btn" id="icmToggleBtn" title="Toggle ICM panel">ICM</button>
  <div id="serverStatus" class="server-pill loading">Connecting&#8230;</div>
</div>
<div class="pos-tabs" id="posTabs"></div>
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
  return `${state.scenario}|${state.position}|${state.vsPosition}|${state.stackBB}|${state.anteBB}|${state.tableSize}`;
}
function actionTag(action, freq) {
  if (action === "fold") return "fold";
  if (freq != null && freq < 0.92) return action === "raise" ? "mixed" : "mixed-call";
  if (action === "raise") return state.stackBB <= 15 ? "allin" : "raise";
  return "call";
}
function pct(v) { return Math.round((v ?? 1) * 100); }
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
  container.innerHTML = state.positions.map((p) => `
    <button class="pos-tab${p === state.position ? " active" : ""}" data-pos="${p}">
      <div class="pos-name">${p}</div>
      <div class="pos-stack">${state.stackBB}bb</div>
      <div class="pos-range-bar" id="tabBar-${p}"></div>
    </button>
  `).join("");

  const vsSel = document.getElementById("vsPositionSelect");
  vsSel.innerHTML = state.positions
    .filter((p) => p !== "BB")
    .map((p) => `<option${p === state.vsPosition ? " selected" : ""}>${p}</option>`)
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
  if (i < j)   return RANKS[i] + RANKS[j] + "s";
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
        const evStr = d.ev ? ` · EV: ${evLabel(d.ev[d.action])}` : "";
        cell.title = `${hand} → ${d.action.toUpperCase()} ${pct(d.freq)}%${d.sizeBB > 0 ? ` (${d.sizeBB.toFixed(1)}bb)` : ""}${evStr}`;
      } else {
        delete cell.dataset.action;
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
      if (cell) { cell.className = "range-cell loading"; delete cell.dataset.action; }
    }
  }
}

function updateTabBar(pos, rangeData) {
  const bar = document.getElementById(`tabBar-${pos}`);
  if (!bar) return;
  let r = 0, c = 0, f = 0;
  Object.values(rangeData).forEach((d) => {
    if (d.action === "raise") r++;
    else if (d.action === "call") c++;
    else f++;
  });
  const total = r + c + f || 1;
  bar.innerHTML = `
    <div class="pb raise" style="width:${Math.round(r/total*22)}px;min-width:${r>0?2:0}px"></div>
    <div class="pb call"  style="width:${Math.round(c/total*22)}px;min-width:${c>0?2:0}px"></div>
    <div class="pb fold"  style="width:${Math.round(f/total*22)}px;min-width:${f>0?2:0}px"></div>
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
  if (!d) { renderOverviewEmpty(); return; }
  const tag = actionTag(d.action, d.freq);
  const actionLabel = d.pushFoldMode && d.action === "raise" ? "SHOVE" : d.action.toUpperCase();
  const freqPct = pct(d.freq);
  const foldPct = d.action === "fold" ? freqPct : (100 - freqPct);
  const raisePct = d.action === "raise" ? freqPct : 0;
  const callPct  = d.action === "call"  ? freqPct : 0;
  const rc = rawCombos(hand);
  const activeCombos = Math.round(rc * freqPct / 100 * 10) / 10;

  const evHtml = d.ev ? `
    <div class="ev-inline">
      ${d.ev.raise != null ? `<span class="ev-tag ${d.ev.raise >= 0 ? 'pos' : 'neg'}">${d.action === 'raise' ? (d.pushFoldMode ? 'Shove' : 'Raise') : '3bet'} ${evLabel(d.ev.raise)}</span>` : ""}
      ${d.ev.call  != null ? `<span class="ev-tag ${d.ev.call  >= 0 ? 'pos' : 'neg'}">Call ${evLabel(d.ev.call)}</span>`  : ""}
      <span class="ev-tag neutral">Fold +0.00 BB</span>
    </div>` : "";

  document.getElementById("panelBody").innerHTML = `
    <div class="hand-badge">
      <div class="hand-name">${hand}</div>
      <div class="hand-type">${handType(hand)}</div>
      ${d.cached ? '<div class="hand-type" style="color:#38d9a9">&#9889;</div>' : ""}
    </div>
    <div class="advice-card">
      <div class="advice-action ${tag}">${actionLabel}</div>
      ${d.sizeBB > 0 ? `<div class="advice-row">Size <span>${d.sizeBB.toFixed(1)} BB</span></div>` : ""}
      <div class="advice-row">Frequency <span>${freqPct}%</span></div>
      <div class="advice-row">Stack <span>${state.stackBB} BB${state.anteBB > 0 ? ` · ${state.anteBB}bb ante` : ""}</span></div>
      <div class="advice-row">Mode <span>${d.pushFoldMode ? "Push/Fold" : "Standard"}</span></div>
      <div class="advice-row">Table <span>${state.tableSize}-max</span></div>
    </div>
    ${evHtml}
    <div class="freq-stack">
      ${raisePct > 0 ? `<div class="freq-seg raise" style="flex:${raisePct}"></div>` : ""}
      ${callPct  > 0 ? `<div class="freq-seg call"  style="flex:${callPct}"></div>`  : ""}
      ${foldPct  > 0 ? `<div class="freq-seg fold"  style="flex:${foldPct}"></div>`  : ""}
    </div>
    <div class="action-boxes">
      <div class="action-box raise">
        <div class="ab-label">${d.pushFoldMode ? "Shove" : "Raise"}</div>
        <div class="ab-pct">${raisePct}%</div>
        <div class="ab-combos">${raisePct > 0 ? activeCombos : 0} comb</div>
        ${d.ev && d.ev.raise != null ? `<div class="ab-ev ${d.ev.raise >= 0 ? 'pos' : 'neg'}">${evLabel(d.ev.raise)}</div>` : ""}
      </div>
      <div class="action-box call">
        <div class="ab-label">Call</div>
        <div class="ab-pct">${callPct}%</div>
        <div class="ab-combos">${callPct > 0 ? activeCombos : 0} comb</div>
        ${d.ev && d.ev.call != null ? `<div class="ab-ev ${d.ev.call >= 0 ? 'pos' : 'neg'}">${evLabel(d.ev.call)}</div>` : ""}
      </div>
      <div class="action-box fold">
        <div class="ab-label">Fold</div>
        <div class="ab-pct">${foldPct}%</div>
        <div class="ab-combos">${Math.round(rc * foldPct / 100 * 10) / 10} comb</div>
        <div class="ab-ev neutral">+0.00 BB</div>
      </div>
    </div>
  `;
}

function renderEVPanel(hand, d) {
  if (!d || !d.ev) {
    document.getElementById("panelBody").innerHTML = `<div class="empty-panel"><div>No EV data.<br/>Load a range first.</div></div>`;
    return;
  }
  const ev = d.ev;
  const actions = [
    { key: "raise", label: d.pushFoldMode ? "Shove" : "Raise", val: ev.raise },
    { key: "call",  label: "Call",   val: ev.call ?? null },
    { key: "fold",  label: "Fold",   val: 0 },
  ].filter((a) => a.val !== null);

  const bestAction = actions.reduce((best, a) =>
    (a.val ?? -999) > (best.val ?? -999) ? a : best, actions[0]);

  document.getElementById("panelBody").innerHTML = `
    <div class="hand-badge">
      <div class="hand-name">${hand}</div>
      <div class="hand-type">${handType(hand)}</div>
    </div>
    <div class="ev-section">
      <div class="ev-title">Chip EV Estimate (per action)</div>
      ${actions.map((a) => `
        <div class="ev-row${a.key === bestAction.key ? " ev-best" : ""}">
          <div class="ev-action-label ${a.key}">${a.label}</div>
          <div class="ev-bar-wrap">
            <div class="ev-bar">
              <div class="ev-bar-fill ${(a.val ?? 0) >= 0 ? "pos" : "neg"}"
                style="width:${Math.min(100, Math.abs((a.val ?? 0)) / 5 * 100)}%"></div>
            </div>
          </div>
          <div class="ev-value" style="color:${evColor(a.val ?? 0)}">${evLabel(a.val ?? 0)}</div>
          ${a.key === bestAction.key ? '<div class="ev-best-badge">Best</div>' : ""}
        </div>
      `).join("")}
    </div>
    ${state.icm.result ? renderICMEVInline(d) : `<div class="ev-hint">Enable ICM panel for tournament-adjusted EV.</div>`}
    <div class="ev-disclaimer">
      EV values are estimates based on fold equity models.<br/>
      Use as directional guidance, not exact GTO solutions.
    </div>
  `;
}

function renderICMEVInline(d) {
  const icmResult = state.icm.result;
  if (!icmResult) return "";
  const pressure = icmResult.players?.[state.icm.heroIdx]?.pressure ?? 0;
  const pressureLabel = pressure < 0.2 ? "Low" : pressure < 0.5 ? "Medium" : "High";
  const pressureColor = pressure < 0.2 ? "var(--ev-pos)" : pressure < 0.5 ? "var(--warn)" : "var(--danger)";
  return `
    <div class="ev-section" style="margin-top:12px">
      <div class="ev-title">ICM Context</div>
      <div class="ev-row">
        <div class="ev-action-label">ICM Pressure</div>
        <div class="ev-value" style="color:${pressureColor}">${pressureLabel} (${Math.round(pressure * 100)}%)</div>
      </div>
      <div class="ev-row">
        <div class="ev-action-label">Your Equity</div>
        <div class="ev-value">${(icmResult.players?.[state.icm.heroIdx]?.equityPct ?? 0).toFixed(2)}%</div>
      </div>
      <div class="ev-note" style="font-size:11px;color:var(--muted);margin-top:6px">
        High ICM pressure &#8594; avoid marginal gambles even if chip-EV positive.
      </div>
    </div>`;
}

function renderRangeSummary(rangeData) {
  let raise = 0, call = 0, fold = 0;
  Object.entries(rangeData).forEach(([hand, d]) => {
    const raw = rawCombos(hand);
    if (d.action === "raise") raise += raw * (d.freq ?? 1);
    else if (d.action === "call") call += raw * (d.freq ?? 1);
    else fold += raw;
  });
  const total = raise + call + fold || 1;
  const rP = Math.round(raise / total * 100);
  const cP = Math.round(call  / total * 100);
  const fP = 100 - rP - cP;
  document.getElementById("panelBody").innerHTML = `
    <div class="range-stats">
      <div class="range-stats-title">${state.position} ${state.scenario.toUpperCase()} · ${state.tableSize}-max · ${state.stackBB}bb</div>
      <div class="range-stat-row">Raise / Shove <span>${rP}%</span></div>
      <div class="range-stat-row">Call <span>${cP}%</span></div>
      <div class="range-stat-row">Fold <span>${fP}%</span></div>
      <div class="range-stat-row">Total combos <span>${Math.round(total)}</span></div>
    </div>
    <div class="freq-stack" style="height:12px;margin-bottom:18px">
      <div class="freq-seg raise" style="flex:${rP}"></div>
      <div class="freq-seg call"  style="flex:${cP}"></div>
      <div class="freq-seg fold"  style="flex:${fP}"></div>
    </div>
    <div class="action-boxes">
      <div class="action-box raise"><div class="ab-label">Raise</div><div class="ab-pct">${rP}%</div><div class="ab-combos">${Math.round(raise)} comb</div></div>
      <div class="action-box call"><div class="ab-label">Call</div><div class="ab-pct">${cP}%</div><div class="ab-combos">${Math.round(call)} comb</div></div>
      <div class="action-box fold"><div class="ab-label">Fold</div><div class="ab-pct">${fP}%</div><div class="ab-combos">${Math.round(fold)} comb</div></div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:8px">Click any hand for details.</p>
  `;
}

function renderICMPanel() {
  const icmState = state.icm;
  if (icmState.stacks.length === 0) {
    icmState.stacks = Array.from({ length: state.tableSize }, (_, i) =>
      i === icmState.heroIdx ? state.stackBB * 100 : Math.round(state.stackBB * 100 * (0.7 + Math.random() * 0.6))
    );
    icmState.prizes = [500, 300, 200, 100, 50];
    icmState.playersRemaining = 18;
  }
  document.getElementById("panelBody").innerHTML = `
    <div class="icm-panel">
      <div class="icm-section-title">Tournament Setup</div>
      <div class="input-group">
        <label>Players remaining (total)</label>
        <input id="icmPlayersRemaining" type="number" value="${icmState.playersRemaining}" min="2" max="10000" step="1"/>
      </div>
      <div class="input-group">
        <label>Hero seat (0-indexed)</label>
        <input id="icmHeroIdx" type="number" value="${icmState.heroIdx}" min="0" max="${state.tableSize - 1}" step="1"/>
      </div>
      <div class="icm-section-title" style="margin-top:12px">Chip Stacks at Table</div>
      <div id="icmStacksGrid" class="icm-stacks-grid">
        ${icmState.stacks.map((s, i) => `
          <div class="icm-stack-row${i === icmState.heroIdx ? " hero" : ""}">
            <label>${i === icmState.heroIdx ? "You" : "Seat " + (i+1)}</label>
            <input type="number" class="icm-stack-input" data-idx="${i}" value="${s}" min="0" step="100"/>
          </div>`).join("")}
      </div>
      <button class="btn-mini" id="icmAddSeat">+ Add seat</button>
      <div class="icm-section-title" style="margin-top:12px">Prize Structure</div>
      <div id="icmPrizesGrid" class="icm-stacks-grid">
        ${icmState.prizes.map((p, i) => `
          <div class="icm-stack-row">
            <label>${i+1}${["st","nd","rd"][i]||"th"} place</label>
            <input type="number" class="icm-prize-input" data-idx="${i}" value="${p}" min="0" step="10"/>
          </div>`).join("")}
      </div>
      <button class="btn-mini" id="icmAddPrize">+ Add prize tier</button>
      <button class="btn-load" id="calcIcmBtn" style="margin-top:14px">Calculate ICM</button>
      ${icmState.result ? renderICMResult(icmState.result) : ""}
    </div>
  `;
  document.querySelectorAll(".icm-stack-input").forEach((inp) => {
    inp.addEventListener("change", (e) => { icmState.stacks[Number(e.target.dataset.idx)] = Number(e.target.value); });
  });
  document.querySelectorAll(".icm-prize-input").forEach((inp) => {
    inp.addEventListener("change", (e) => { icmState.prizes[Number(e.target.dataset.idx)] = Number(e.target.value); });
  });
  document.getElementById("icmPlayersRemaining").addEventListener("change", (e) => { icmState.playersRemaining = Number(e.target.value); });
  document.getElementById("icmHeroIdx").addEventListener("change", (e) => { icmState.heroIdx = Number(e.target.value); renderICMPanel(); });
  document.getElementById("icmAddSeat").addEventListener("click", () => { icmState.stacks.push(4000); renderICMPanel(); });
  document.getElementById("icmAddPrize").addEventListener("click", () => { icmState.prizes.push(10); renderICMPanel(); });
  document.getElementById("calcIcmBtn").addEventListener("click", calculateICM);
}

function renderICMResult(result) {
  if (!result || !result.players) return "";
  const hero = result.players[state.icm.heroIdx];
  if (!hero) return "";
  const payjump = state.icm.payjumpInfo;
  const pressure = hero.pressure;
  const pressureLabel = pressure < 0.2 ? "Low &#128994;" : pressure < 0.5 ? "Medium &#128993;" : pressure < 0.75 ? "High &#128308;" : "Extreme &#128308;";
  return `
    <div class="icm-result">
      <div class="icm-section-title">ICM Results</div>
      <div class="icm-result-row"><span>Your equity</span><strong>${hero.equityPct.toFixed(2)}%</strong></div>
      <div class="icm-result-row"><span>Chip %</span><strong>${hero.chipPct.toFixed(1)}%</strong></div>
      <div class="icm-result-row"><span>$ Equity</span><strong>$${hero.equity.toFixed(0)}</strong></div>
      <div class="icm-result-row"><span>ICM Pressure</span><strong>${pressureLabel}</strong></div>
      ${payjump ? `
        <div class="icm-result-row"><span>Players to bubble</span><strong>${payjump.bubblesAway}</strong></div>
        <div class="icm-result-row"><span>ITM</span><strong>${payjump.inTheMoney ? "&#10003; Yes" : "&#10007; No"}</strong></div>
        <div class="icm-result-row"><span>Next pay jump</span><strong>+$${payjump.jumpAmount.toFixed(0)}</strong></div>
        <div class="icm-result-row"><span>On bubble</span><strong>${payjump.onBubble ? "&#9888; YES" : "No"}</strong></div>
      ` : ""}
      <div class="icm-advice" style="color:${pressure > 0.5 ? "var(--danger)" : pressure > 0.2 ? "var(--warn)" : "var(--ev-pos)"}">
        ${pressure > 0.65 ? "Extreme ICM pressure — fold equity is gold, avoid marginal all-ins."
          : pressure > 0.4 ? "High ICM pressure — tighten ranges, especially vs aggression."
          : pressure > 0.2 ? "Moderate ICM pressure — slight range adjustment recommended."
          : "Low ICM pressure — play close to chip-EV."}
      </div>
    </div>`;
}

function renderSettingsPanel() {
  document.getElementById("panelBody").innerHTML = `
    <div class="input-panel">
      <div class="input-group">
        <label>Open raise size (BB)</label>
        <input id="s-rfiSize" type="number" value="${state.rfiSizeBB}" min="2" max="6" step="0.5"/>
      </div>
      <div class="input-group">
        <label>3bet size (BB)</label>
        <input id="s-3betSize" type="number" value="${state.threeBetSizeBB}" min="5" max="30" step="0.5"/>
      </div>
      <div style="margin-top:12px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">Import</div>
      <button class="btn-load" id="s-importJson" style="margin-top:6px">Import JSON Range</button>
      <button class="btn-load" id="s-importImg" style="margin-top:6px;background:var(--surface2)">Import Reference Image</button>
      ${state.refImage ? `<button class="btn-load" id="s-viewImg" style="margin-top:6px;background:#333">View Reference Image</button>` : ""}
      ${state.importedRange ? `<div class="ev-note" style="color:var(--ev-pos);margin-top:8px">&#10003; Custom range loaded</div>` : ""}
    </div>`;
  document.getElementById("s-rfiSize").addEventListener("input", (e) => { state.rfiSizeBB = Number(e.target.value); });
  document.getElementById("s-3betSize").addEventListener("input", (e) => { state.threeBetSizeBB = Number(e.target.value); });
  document.getElementById("s-importJson").addEventListener("click", () => document.getElementById("fileJsonInput").click());
  document.getElementById("s-importImg").addEventListener("click", () => document.getElementById("fileImgInput").click());
  const viewBtn = document.getElementById("s-viewImg");
  if (viewBtn) viewBtn.addEventListener("click", showRefImage);
}

// ─── ICM calculation
async function calculateICM() {
  const btn = document.getElementById("calcIcmBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Calculating..."; }
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
        body: JSON.stringify({ stacks, prizes, hero_idx: heroIdx, players_remaining: playersRemaining }),
      }).then((r) => r.json()),
    ]);
    state.icm.result = eqRes;
    state.icm.payjumpInfo = pjRes;
    state.icm.enabled = true;
    const hero = eqRes.players?.[heroIdx];
    if (hero) {
      document.getElementById("icmStatusSep").style.display = "";
      document.getElementById("icmStatusText").style.display = "";
      document.getElementById("icmStatusText").textContent =
        `ICM: ${hero.equityPct.toFixed(1)}% equity · pressure ${Math.round(hero.pressure * 100)}%`;
    }
    renderICMPanel();
  } catch (err) {
    alert("ICM calculation failed: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Calculate ICM"; }
  }
}

// ─── Cell interaction
function onCellClick(hand, cell) {
  document.querySelectorAll(".range-cell.selected").forEach((c) => c.classList.remove("selected"));
  cell.classList.add("selected");
  state.selectedHand = hand;
  const key = rangeKey();
  const rangeData = state.importedRange || state.rangeCache[key];
  const d = rangeData ? rangeData[hand] : null;
  const activeTab = document.querySelector(".panel-tab.active")?.dataset.tab ?? "overview";
  if (d) {
    if (activeTab === "ev") renderEVPanel(hand, d);
    else renderHandOverview(hand, d);
  } else {
    fetchSingleHand(hand);
  }
}

async function fetchSingleHand(hand) {
  try {
    const body = {
      action: state.scenario,
      hand,
      position: state.position,
      vs_position: state.vsPosition,
      stack_bb: state.stackBB,
      ante_bb: state.anteBB,
      rfi_size_bb: state.rfiSizeBB,
      three_bet_size_bb: state.threeBetSizeBB,
      table_size: state.tableSize,
    };
    const r = await fetch(`${API}/preflop/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    state.queryCount++;
    document.getElementById("queryCount").textContent = state.queryCount;
    const activeTab = document.querySelector(".panel-tab.active")?.dataset.tab ?? "overview";
    if (activeTab === "ev") renderEVPanel(hand, d);
    else renderHandOverview(hand, d);
    const cell = document.getElementById(`cell-${hand}`);
    if (cell) { cell.dataset.action = actionTag(d.action, d.freq); cell.classList.remove("loading"); }
    logSession(body, d);
  } catch (err) {
    document.getElementById("panelBody").innerHTML =
      `<div class="empty-panel"><div style="color:#ff6b6b">${err.message}</div></div>`;
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
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
  showLoadingGrid();
  try {
    const params = new URLSearchParams({
      position: state.position,
      action: state.scenario,
      stack_bb: state.stackBB,
      ante_bb: state.anteBB,
      vs_position: state.vsPosition,
      table_size: state.tableSize,
    });
    const r = await fetch(`${API}/preflop/range?${params}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    state.rangeCache[key] = data.range;
    applyRangeToGrid(data.range);
    renderRangeSummary(data.range);
    updateRangeTitle();
  } catch (err) {
    alert("Failed to load range: " + err.message);
    buildEmptyGrid();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Load Range"; }
  }
}

// ─── Import JSON
function handleJsonImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      let range = data.range || data;
      if (typeof range !== "object" || Array.isArray(range)) throw new Error("Invalid format");
      const sampleKeys = Object.keys(range).slice(0, 3);
      for (const k of sampleKeys) {
        if (!range[k].action) throw new Error(`Missing 'action' for hand ${k}`);
      }
      state.importedRange = range;
      if (data.position) state.position = data.position;
      if (data.stack_bb) state.stackBB = Number(data.stack_bb);
      if (data.table_size) { state.tableSize = Number(data.table_size); updatePositions(state.tableSize); }
      applyRangeToGrid(range);
      renderRangeSummary(range);
      updateRangeTitle();
      alert("Range imported: " + Object.keys(range).length + " combos loaded.");
    } catch (err) { alert("Import failed: " + err.message); }
  };
  reader.readAsText(file);
}

// ─── Import Image
function handleImgImport(file) {
  const reader = new FileReader();
  reader.onload = (e) => { state.refImage = e.target.result; showRefImage(); };
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
  t.textContent = `${state.position}${vsStr} — ${state.scenario.toUpperCase()} — ${state.stackBB}bb${state.anteBB > 0 ? ` · ${state.anteBB}bb ante` : ""}${importedStr}`;
}

function updateTopbarVisibility() {
  const s = state.scenario;
  document.getElementById("vsPositionField").style.display = s !== "rfi" ? "" : "none";
}

async function updatePositions(tableSize) {
  try {
    const r = await fetch(`${API}/preflop/positions?table_size=${tableSize}`);
    const data = await r.json();
    state.positions = data.positions;
    if (!state.positions.includes(state.position)) {
      state.position = state.positions.find((p) => p === "BTN") || state.positions[state.positions.length - 3];
    }
    buildPosTabs();
    document.getElementById("tableLabel").textContent = `${tableSize}-max`;
    document.getElementById("posTabs").addEventListener("click", onPosTabClick);
    return data.positions;
  } catch {
    const fallback = { 5: ["EP","CO","BTN","SB","BB"], 6: ["EP","MP","CO","BTN","SB","BB"], 7: ["UTG","MP","HJ","CO","BTN","SB","BB"], 8: ["UTG","UTG1","MP","HJ","CO","BTN","SB","BB"], 9: ["UTG","UTG1","UTG2","HJ","CO","BTN","SB","BB"] };
    state.positions = fallback[tableSize] || fallback[6];
    buildPosTabs();
    document.getElementById("posTabs").addEventListener("click", onPosTabClick);
    return state.positions;
  }
}

function onPosTabClick(e) {
  const tab = e.target.closest(".pos-tab");
  if (!tab) return;
  state.position = tab.dataset.pos;
  document.querySelectorAll(".pos-tab").forEach((t) => t.classList.toggle("active", t === tab));
  updateRangeTitle();
  const key = rangeKey();
  const cached = state.rangeCache[key];
  if (cached) { applyRangeToGrid(cached); renderRangeSummary(cached); }
  else { buildEmptyGrid(); renderOverviewEmpty(); }
}

async function checkServer() {
  const el = document.getElementById("serverStatus");
  try {
    const r = await fetch(`${API.replace("/api", "")}/health`);
    const d = await r.json();
    if (d.status === "ok") { el.textContent = "● Server OK"; el.className = "server-pill ok"; return true; }
  } catch {}
  el.textContent = "● Offline"; el.className = "server-pill err";
  return false;
}

async function startSession() {
  try {
    const r = await fetch(`${API}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack_bb: state.stackBB, position: state.position, metadata: { scenario: state.scenario, tableSize: state.tableSize } }),
    });
    const d = await r.json();
    state.sessionId = d.session_id;
    document.getElementById("sessionId").textContent = d.session_id.slice(0, 8) + "...";
  } catch {}
}

function logSession(body, result) {
  if (!state.sessionId) return;
  fetch(`${API}/session/${state.sessionId}/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action_history: body, result, vs_position: state.vsPosition }),
  }).catch(() => {});
}

// ─── Event wiring
document.getElementById("scenarioTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.scenario = btn.dataset.val;
  document.querySelectorAll("#scenarioTabs button").forEach((b) => b.classList.toggle("active", b === btn));
  updateTopbarVisibility();
  updateRangeTitle();
  state.importedRange = null;
  buildEmptyGrid();
  renderOverviewEmpty();
});

document.querySelectorAll(".panel-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach((t) => t.classList.toggle("active", t === tab));
    switch (tab.dataset.tab) {
      case "settings": return renderSettingsPanel();
      case "icm":      return renderICMPanel();
      case "ev": {
        if (state.selectedHand) {
          const d = (state.importedRange || state.rangeCache[rangeKey()])?.[state.selectedHand];
          return renderEVPanel(state.selectedHand, d);
        }
        return renderOverviewEmpty();
      }
      default: {
        const rd = state.importedRange || state.rangeCache[rangeKey()];
        if (rd && state.selectedHand) return renderHandOverview(state.selectedHand, rd[state.selectedHand]);
        if (rd) return renderRangeSummary(rd);
        return renderOverviewEmpty();
      }
    }
  });
});

document.getElementById("loadRangeBtn").addEventListener("click", loadFullRange);

document.getElementById("tableSizeSelect").addEventListener("change", async (e) => {
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
  document.querySelectorAll(".pos-tab .pos-stack").forEach((el) => { el.textContent = `${state.stackBB}bb`; });
  updateRangeTitle();
});
document.getElementById("anteInput").addEventListener("change", (e) => { state.anteBB = Number(e.target.value); updateRangeTitle(); });
document.getElementById("vsPositionSelect").addEventListener("change", (e) => { state.vsPosition = e.target.value; updateRangeTitle(); });

document.getElementById("importJsonBtn").addEventListener("click", () => document.getElementById("fileJsonInput").click());
document.getElementById("fileJsonInput").addEventListener("change", (e) => {
  if (e.target.files[0]) handleJsonImport(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("importImgBtn").addEventListener("click", () => document.getElementById("fileImgInput").click());
document.getElementById("fileImgInput").addEventListener("change", (e) => {
  if (e.target.files[0]) handleImgImport(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("imgClose").addEventListener("click", () => {
  document.getElementById("imgOverlay").style.display = "none";
});
document.getElementById("icmToggleBtn").addEventListener("click", () => {
  document.querySelectorAll(".panel-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "icm"));
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
