import "./style.css";

const API = "http://localhost:3001/api";
const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

// ─── State ────────────────────────────────────────────────
let state = {
  scenario: "rfi",
  position: "BTN",
  vsPosition: "EP",
  stackBB: 40,
  anteBB: 0.1,
  hand: "AKs",
  rfiSizeBB: 2.5,
  threeBetSizeBB: 7.5,
  result: null,
  sessionId: null,
  queryCount: 0,
  rangeData: null,
};

// ─── Render App ────────────────────────────────────────────
document.getElementById("app").innerHTML = `
<header>
  <h1>♠ GTO Preflop Wizard</h1>
  <div id="serverStatus" class="server-status">Connecting...</div>
</header>

<div class="layout">
  <aside class="sidebar">
    <div class="form-group">
      <label>Scenario</label>
      <div class="scenario-tabs" id="scenarioTabs">
        <button data-val="rfi" class="active">RFI</button>
        <button data-val="vs_rfi">vs RFI</button>
        <button data-val="vs_3bet">vs 3bet</button>
      </div>
    </div>

    <div class="form-group">
      <label>Your Hand</label>
      <div class="hand-input-row">
        <input id="handInput" type="text" value="AKs" maxlength="4" placeholder="AKs, QQ, 72o" />
      </div>
    </div>

    <div class="form-group">
      <label>Your Position</label>
      <select id="positionSelect">
        ${["EP", "MP", "CO", "BTN", "SB", "BB"]
          .map((p) => `<option${p === "BTN" ? " selected" : ""}>${p}</option>`)
          .join("")}
      </select>
    </div>

    <div id="vsPositionGroup" class="form-group" style="display:none">
      <label>Raiser's Position</label>
      <select id="vsPositionSelect">
        ${["EP", "MP", "CO", "BTN", "SB", "BB"]
          .map((p) => `<option>${p}</option>`)
          .join("")}
      </select>
    </div>

    <div class="form-group">
      <label>Effective Stack (BB)</label>
      <input id="stackInput" type="number" value="40" min="1" max="500" step="1" />
    </div>

    <div class="form-group">
      <label>Ante (BB) — 0 if no ante</label>
      <input id="anteInput" type="number" value="0.1" min="0" max="2" step="0.05" />
    </div>

    <div id="rfiSizeGroup" class="form-group" style="display:none">
      <label>Open Size (BB)</label>
      <input id="rfiSizeInput" type="number" value="2.5" min="2" max="6" step="0.5" />
    </div>

    <div id="threeBetSizeGroup" class="form-group" style="display:none">
      <label>3bet Size (BB)</label>
      <input id="threeBetSizeInput" type="number" value="7.5" min="5" max="30" step="0.5" />
    </div>

    <button class="btn btn-primary" id="queryBtn">Get GTO Action</button>
    <button class="btn btn-secondary" id="rangeBtn">Show Full Range</button>
  </aside>

  <main class="main">
    <div class="result-area" id="resultArea">
      <div class="empty-state">
        <div class="icon">♠</div>
        <div>Set your hand &amp; situation, then click <strong>Get GTO Action</strong></div>
      </div>
    </div>

    <div class="range-section" id="rangeSection" style="display:none">
      <h3>Range Chart — <span id="rangeLabel"></span></h3>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:var(--raise)"></div>Raise/Shove</div>
        <div class="legend-item"><div class="legend-dot" style="background:var(--call)"></div>Call</div>
        <div class="legend-item"><div class="legend-dot" style="background:var(--mixed)"></div>Mixed</div>
        <div class="legend-item"><div class="legend-dot" style="background:#2e3150"></div>Fold</div>
      </div>
      <div class="range-grid" id="rangeGrid"></div>
    </div>

    <div class="session-bar">
      Session: <span id="sessionId">—</span> &nbsp;|&nbsp;
      Queries this session: <span id="queryCount">0</span>
    </div>
  </main>
</div>
`;

// ─── Helpers ───────────────────────────────────────────────
async function checkServer() {
  try {
    const r = await fetch(`${API.replace("/api", "")}/health`);
    const data = await r.json();
    if (data.status === "ok") {
      document.getElementById("serverStatus").textContent = "● Server OK";
      document.getElementById("serverStatus").className = "server-status ok";
      return true;
    }
  } catch {}
  document.getElementById("serverStatus").textContent = "● Server Offline";
  document.getElementById("serverStatus").className = "server-status err";
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
        metadata: { scenario: state.scenario },
      }),
    });
    const data = await r.json();
    state.sessionId = data.session_id;
    document.getElementById("sessionId").textContent =
      state.sessionId.slice(0, 8) + "...";
  } catch {}
}

function updateFormVisibility() {
  const s = state.scenario;
  document.getElementById("vsPositionGroup").style.display =
    s !== "rfi" ? "" : "none";
  document.getElementById("rfiSizeGroup").style.display =
    s === "vs_rfi" ? "" : "none";
  document.getElementById("threeBetSizeGroup").style.display =
    s === "vs_3bet" ? "" : "none";
}

function actionColor(action, freq) {
  if (action === "fold") return "fold";
  if (freq < 0.95) return "mixed";
  return action === "raise" ? "raise" : "call";
}

