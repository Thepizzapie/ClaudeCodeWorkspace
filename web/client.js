'use strict';

const PANE_COLORS = ['#9cff93', '#15a4ff', '#ffc965', '#ff6b9d'];

const terms = {};
const fitAddons = {};
let ws = null;
let reconnectTimer = null;
let currentProjectId = null;

const TERM_THEME = {
  background: '#080808', foreground: '#e0e0e0', cursor: '#9cff93',
  cursorAccent: '#080808', selectionBackground: '#1a3a1a',
  black: '#141414', brightBlack: '#484847',
  red: '#ff4d4d', brightRed: '#ff6b6b',
  green: '#9cff93', brightGreen: '#00fc40',
  yellow: '#ffc965', brightYellow: '#ffd98a',
  blue: '#15a4ff', brightBlue: '#5bc0ff',
  magenta: '#ff6b9d', brightMagenta: '#ff8fb5',
  cyan: '#00d4ff', brightCyan: '#33dcff',
  white: '#e0e0e0', brightWhite: '#ffffff',
};

// ─── Pane Management ──────────────────────────────────────────────────────────

function rebuildPanes(panes) {
  Object.keys(terms).forEach(id => {
    try { terms[id].dispose(); } catch (_) {}
    delete terms[id];
    delete fitAddons[id];
  });

  const container = document.getElementById('terminals-container');
  container.innerHTML = '';
  container.className = `terminals panes-${panes.length}`;

  panes.forEach(({ id, name, colorIndex }) => {
    const color = PANE_COLORS[(colorIndex ?? 0) % PANE_COLORS.length];
    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.id = `pane-${id}`;
    pane.innerHTML = `
      <div class="pane-header">
        <span class="pane-label" style="color:${color}">${esc(name)}</span>
        <span class="pane-status" id="status-${id}">idle</span>
      </div>
      <div class="term-wrap" id="term-${id}"></div>
    `;
    container.appendChild(pane);
  });

  panes.forEach(({ id }) => {
    const wrap = document.getElementById(`term-${id}`);
    if (!wrap) return;
    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontSize: 13, lineHeight: 1.25, cursorBlink: true,
      allowTransparency: true, scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrap);
    try { fitAddon.fit(); } catch (_) {}
    term.onData(data => send({ type: 'input', id, data }));
    terms[id] = term;
    fitAddons[id] = fitAddon;
    new ResizeObserver(() => {
      try { fitAddon.fit(); } catch (_) {}
      send({ type: 'resize', id, cols: term.cols, rows: term.rows });
    }).observe(wrap);
  });
}

function refitAll() {
  Object.values(fitAddons).forEach(fa => { try { fa.fit(); } catch (_) {} });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  const token = location.pathname.split('/').filter(Boolean)[0] || '';
  setStatus('Connecting...', '');
  ws = new WebSocket(`ws://${location.host}/${token}`);

  ws.onopen = () => {
    setStatus('Connected', 'connected');
    clearTimeout(reconnectTimer);
  };
  ws.onmessage = ({ data }) => {
    try { handleMessage(JSON.parse(data)); } catch (_) {}
  };
  ws.onclose = () => {
    setStatus('Disconnected — retrying...', 'disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function handleMessage({ type, id, data, panes, entries, projectId }) {
  if (type === 'output' && terms[id]) terms[id].write(data);
  if (type === 'exit'   && id) setTermStatus(id, 'exited');
  if (type === 'panes-config' && Array.isArray(panes)) rebuildPanes(panes);
  if (type === 'context:sync') {
    currentProjectId = projectId;
    renderContextEntries(entries || []);
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

// ─── Context panel ────────────────────────────────────────────────────────────

const elCtxPanel   = document.getElementById('ctx-panel');
const elCtxToggle  = document.getElementById('ctx-toggle');
const elCtxClose   = document.getElementById('ctx-panel-close');
const elCtxEntries = document.getElementById('ctx-entries');

elCtxToggle.addEventListener('click', () => {
  const open = elCtxPanel.classList.toggle('open');
  elCtxToggle.classList.toggle('active', open);
  refitAll();
});

elCtxClose.addEventListener('click', () => {
  elCtxPanel.classList.remove('open');
  elCtxToggle.classList.remove('active');
  refitAll();
});

document.getElementById('web-ctx-save').addEventListener('click', () => {
  const title   = document.getElementById('web-ctx-title').value.trim();
  const content = document.getElementById('web-ctx-content').value.trim();
  const type    = document.getElementById('web-ctx-type').value;
  if (!title || !content || !currentProjectId) return;
  send({ type: 'context:add', projectId: currentProjectId, title, content, contextType: type });
  document.getElementById('web-ctx-title').value = '';
  document.getElementById('web-ctx-content').value = '';
});

function renderContextEntries(entries) {
  if (!entries.length) {
    elCtxEntries.innerHTML = '<div class="ctx-empty">No context entries yet.</div>';
    return;
  }
  elCtxEntries.innerHTML = '';
  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'ctx-entry';
    div.innerHTML = `
      <div class="ctx-entry-row">
        <span class="ctx-badge ${entry.type || 'note'}">${entry.type || 'note'}</span>
        <span class="ctx-entry-title">${esc(entry.title)}</span>
        <button class="ctx-del-btn" data-id="${entry.id}">Delete</button>
      </div>
      <div class="ctx-entry-body">${esc(entry.content || '')}</div>
    `;
    div.querySelector('.ctx-entry-row').addEventListener('click', e => {
      if (e.target.classList.contains('ctx-del-btn')) return;
      div.classList.toggle('expanded');
    });
    div.querySelector('.ctx-del-btn').addEventListener('click', () => {
      send({ type: 'context:delete', projectId: currentProjectId, id: entry.id });
    });
    elCtxEntries.appendChild(div);
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(text, cls) {
  const el = document.getElementById('conn-status');
  el.textContent = text;
  el.className = 'conn-status ' + cls;
}

function setTermStatus(id, status) {
  const el = document.getElementById(`status-${id}`);
  if (el) { el.textContent = status; el.className = 'pane-status ' + status; }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
