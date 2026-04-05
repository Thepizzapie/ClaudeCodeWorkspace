'use strict';

const PANES = ['frontend', 'backend'];
const terms = {};
const fitAddons = {};
let ws = null;
let reconnectTimer = null;
let currentProjectId = null;

const TERM_THEME = {
  background: '#0a0a0a', foreground: '#d8d8d8', cursor: '#5b8def',
  cursorAccent: '#0a0a0a', selectionBackground: '#2a3a5a',
  black: '#1a1a1a', brightBlack: '#444',
  red: '#c0392b', brightRed: '#e74c3c',
  green: '#27ae60', brightGreen: '#2ecc71',
  yellow: '#d4a017', brightYellow: '#f39c12',
  blue: '#5b8def', brightBlue: '#74a7ff',
  magenta: '#7c5bef', brightMagenta: '#9b77ff',
  cyan: '#1abc9c', brightCyan: '#1dd2af',
  white: '#d8d8d8', brightWhite: '#ffffff',
};

// ─── Terminals ────────────────────────────────────────────────────────────────

function setupTerminals() {
  PANES.forEach(id => {
    const container = document.getElementById(`term-${id}`);
    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontSize: 13, lineHeight: 1.25, cursorBlink: true,
      allowTransparency: true, scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    term.onData(data => send({ type: 'input', id, data }));
    terms[id] = term;
    fitAddons[id] = fitAddon;
    new ResizeObserver(() => {
      fitAddon.fit();
      send({ type: 'resize', id, cols: term.cols, rows: term.rows });
    }).observe(container);
  });
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

function handleMessage({ type, id, data, exitCode, entries, projectId }) {
  if (type === 'output' && terms[id]) terms[id].write(data);
  if (type === 'exit' && id) setTermStatus(id, 'exited');
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

const elCtxPanel  = document.getElementById('ctx-panel');
const elCtxToggle = document.getElementById('ctx-toggle');
const elCtxClose  = document.getElementById('ctx-panel-close');
const elCtxEntries = document.getElementById('ctx-entries');

elCtxToggle.addEventListener('click', () => {
  const open = elCtxPanel.classList.toggle('open');
  elCtxToggle.classList.toggle('active', open);
  if (open) PANES.forEach(id => fitAddons[id] && fitAddons[id].fit());
});

elCtxClose.addEventListener('click', () => {
  elCtxPanel.classList.remove('open');
  elCtxToggle.classList.remove('active');
  PANES.forEach(id => fitAddons[id] && fitAddons[id].fit());
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
      <div class="ctx-entry-body">${esc(entry.content)}</div>
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

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(text, cls) {
  const el = document.getElementById('conn-status');
  el.textContent = text;
  el.className = 'conn-status ' + cls;
}

function setTermStatus(id, status) {
  const el = document.getElementById(`status-${id}`);
  if (el) { el.textContent = status; el.className = 'pane-status ' + status; }
}

// ─── Draggable divider ────────────────────────────────────────────────────────

function setupDivider() {
  const divider = document.getElementById('divider');
  const container = document.querySelector('.terminals');
  let dragging = false, startX, startWidths;

  divider.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX;
    const panes = container.querySelectorAll('.pane');
    startWidths = Array.from(panes).map(p => p.getBoundingClientRect().width);
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const total = startWidths[0] + startWidths[1];
    const newLeft = Math.max(200, Math.min(total - 200, startWidths[0] + dx));
    const panes = container.querySelectorAll('.pane');
    panes[0].style.flex = 'none'; panes[0].style.width = newLeft + 'px'; panes[1].style.flex = '1';
    PANES.forEach(id => fitAddons[id] && fitAddons[id].fit());
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; divider.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

setupTerminals();
setupDivider();
connect();