function renderResult(data) {
  const colorClass = actionColor(data.action, data.freq);
  const actionLabel =
    data.pushFoldMode && data.action === "raise"
      ? "SHOVE"
      : data.action.toUpperCase();
  const freqPct = Math.round((data.freq ?? 1) * 100);

  document.getElementById("resultArea").innerHTML = `
    <div class="result-card">
      <div class="result-action ${colorClass}">${actionLabel}</div>
      <div class="result-details">
        <div class="result-detail">Hand: <span>${state.hand}</span></div>
        <div class="result-detail">Position: <span>${state.position}${
    state.scenario !== "rfi" ? " vs " + state.vsPosition : ""
  }</span></div>
        <div class="result-detail">Stack: <span>${state.stackBB}bb</span>${
    state.anteBB > 0 ? ` &nbsp; Ante: <span>${state.anteBB}bb</span>` : ""
  }</div>
        ${
          data.sizeBB > 0
            ? `<div class="result-detail">Size: <span>${data.sizeBB.toFixed(
                1
              )}bb</span></div>`
            : ""
        }
        <div class="result-detail">Mode: <span>${
          data.pushFoldMode ? "Push/Fold" : "Standard"
        }</span></div>
        <div class="freq-bar-wrap">
          <div class="result-detail">Frequency: <span>${freqPct}%</span></div>
          <div class="freq-bar"><div class="freq-bar-fill" style="width:${freqPct}%;background:var(--${colorClass})"></div></div>
        </div>
        ${
          data.cached
            ? '<div class="result-detail" style="color:var(--muted);font-size:11px">⚡ cached</div>'
            : ""
        }
      </div>
    </div>
  `;
}

function renderRangeGrid(rangeData, activeHand) {
  const grid = document.getElementById("rangeGrid");
  grid.innerHTML = "";

  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      let hand;
      if (i === j) hand = RANKS[i] + RANKS[j];
      else if (i < j) hand = RANKS[i] + RANKS[j] + "s";
      else hand = RANKS[j] + RANKS[i] + "o";

      const d = rangeData[hand];
      const cell = document.createElement("div");
      cell.className = "range-cell";
      cell.textContent = hand;
      cell.title =
        hand +
        (d ? ` → ${d.action} (${Math.round((d.freq || 1) * 100)}%)` : "");

      if (d) {
        const ac = actionColor(d.action, d.freq);
        cell.dataset.action = ac;
      }
      if (hand === activeHand) cell.classList.add("active-hand");

      cell.addEventListener("click", () => {
        document.getElementById("handInput").value = hand;
        state.hand = hand;
        document
          .querySelectorAll(".range-cell.active-hand")
          .forEach((c) => c.classList.remove("active-hand"));
        cell.classList.add("active-hand");
        if (d) renderResult({ ...d, cached: true });
      });

      grid.appendChild(cell);
    }
  }
}

// ─── Event Listeners ───────────────────────────────────────
document.getElementById("scenarioTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.scenario = btn.dataset.val;
  document
    .querySelectorAll("#scenarioTabs button")
    .forEach((b) => b.classList.toggle("active", b === btn));
  updateFormVisibility();
  document.getElementById("rangeSection").style.display = "none";
});

document.getElementById("handInput").addEventListener("input", (e) => {
  state.hand = e.target.value.trim();
});
document.getElementById("positionSelect").addEventListener("change", (e) => {
  state.position = e.target.value;
});
document.getElementById("vsPositionSelect").addEventListener("change", (e) => {
  state.vsPosition = e.target.value;
});
document.getElementById("stackInput").addEventListener("input", (e) => {
  state.stackBB = Number(e.target.value);
});
document.getElementById("anteInput").addEventListener("input", (e) => {
  state.anteBB = Number(e.target.value);
});
document.getElementById("rfiSizeInput").addEventListener("input", (e) => {
  state.rfiSizeBB = Number(e.target.value);
});
document.getElementById("threeBetSizeInput").addEventListener("input", (e) => {
  state.threeBetSizeBB = Number(e.target.value);
});

document.getElementById("queryBtn").addEventListener("click", async () => {
  const btn = document.getElementById("queryBtn");
  btn.disabled = true;
  btn.textContent = "Loading...";

  try {
    const body = {
      action: state.scenario,
      hand: state.hand || "AKs",
      position: state.position,
      vs_position: state.vsPosition,
      stack_bb: state.stackBB,
      ante_bb: state.anteBB,
      rfi_size_bb: state.rfiSizeBB,
      three_bet_size_bb: state.threeBetSizeBB,
    };

    const r = await fetch(`${API}/preflop/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    state.result = data;
    state.queryCount++;
    document.getElementById("queryCount").textContent = state.queryCount;
    renderResult(data);

    // Log to session
    if (state.sessionId) {
      fetch(`${API}/session/${state.sessionId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_history: body,
          result: data,
          vs_position: state.vsPosition,
        }),
      }).catch(() => {});
    }
  } catch (err) {
    document.getElementById(
      "resultArea"
    ).innerHTML = `<div class="empty-state"><div style="color:var(--danger)">${err.message}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Get GTO Action";
  }
});

document.getElementById("rangeBtn").addEventListener("click", async () => {
  const btn = document.getElementById("rangeBtn");
  btn.disabled = true;
  btn.textContent = "Loading Range...";

  try {
    const params = new URLSearchParams({
      position: state.position,
      action: state.scenario,
      stack_bb: state.stackBB,
      ante_bb: state.anteBB,
      vs_position: state.vsPosition,
    });
    const r = await fetch(`${API}/preflop/range?${params}`);
    const data = await r.json();
    state.rangeData = data.range;

    document.getElementById("rangeSection").style.display = "";
    document.getElementById("rangeLabel").textContent = `${state.position}${
      state.scenario !== "rfi" ? " vs " + state.vsPosition : ""
    } | ${state.stackBB}bb | ${state.scenario.toUpperCase()}`;
    renderRangeGrid(data.range, state.hand);
  } catch (err) {
    alert("Failed to load range: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Show Full Range";
  }
});

// ─── Init ──────────────────────────────────────────────────
(async () => {
  updateFormVisibility();
  await checkServer();
  setInterval(checkServer, 15000);
  await startSession();
})();
