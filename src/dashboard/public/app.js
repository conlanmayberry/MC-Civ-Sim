/**
 * Dashboard client.
 *
 * Plain modules, no framework, no build step (ADR-004). Everything is polled;
 * there is no websocket because the update rates that matter here are seconds,
 * not milliseconds, and polling survives an agent restarting without any
 * reconnection logic.
 *
 * Three different poll rates, because the costs differ by orders of magnitude:
 *   state     1s   cheap, and the thing you watch
 *   history   4s   a SQLite read
 *   map       6s   a few thousand blockAt calls in the agent process
 */

const POLL_STATE_MS = 1_000;
const POLL_HISTORY_MS = 4_000;
const POLL_MAP_MS = 6_000;

const el = (id) => document.getElementById(id);

const ui = {
  tabs: el('agent-tabs'),
  conn: el('conn'),
  identity: el('identity'),
  stale: el('stale'),
  goal: el('goal'),
  vitals: el('vitals'),
  budget: el('budget'),
  inventory: el('inventory'),
  nearby: el('nearby'),
  talkLog: el('talk-log'),
  talkForm: el('talk-form'),
  talkText: el('talk-text'),
  talkSend: el('talk-send'),
  talkHint: el('talk-hint'),
  decisions: el('decisions'),
  decisionsCount: el('decisions-count'),
  actions: el('actions'),
  health: el('health'),
  map: el('map'),
  mapReadout: el('map-readout'),
  mapRadius: el('map-radius'),
  mapRadiusOut: el('map-radius-out'),
  mapTrail: el('map-trail'),
  mapMarks: el('map-marks'),
  legend: el('legend'),
  toast: el('toast'),
};

const state = {
  agents: [],
  selected: null, // agentId
  port: null,
  live: null, // last /state payload
  map: null,
  trail: [],
  marks: [],
  places: [],
  seenChat: new Set(),
  failures: 0,
};

// ---------------------------------------------------------------- helpers

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

let toastTimer = null;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Minecraft health is a float; 7.333332061767578/20 is not a reading. */
const round1 = (n) => (Math.round(Number(n ?? 0) * 10) / 10).toString();

function bar(value, max, extraClass = '') {
  const pct = clamp01(max > 0 ? value / max : 0) * 100;
  return `<div class="bar ${extraClass}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

// ------------------------------------------------------------------ block colours

/**
 * Map block names to colours.
 *
 * Matched by substring on purpose: Minecraft has dozens of wood and stone
 * variants, and listing every one would be long and still incomplete. Order
 * matters -- the first match wins, so specific patterns come before general.
 */
const BLOCK_COLOURS = [
  [/water|bubble/, '#3a6ea8'],
  [/lava|magma/, '#cf5b1e'],
  [/grass_block|moss/, '#7cae4a'],
  [/short_grass|tall_grass|fern|bush|vine|azalea|sapling/, '#688f3a'],
  // Canopy sits well below ground green: in a spruce forest almost every tile
  // is one or the other, and similar values made the map unreadable.
  [/leaves/, '#2f5327'],
  [/log|wood|stem|hyphae/, '#5d4326'],
  [/planks|crafting_table|barrel|chest|door|fence|stairs|slab/, '#8a6134'],
  [/dirt|podzol|rooted|mud|clay|coarse/, '#7a5a3a'],
  [/sand|sandstone/, '#cbbd82'],
  [/gravel|andesite|diorite|tuff|deepslate/, '#6e6e6e'],
  [/stone|cobble|granite|basalt|blackstone/, '#7d7d7d'],
  [/snow|powder/, '#e6ecf0'],
  [/ice|packed_ice/, '#9fc6dd'],
  [/coal_ore/, '#33332f'],
  [/iron_ore|copper_ore/, '#b98b62'],
  [/gold_ore/, '#d8a531'],
  [/diamond_ore|emerald_ore/, '#4fc3ba'],
  [/redstone_ore|lapis_ore/, '#a03b3b'],
  [/wool|concrete|terracotta/, '#a08a72'],
  [/flower|poppy|dandelion|tulip|orchid|allium|lily/, '#c56a8f'],
  [/farmland|wheat|carrot|potato|beet/, '#9a7b3c'],
  [/bedrock|obsidian/, '#1c1c22'],
];

const colourCache = new Map();
function blockColour(name) {
  if (name === null || name === undefined) return null;
  const cached = colourCache.get(name);
  if (cached !== undefined) return cached;

  let colour = '#585a4e';
  for (const [pattern, value] of BLOCK_COLOURS) {
    if (pattern.test(name)) {
      colour = value;
      break;
    }
  }
  colourCache.set(name, colour);
  return colour;
}

/** Shade by height so terrain reads as terrain rather than a flat colour field. */
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp01(((n >> 16) & 255) / 255 + amount) * 255;
  const g = clamp01(((n >> 8) & 255) / 255 + amount) * 255;
  const b = clamp01((n & 255) / 255 + amount) * 255;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ------------------------------------------------------------------- agents

function renderTabs() {
  const live = new Map(state.agents.map((a) => [a.agentId, a]));

  const rows = [...live.values()].map((a) => ({
    id: a.agentId,
    name: a.username ?? a.agentId,
    live: true,
    port: a.port,
  }));

  for (const known of state.known ?? []) {
    if (!live.has(known.agentId)) {
      rows.push({ id: known.agentId, name: known.username ?? known.agentId, live: false, port: null });
    }
  }

  if (rows.length === 0) {
    ui.tabs.innerHTML = `<span class="muted">no agents — run <code>npm run agent</code></span>`;
    return;
  }

  ui.tabs.innerHTML = rows
    .map(
      (r) => `
      <button class="agent-tab" role="tab" data-id="${esc(r.id)}" data-port="${r.port ?? ''}"
              data-live="${r.live}" aria-selected="${r.id === state.selected}">
        <span class="dot"></span>${esc(r.name)}
      </button>`,
    )
    .join('');

  for (const tab of ui.tabs.querySelectorAll('.agent-tab')) {
    tab.addEventListener('click', () => select(tab.dataset.id, tab.dataset.port || null));
  }
}

function select(agentId, port) {
  if (state.selected === agentId) return;
  state.selected = agentId;
  state.port = port === null || port === '' ? null : Number(port);
  state.trail = [];
  state.marks = [];
  state.places = [];
  state.map = null;
  state.seenChat.clear();
  ui.talkLog.innerHTML = '';
  renderTabs();
  void refreshHistory();
  void refreshMap();
}

// -------------------------------------------------------------- rendering

/**
 * Warn when an agent has been running since before the code changed.
 *
 * A running Node process does not reload edited source. This cost real
 * confusion four separate times: a fix was made, behaviour did not change,
 * and nothing anywhere said the agent was still executing the old code.
 */
function renderStaleness(s) {
  const el = ui.stale;
  if (!el) return;

  if (!s || !s.startedAt || !state.codeChangedAt) {
    el.hidden = true;
    return;
  }

  const started = Date.parse(s.startedAt);
  const changed = Date.parse(state.codeChangedAt);
  if (!Number.isFinite(started) || !Number.isFinite(changed) || changed <= started) {
    el.hidden = true;
    return;
  }

  const mins = Math.round((Date.now() - changed) / 60000);
  const ago = mins < 1 ? 'moments ago' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  el.textContent = `running old code — source changed ${ago}, restart to pick it up`;
  el.hidden = false;
}

function renderIdentity(s) {
  if (!s) {
    ui.identity.innerHTML = `<p class="empty">This agent is not running. History is still shown below.</p>`;
    ui.goal.innerHTML = '';
    ui.vitals.innerHTML = '';
    ui.budget.innerHTML = '';
    return;
  }

  ui.goal.className = s.goal ? 'goal' : 'goal none';
  ui.goal.textContent = s.goal ?? 'nothing set yet';

  const tagRow = (label, items, cls) =>
    items && items.length
      ? `<div class="tag-label">${label}</div><div class="tags">${items
          .map((t) => `<span class="tag ${cls}">${esc(t)}</span>`)
          .join('')}</div>`
      : '';

  // Role and model sit right under the name because they are the two things
  // that differ deliberately between agents -- with one agent on a stronger
  // model as a trial, "which one am I looking at" has to be answerable at a
  // glance or the comparison is guesswork.
  const roleLine = s.role
    ? `<div class="role"><span class="role-job">${esc(String(s.role).split(' -- ')[0])}</span>` +
      `<span class="role-detail">${esc(String(s.role).split(' -- ').slice(1).join(' -- '))}</span></div>`
    : '<div class="role role-none">no assigned role — behaviour left to emerge</div>';

  ui.identity.innerHTML = `
    <div class="name">${esc(s.username)}</div>
    ${roleLine}
    ${s.model ? `<div class="model">${esc(s.model)}</div>` : ''}
    ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
    ${tagRow('Traits', s.traits, 'trait')}
    ${tagRow('Interests', s.interests, 'interest')}
    ${tagRow('Values', s.values, 'value')}
  `;

  const self = s.self;
  if (self) {
    ui.vitals.innerHTML = `
      <div class="vital"><span class="label">Health</span>${bar(self.health, 20, 'health')}<span class="value">${round1(self.health)}/20</span></div>
      <div class="vital"><span class="label">Food</span>${bar(self.food, 20, 'food')}<span class="value">${round1(self.food)}/20</span></div>
      <div class="pos">x ${self.position.x}   y ${self.position.y}   z ${self.position.z}
${self.dimension} · ${self.isDay ? 'day' : 'night'}</div>`;
  } else {
    ui.vitals.innerHTML = `<p class="empty">Not spawned.</p>`;
  }

  const frac = s.budgetUsd > 0 ? s.spentUsd / s.budgetUsd : 0;
  const cls = frac >= 0.9 ? 'over' : frac >= 0.5 ? 'warn' : '';
  ui.budget.innerHTML = `
    <div class="vital"><span class="label">Spend</span>${bar(s.spentUsd, s.budgetUsd, `spend ${cls}`)}
      <span class="value">$${s.spentUsd.toFixed(4)}</span></div>
    <p class="note">${s.cycles} decisions · ${esc(s.model)} · cap $${s.budgetUsd.toFixed(2)}${
      s.running ? '' : ' · <strong>stopped</strong>'
    }</p>`;
}

function renderInventory(s) {
  const inv = s?.inventory;
  if (!inv || !inv.items || inv.items.length === 0) {
    ui.inventory.innerHTML = `<p class="empty">Carrying nothing.</p>`;
  } else {
    ui.inventory.innerHTML = inv.items
      .map(
        (i) => `<div class="slot" title="${esc(i.displayName ?? i.name)}">
          <span class="n">${esc(i.name.replace(/_/g, ' '))}</span>
          <span class="c">${i.count}</span></div>`,
      )
      .join('');
  }

  const near = s?.nearbyEntities;
  ui.nearby.innerHTML =
    !near || near.length === 0
      ? `<p class="empty">Nothing nearby.</p>`
      : near
          .slice(0, 10)
          .map(
            (e) =>
              `<div class="row"><span>${esc(e.name)}</span><span class="d">${e.distance}m</span></div>`,
          )
          .join('');
}

/**
 * Render the conversation from telemetry.
 *
 * Not from the agent's `recentlyHeard`: an agent does not hear itself, so its
 * own replies are absent there and the log would show only one side. Telemetry
 * has both, plus operator instructions.
 */
function renderChat(rows) {
  if (rows.length === 0) {
    ui.talkLog.innerHTML = `<p class="empty">Nothing said yet.</p>`;
    return;
  }

  // Oldest first, so the newest is at the bottom like every other chat.
  const ordered = rows.slice().reverse();
  const atBottom =
    ui.talkLog.scrollHeight - ui.talkLog.scrollTop - ui.talkLog.clientHeight < 40;

  ui.talkLog.innerHTML = ordered
    .map((m) => {
      if (m.eventType === 'chat_sent') {
        return message(state.live?.username ?? 'agent', m.text, 'agent');
      }
      if (m.eventType === 'thought_injected') {
        return message(`${m.who ?? 'operator'} (instruction)`, m.text, 'instruction');
      }
      return message(m.who ?? '?', m.text, m.directed ? 'directed' : '');
    })
    .join('');

  // Only auto-scroll if the reader was already at the bottom; yanking the view
  // while someone is reading back is worse than a missed message.
  if (atBottom) ui.talkLog.scrollTop = ui.talkLog.scrollHeight;
}

function message(who, text, cls = '') {
  return `<div class="msg ${cls}"><span class="who">${esc(who)}</span><span class="text">${esc(text)}</span></div>`;
}

function renderDecisions(rows) {
  ui.decisionsCount.textContent = rows.length ? `${rows.length} shown` : '';
  if (rows.length === 0) {
    ui.decisions.innerHTML = `<p class="empty">No decisions recorded yet.</p>`;
    return;
  }

  ui.decisions.innerHTML = rows
    .map((d) => {
      let tools = [];
      try {
        tools = JSON.parse(d.tools ?? '[]');
      } catch {
        tools = [];
      }
      const injected = Number(d.injections ?? 0) > 0;
      const time = String(d.timestamp ?? '').slice(11, 19);
      return `<li class="decision ${injected ? 'injected' : ''}">
        <div class="meta">
          <span>${time}</span>
          <span>#${d.cycle ?? '?'}</span>
          <span>${esc(d.trigger ?? '')}</span>
          ${injected ? '<span style="color:var(--gold)">instructed</span>' : ''}
          <span>$${Number(d.costUsd ?? 0).toFixed(5)}</span>
        </div>
        <div class="summary">${esc(d.summary ?? '')}</div>
        ${
          tools.length
            ? `<div class="tools">${tools.map((t) => `<span class="tool-chip">${esc(t)}</span>`).join('')}</div>`
            : ''
        }
      </li>`;
    })
    .join('');
}

/**
 * The doctor's findings: this agent's, plus anything about the whole session.
 *
 * Problems used to be found by querying telemetry by hand after a session; this
 * puts the same named checks next to the agent while it is still running.
 */
function renderHealth(body) {
  if (!ui.health) return;
  const findings = (body?.findings ?? []).filter(
    (f) => f.agent === null || f.agent === state.selected,
  );
  const serious = findings.filter((f) => f.severity !== 'info');

  if (serious.length === 0) {
    ui.health.innerHTML = `<p class="health-ok">No known failure patterns for this agent.</p>`;
    return;
  }

  ui.health.innerHTML = serious
    .map(
      (f) => `<div class="finding ${esc(f.severity)}">
        <span class="sev">${f.severity === 'error' ? 'error' : 'warn'}</span>
        <span class="msg">${esc(f.message)}</span>
        <span class="check">${esc(f.check)}</span>
      </div>`,
    )
    .join('');
}

function renderActions(rows) {
  if (rows.length === 0) {
    ui.actions.innerHTML = `<p class="empty">No actions yet.</p>`;
    return;
  }
  ui.actions.innerHTML = rows
    .map((a) => {
      const rate = a.attempts > 0 ? a.ok / a.attempts : 0;
      const cls = rate >= 0.8 ? '' : rate >= 0.4 ? 'mixed' : 'poor';
      return `<div class="action-row">
        <span class="name">${esc(a.action)}</span>
        <span class="stat">${a.ok}/${a.attempts} · ${a.avgMs ?? 0}ms</span>
        ${bar(rate, 1, `rate ${cls}`)}
      </div>`;
    })
    .join('');
}

// ------------------------------------------------------------------- map

/**
 * A stable colour per agent.
 *
 * Hashed from the id rather than assigned by position, so an agent keeps its
 * colour when another one starts or stops -- a legend that reshuffles itself
 * is worse than no legend.
 */
const AGENT_COLOURS = ['#6fb2e8', '#e8a24a', '#b98ce0', '#5fc9a8', '#e0687a', '#d7d06a'];

function agentColour(agentId) {
  if (!agentId) return '#ffffff';
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return AGENT_COLOURS[hash % AGENT_COLOURS.length];
}

function renderMap() {
  const canvas = ui.map;
  const ctx = canvas.getContext('2d');
  const size = canvas.width;

  ctx.fillStyle = '#0b0c09';
  ctx.fillRect(0, 0, size, size);

  const map = state.map;
  if (!map || !map.tiles) {
    ctx.fillStyle = '#6f7263';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('no map — is the agent running?', size / 2, size / 2);
    ui.mapReadout.textContent = '';
    return;
  }

  const span = map.radius * 2 + 1;
  // Pixels per BLOCK. Tiles may sample every Nth block at wide radii (see
  // observeMapTiles), so a tile is drawn step blocks wide -- otherwise a
  // downsampled map renders as a grid of gaps.
  const cell = size / span;
  const step = Math.max(1, map.step ?? 1);
  const tilePx = cell * step;
  const centreY = map.centre.y;

  // Terrain
  for (const t of map.tiles) {
    const base = blockColour(t.name);
    if (base === null) continue;
    // Height shading: higher ground lighter. Without it a forest floor and a
    // hilltop look identical and the map reads flat. Widened from the old
    // +/-0.22 because at a wider radius the map spans real hills, and the
    // gentler ramp made everything the same mid-grey.
    const dy = t.y === null ? 0 : t.y - centreY;
    ctx.fillStyle = shade(base, Math.max(-0.34, Math.min(0.34, dy * 0.035)));
    ctx.fillRect(
      Math.floor((t.dx + map.radius) * cell),
      Math.floor((t.dz + map.radius) * cell),
      // +1 so neighbouring tiles overlap by a pixel. Rounding each edge
      // independently otherwise leaves hairline seams that read as a grid.
      Math.ceil(tilePx) + 1,
      Math.ceil(tilePx) + 1,
    );
  }

  const toPx = (worldX, worldZ) => [
    (worldX - map.centre.x + map.radius) * cell,
    (worldZ - map.centre.z + map.radius) * cell,
  ];

  // Where the agent has been
  if (ui.mapTrail.checked && state.trail.length > 1) {
    ctx.strokeStyle = '#e8e6dc55';
    ctx.lineWidth = Math.max(1.5, cell * 0.16);
    ctx.beginPath();

    // Break the path on big jumps. Snapshots span several runs and the agent
    // respawns and reconnects, so joining every consecutive pair drew long
    // straight lines across the map that looked like teleporting.
    const MAX_STEP = 48;
    let drawing = false;
    let previous = null;

    for (const p of state.trail) {
      const [px, pz] = toPx(p.x, p.z);
      const jumped =
        previous !== null && Math.hypot(p.x - previous.x, p.z - previous.z) > MAX_STEP;

      if (!drawing || jumped) {
        ctx.moveTo(px, pz);
        drawing = true;
      } else {
        ctx.lineTo(px, pz);
      }
      previous = p;
    }
    ctx.stroke();
  }

  // What it has changed
  if (ui.mapMarks.checked) {
    for (const m of state.marks) {
      const [px, pz] = toPx(m.x, m.z);
      if (px < -cell || pz < -cell || px > size + cell || pz > size + cell) continue;
      ctx.fillStyle =
        m.eventType === 'block_placed' ? '#d8a531' : m.eventType === 'death' ? '#c4553d' : '#8fb7d6';
      const r = Math.max(1.6, Math.min(3.5, cell * 0.2));
      ctx.beginPath();
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Places the agent has written down. Always drawn: there are at most a
  // dozen, and they are the only things on this map that the agent chose to
  // remember rather than merely happened to touch.
  for (const place of state.places) {
    const [px, pz] = toPx(place.x, place.z);
    if (px < 0 || pz < 0 || px > size || pz > size) continue;

    const r = Math.max(5, Math.min(9, cell * 0.42));
    ctx.save();
    ctx.translate(px, pz);

    ctx.fillStyle = '#7fc7a4';
    ctx.strokeStyle = '#14171a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Below ~4px a block, a dozen labels overlap into an unreadable smear --
    // the marker still shows where the place is, which is the part that matters.
    if (cell >= 4) {
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#14171acc';
      ctx.strokeText(place.name, 0, -r - 4);
      ctx.fillStyle = '#e8e6dc';
      ctx.fillText(place.name, 0, -r - 4);
    }
    ctx.restore();
  }

  // Everyone on the map, not only the one being watched.
  //
  // The map used to draw a single white arrow at the centre and nothing else,
  // so with four agents in one world you could not see where anybody was in
  // relation to anybody -- which is most of what a map of a group is for.
  // Marker size is in PIXELS rather than blocks: scaling it off the cell size
  // made the agents shrink to specks exactly when the view was wide enough to
  // need them.
  const others = (state.agents ?? []).filter(
    (a) => a.agentId !== state.selected && a.self && Number.isFinite(a.self.x),
  );

  for (const other of others) {
    const [px, pz] = toPx(other.self.x, other.self.z);
    const colour = agentColour(other.agentId);

    // Off-screen agents are pinned to the edge rather than dropped: "Carla is
    // somewhere north of here" is worth more than her silently not existing.
    const edge = 12;
    const clamped = px < edge || pz < edge || px > size - edge || pz > size - edge;
    const ax = Math.max(edge, Math.min(size - edge, px));
    const az = Math.max(edge, Math.min(size - edge, pz));

    ctx.save();
    ctx.translate(ax, az);
    ctx.globalAlpha = clamped ? 0.55 : 1;

    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#14171a';
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#14171acc';
    const label = clamped ? `${other.username} →` : other.username;
    ctx.strokeText(label, 0, -10);
    ctx.fillStyle = colour;
    ctx.fillText(label, 0, -10);
    ctx.restore();
  }

  // The agent being watched, with a facing wedge. Drawn last so it is never
  // hidden behind somebody standing on the same spot.
  const [cx, cz] = toPx(map.centre.x, map.centre.z);
  const yaw = state.live?.self?.yaw ?? 0;
  const own = agentColour(state.selected);

  ctx.save();
  ctx.translate(cx, cz);
  ctx.strokeStyle = '#00000066';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.stroke();

  ctx.rotate(-yaw);
  // Minecraft yaw 0 faces +z; canvas +y is down, which is +z here.
  ctx.beginPath();
  ctx.moveTo(0, 11);
  ctx.lineTo(-7, -7);
  ctx.lineTo(0, -3);
  ctx.lineTo(7, -7);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = own;
  ctx.stroke();
  ctx.restore();

  if (state.live?.username) {
    ctx.save();
    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#14171acc';
    ctx.strokeText(state.live.username, cx, cz - 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(state.live.username, cx, cz - 15);
    ctx.restore();
  }

  const detail = step > 1 ? ` · 1 px per ${step} blocks` : '';
  ui.mapReadout.textContent =
    `centre ${map.centre.x}, ${map.centre.z}\n` +
    `${span}x${span} blocks · y ${centreY}${detail}`;
}

function renderLegend() {
  const shown = [
    ['grass', '#6a9b41'],
    ['leaves', '#3f6b32'],
    ['wood', '#5d4326'],
    ['dirt', '#7a5a3a'],
    ['stone', '#7d7d7d'],
    ['water', '#3a6ea8'],
    ['mined', '#8fb7d6'],
    ['placed', '#d8a531'],
    ['died', '#c4553d'],
    ['place', '#7fc7a4'],
  ];
  ui.legend.innerHTML = shown
    .map(([name, colour]) => `<span><i style="background:${colour}"></i>${name}</span>`)
    .join('');
}

// ------------------------------------------------------------------ polls

async function refreshState() {
  try {
    const data = await getJson('/api/agents');
    state.agents = data.agents ?? [];
    state.known = data.known ?? [];
    state.codeChangedAt = data.codeChangedAt ?? null;
    state.failures = 0;

    if (state.selected === null && state.agents.length > 0) {
      state.selected = state.agents[0].agentId;
      state.port = state.agents[0].port;
      void refreshHistory();
      void refreshMap();
    }

    renderTabs();

    const live = state.agents.find((a) => a.agentId === state.selected) ?? null;
    state.live = live;
    if (live) state.port = live.port;

    ui.conn.dataset.state = live ? 'live' : state.agents.length ? 'stale' : 'down';
    ui.conn.textContent = live ? 'live' : state.agents.length ? 'other agent' : 'no agent';

    renderIdentity(live);
    renderStaleness(live);
    renderInventory(live);
    ui.talkSend.disabled = live === null;
  } catch {
    state.failures++;
    ui.conn.dataset.state = 'down';
    ui.conn.textContent = 'dashboard offline';
  }
}

async function refreshHistory() {
  if (state.selected === null) return;
  const q = `agent=${encodeURIComponent(state.selected)}`;
  try {
    const [decisions, actions, trail, marks, places, chat, health] = await Promise.all([
      getJson(`/api/decisions?${q}&limit=30`),
      getJson(`/api/actions?${q}`),
      getJson(`/api/trail?${q}`),
      getJson(`/api/marks?${q}`),
      getJson(`/api/places?${q}`),
      getJson(`/api/chat?${q}&limit=40`),
      getJson('/api/health'),
    ]);
    renderDecisions(decisions);
    renderActions(actions);
    renderChat(chat);
    renderHealth(health);
    // Newest-first from SQL; the map wants oldest-first to draw a path.
    state.trail = trail.slice().reverse();
    state.marks = marks;
    state.places = places;
  } catch {
    /* transient; the next poll will retry */
  }
}

async function refreshMap() {
  if (state.port === null) {
    state.map = null;
    renderMap();
    return;
  }
  try {
    state.map = await getJson(`/api/map?port=${state.port}&radius=${ui.mapRadius.value}`);
  } catch {
    state.map = null;
  }
  renderMap();
}

// ------------------------------------------------------------------ input

ui.talkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.talkText.value.trim();
  if (text === '' || state.port === null) return;

  const mode = ui.talkForm.querySelector('input[name=mode]:checked').value;
  ui.talkText.value = '';
  ui.talkSend.disabled = true;

  const { ok } = await postJson(`/api/${mode}`, { port: state.port, text });
  ui.talkSend.disabled = false;
  ui.talkText.focus();

  if (!ok) {
    toast('the agent did not accept that', true);
    return;
  }

  toast(mode === 'tell' ? 'instruction queued for the next decision' : 'said');
  // Pull it straight through rather than echoing optimistically: what appears
  // in the log is then what the agent actually received, not what we hoped it
  // received.
  void refreshHistory();
});

for (const radio of ui.talkForm.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    const tell = radio.value === 'tell' && radio.checked;
    ui.talkHint.innerHTML = tell
      ? '<strong>Instruct</strong> is an operator directive — recorded in telemetry as an intervention.'
      : '<strong>Say</strong> is conversation — the agent may reply or ignore it.';
    ui.talkText.placeholder = tell ? 'Tell the agent what to do…' : 'Say something to the agent…';
  });
}

// Explicit, rather than relying on implicit form submission: this is a chat
// box, and Enter not sending is the first thing anyone would try.
ui.talkText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ui.talkForm.requestSubmit();
  }
});

ui.mapRadius.addEventListener('input', () => {
  ui.mapRadiusOut.textContent = ui.mapRadius.value;
});
ui.mapRadius.addEventListener('change', () => void refreshMap());
ui.mapTrail.addEventListener('change', renderMap);
ui.mapMarks.addEventListener('change', renderMap);

// ------------------------------------------------------------------- boot

renderLegend();
renderMap();
void refreshState();
void refreshHistory();
void refreshMap();

setInterval(() => void refreshState(), POLL_STATE_MS);
setInterval(() => void refreshHistory(), POLL_HISTORY_MS);
setInterval(() => void refreshMap(), POLL_MAP_MS);
