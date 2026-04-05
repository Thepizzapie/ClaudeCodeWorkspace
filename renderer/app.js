'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const PANE_COLORS = ['#5b8def', '#7c5bef', '#27ae60', '#d4a017'];

const DEFAULT_APP_PROMPT = `You are running inside Claude Workspace Manager. An MCP server called 'workspace-context' is connected and gives you tools to read and write shared project context that persists between sessions.

At the start of this session, run list_context to review existing notes, decisions, and specs for this project.

As you work, actively use the MCP tools to keep project records up to date:
- add_context / update_context — log decisions (type: decision), architecture notes (type: spec), task findings (type: note), and code snippets (type: code)
- get_context — read any entry in full; file-type entries return live file contents
- fetch_url_context — pull in documentation or reference URLs
- search_context — search before adding to avoid duplicates
- delete_context — clean up outdated entries

Log every significant decision, architecture choice, or design rationale using these tools so future sessions have full context. Do not wait until the end — log as you go.`;

// ─── State ────────────────────────────────────────────────────────────────────

let projects = [];
let currentId = null;
let running = false;
let serverRunning = false;
let contextEntries = [];

const terms = {};
const fitAddons = {};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const elProjectList   = document.getElementById('project-list');
const elProjectName   = document.getElementById('project-name');
const elBtnLaunch     = document.getElementById('btn-launch');
const elBtnKill       = document.getElementById('btn-kill');
const elBtnDelete     = document.getElementById('btn-delete');
const elBtnNew        = document.getElementById('btn-new');
const elBtnServer     = document.getElementById('btn-server');
const elServerUrl     = document.getElementById('server-url');
const elBtnCopyUrl    = document.getElementById('btn-copy-url');
const elServerClients = document.getElementById('server-clients');
const elBtnContext    = document.getElementById('btn-context');
const elBtnProject    = document.getElementById('btn-project');
const elDrawer        = document.getElementById('context-drawer');
const elBackdrop      = document.getElementById('drawer-backdrop');
const elContextList   = document.getElementById('context-list');
const elCtxTitle      = document.getElementById('ctx-title');
const elCtxType       = document.getElementById('ctx-type');
const elCtxContent    = document.getElementById('ctx-content');
const elBtnCtxSave    = document.getElementById('btn-ctx-save');
const elBtnCtxCancel  = document.getElementById('btn-ctx-cancel');
const elSpToggle      = document.getElementById('sp-toggle');
const elSpArrow       = document.getElementById('sp-arrow');
const elSpBody        = document.getElementById('sp-body');
const elSpStatus      = document.getElementById('sp-status');
// App Prompt
const elApToggle      = document.getElementById('ap-toggle');
const elApArrow       = document.getElementById('ap-arrow');
const elApBody        = document.getElementById('ap-body');
const elApStatus      = document.getElementById('ap-status');
const elAppPrompt     = document.getElementById('app-prompt-textarea');

let editingEntryId = null;
let projectViewOpen = false;

function el(id) { return document.getElementById(id); }

// ─── Migration ────────────────────────────────────────────────────────────────

function migrateProject(p) {
  if (p.panes) return p;
  p.panes = [
    { id: 'p0', name: 'Frontend', path: p.frontend || '' },
    { id: 'p1', name: 'Backend',  path: p.backend  || '' },
  ];
  p.sessionPrompts = {
    p0: (p.sessionPrompt && p.sessionPrompt.frontend) || '',
    p1: (p.sessionPrompt && p.sessionPrompt.backend)  || '',
  };
  delete p.frontend;
  delete p.backend;
  delete p.sessionPrompt;
  return p;
}

function newPaneId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  projects = await window.api.loadProjects();
  projects.forEach(migrateProject);
  await loadAppPrompt();
  setupIPC();
  bindUI();
  renderProjectList();
  if (projects.length > 0) selectProject(projects[0].id);
  else createProject();
}

async function loadAppPrompt() {
  const settings = await window.api.loadSettings();
  if (settings.appPrompt !== undefined) {
    elAppPrompt.value = settings.appPrompt;
  } else {
    elAppPrompt.value = DEFAULT_APP_PROMPT;
    await window.api.saveSettings({ appPrompt: DEFAULT_APP_PROMPT });
  }
  updateApStatus();
}

function updateApStatus() {
  elApStatus.textContent = elAppPrompt.value.trim() ? '● on' : '';
}

// ─── Terminal Management ──────────────────────────────────────────────────────

function teardownTerminals() {
  Object.keys(terms).forEach(id => {
    try { terms[id].dispose(); } catch (_) {}
    delete terms[id];
    delete fitAddons[id];
  });
}

function renderTerminalPanes(panes) {
  const section = el('terminals-section');
  section.innerHTML = '';
  section.className = `terminals-section panes-${panes.length}`;

  panes.forEach((pane, index) => {
    const color = PANE_COLORS[index % PANE_COLORS.length];
    const div = document.createElement('div');
    div.className = 'terminal-pane';
    div.id = `pane-${pane.id}`;
    div.innerHTML = `
      <div class="terminal-header">
        <span class="terminal-label" style="color:${color}">${escHtml(pane.name)}</span>
        <span class="terminal-cwd" id="cwd-${pane.id}"></span>
        <span class="terminal-status" id="status-${pane.id}">idle</span>
      </div>
      <div class="terminal-body" id="term-${pane.id}"></div>
    `;
    section.appendChild(div);
  });

  setupTerminals(panes);
}

function setupTerminals(panes) {
  panes.forEach(pane => {
    const container = el(`term-${pane.id}`);
    if (!container) return;
    const term = new Terminal({
      theme: {
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
      },
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontSize: 13, lineHeight: 1.25, cursorBlink: true,
      allowTransparency: true, scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try { fitAddon.fit(); } catch (_) {}
    term.onData(data => { if (running) window.api.writeTerminal(pane.id, data); });
    terms[pane.id] = term;
    fitAddons[pane.id] = fitAddon;
    new ResizeObserver(() => {
      if (!container.offsetParent) return;
      try { fitAddon.fit(); } catch (_) {}
      window.api.resizeTerminal(pane.id, term.cols, term.rows);
    }).observe(container);
  });
}

// ─── IPC Setup ────────────────────────────────────────────────────────────────

function setupIPC() {
  window.api.onTerminalData(({ id, data }) => { if (terms[id]) terms[id].write(data); });
  window.api.onTerminalExit(({ id }) => {
    setTermStatus(id, 'exited');
    const dot = el(`dot-${id}`);
    if (dot) dot.className = 'status-dot exited';
    checkAllExited();
  });

  window.api.onServerStarted(({ url }) => {
    serverRunning = true;
    elBtnServer.textContent = 'Stop sharing';
    elBtnServer.classList.add('active');
    elServerUrl.textContent = url;
    elBtnCopyUrl.style.display = '';
    elServerClients.style.display = '';
    elServerClients.textContent = '0 connected';
  });
  window.api.onServerStopped(() => {
    serverRunning = false;
    elBtnServer.textContent = 'Share';
    elBtnServer.classList.remove('active');
    elServerUrl.textContent = '';
    elBtnCopyUrl.style.display = 'none';
    elServerClients.style.display = 'none';
  });
  window.api.onServerClients(count => {
    elServerClients.textContent = `${count} connected`;
  });

  window.api.onContextUpdated(({ projectId, entries }) => {
    if (projectId === currentId) { contextEntries = entries; renderContextList(); }
  });
}

function checkAllExited() {
  const p = getProject(currentId);
  if (!p) return;
  const allDone = p.panes.every(pane => {
    const s = el(`status-${pane.id}`);
    return !s || s.textContent === 'exited' || s.textContent === 'idle';
  });
  if (allDone) { running = false; elBtnLaunch.disabled = false; elBtnKill.disabled = true; }
}

// ─── UI Binding ───────────────────────────────────────────────────────────────

function bindUI() {
  elBtnNew.addEventListener('click', createProject);
  elBtnLaunch.addEventListener('click', launchTerminals);
  elBtnKill.addEventListener('click', killTerminals);
  elBtnDelete.addEventListener('click', deleteCurrentProject);

  elProjectName.addEventListener('input', () => {
    const p = getProject(currentId);
    if (!p) return;
    p.name = elProjectName.value || 'Untitled';
    renderProjectList();
    saveProjects();
  });

  el('btn-add-pane').addEventListener('click', () => {
    const p = getProject(currentId);
    if (!p || p.panes.length >= 4) return;
    p.panes.push({ id: newPaneId(), name: 'New Pane', path: '' });
    if (!p.sessionPrompts) p.sessionPrompts = {};
    saveProjects();
    reloadPaneUI(p);
  });

  elBtnServer.addEventListener('click', async () => {
    if (!serverRunning) await window.api.startServer();
    else await window.api.stopServer();
  });
  elBtnCopyUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(elServerUrl.textContent);
    elBtnCopyUrl.textContent = 'Copied!';
    setTimeout(() => { elBtnCopyUrl.textContent = 'Copy'; }, 1500);
  });

  elApToggle.addEventListener('click', () => {
    const open = elApBody.style.display === 'none';
    elApBody.style.display = open ? '' : 'none';
    elApArrow.classList.toggle('open', open);
  });
  elAppPrompt.addEventListener('input', async () => {
    await window.api.saveSettings({ appPrompt: elAppPrompt.value });
    updateApStatus();
  });

  elSpToggle.addEventListener('click', () => {
    const open = elSpBody.style.display === 'none';
    elSpBody.style.display = open ? '' : 'none';
    elSpArrow.classList.toggle('open', open);
  });

  elBtnProject.addEventListener('click', toggleProjectView);

  elBtnContext.addEventListener('click', openDrawer);
  elBtnCtxCancel.addEventListener('click', cancelEdit);
  elBackdrop.addEventListener('click', closeDrawer);
  el('btn-close-context').addEventListener('click', closeDrawer);

  document.querySelectorAll('.ctx-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ctx-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.drawer-add').forEach(d => d.style.display = 'none');
      el(`tab-${tab.dataset.tab}`).style.display = '';
    });
  });

  elBtnCtxSave.addEventListener('click', async () => {
    const title   = elCtxTitle.value.trim();
    const content = elCtxContent.value.trim();
    const type    = elCtxType.value;
    if (!title || !content) return;
    if (editingEntryId) {
      contextEntries = await window.api.updateContext(currentId, editingEntryId, title, content, type);
      cancelEdit();
    } else {
      contextEntries = await window.api.addContext(currentId, title, content, type);
      elCtxTitle.value = '';
      elCtxContent.value = '';
      elCtxType.value = 'note';
    }
    renderContextList();
  });

  el('btn-add-files').addEventListener('click', async () => {
    const files = await window.api.openFiles();
    if (!files.length) return;
    contextEntries = await window.api.addFileContext(currentId, files);
    renderContextList();
  });

  el('btn-add-url').addEventListener('click', async () => {
    const url   = el('ctx-url-value').value.trim();
    const title = el('ctx-url-title').value.trim();
    if (!url) return;
    contextEntries = await window.api.addUrlContext(currentId, title, url);
    el('ctx-url-value').value = '';
    el('ctx-url-title').value = '';
    renderContextList();
  });
  el('ctx-url-value').addEventListener('keydown', e => {
    if (e.key === 'Enter') el('btn-add-url').click();
  });
}

// ─── Pane UI ──────────────────────────────────────────────────────────────────

function reloadPaneUI(p) {
  teardownTerminals();
  renderWorkspaceRows(p);
  renderSessionPrompts(p);
  renderTerminalPanes(p.panes);
}

function renderWorkspaceRows(p) {
  const container = el('workspace-rows-container');
  container.innerHTML = '';

  p.panes.forEach((pane, index) => {
    const color = PANE_COLORS[index % PANE_COLORS.length];
    const row = document.createElement('div');
    row.className = 'workspace-row';
    row.innerHTML = `
      <input class="ws-name-input" type="text" value="${escHtml(pane.name)}" spellcheck="false" style="color:${color}" data-pane-id="${pane.id}" title="Rename pane"/>
      <span class="ws-path${pane.path ? ' has-path' : ''}" id="ws-path-${pane.id}">${pane.path ? escHtml(pane.path) : 'No directory selected'}</span>
      <button class="btn btn-browse" data-pane-id="${pane.id}">Browse</button>
      <span class="status-dot" id="dot-${pane.id}"></span>
      <button class="btn-remove-pane" data-pane-id="${pane.id}"${p.panes.length <= 1 ? ' disabled' : ''} title="Remove pane">×</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.ws-name-input').forEach(input => {
    input.addEventListener('input', () => {
      const p2 = getProject(currentId);
      if (!p2) return;
      const pane = p2.panes.find(pn => pn.id === input.dataset.paneId);
      if (!pane) return;
      pane.name = input.value || 'Pane';
      const label = el(`pane-${pane.id}`)?.querySelector('.terminal-label');
      if (label) label.textContent = pane.name;
      const spLabel = el('session-prompts-container')?.querySelector(`[data-pane-label="${pane.id}"]`);
      if (spLabel) spLabel.textContent = pane.name;
      saveProjects();
    });
  });

  container.querySelectorAll('.btn-browse').forEach(btn => {
    btn.addEventListener('click', async () => {
      const dir = await window.api.openFolder();
      if (!dir) return;
      const p2 = getProject(currentId);
      if (!p2) return;
      const pane = p2.panes.find(pn => pn.id === btn.dataset.paneId);
      if (!pane) return;
      pane.path = dir;
      const pathEl = el(`ws-path-${pane.id}`);
      if (pathEl) { pathEl.textContent = dir; pathEl.classList.add('has-path'); }
      const cwdEl = el(`cwd-${pane.id}`);
      if (cwdEl) cwdEl.textContent = dir;
      saveProjects();
    });
  });

  container.querySelectorAll('.btn-remove-pane').forEach(btn => {
    btn.addEventListener('click', () => {
      if (running) return;
      const p2 = getProject(currentId);
      if (!p2 || p2.panes.length <= 1) return;
      const paneId = btn.dataset.paneId;
      p2.panes = p2.panes.filter(pn => pn.id !== paneId);
      if (p2.sessionPrompts) delete p2.sessionPrompts[paneId];
      saveProjects();
      reloadPaneUI(p2);
    });
  });

  el('btn-add-pane').disabled = p.panes.length >= 4;
}

function renderSessionPrompts(p) {
  const container = el('session-prompts-container');
  container.innerHTML = '';

  p.panes.forEach((pane, index) => {
    const color = PANE_COLORS[index % PANE_COLORS.length];
    const prompt = (p.sessionPrompts && p.sessionPrompts[pane.id]) || '';
    const field = document.createElement('div');
    field.className = 'sp-field';
    field.innerHTML = `
      <label class="sp-field-label" data-pane-label="${pane.id}" style="color:${color}">${escHtml(pane.name)}</label>
      <textarea class="sp-textarea" id="sp-${pane.id}" placeholder="Prompt for ${escHtml(pane.name)}..." rows="2" spellcheck="false">${escHtml(prompt)}</textarea>
    `;
    container.appendChild(field);
  });

  container.querySelectorAll('.sp-textarea').forEach(ta => {
    ta.addEventListener('input', saveSessionPrompt);
  });

  updateSpStatus(p);
}

// ─── Session Prompts ──────────────────────────────────────────────────────────

function saveSessionPrompt() {
  const p = getProject(currentId);
  if (!p) return;
  if (!p.sessionPrompts) p.sessionPrompts = {};
  p.panes.forEach(pane => {
    const ta = el(`sp-${pane.id}`);
    if (ta) p.sessionPrompts[pane.id] = ta.value;
  });
  updateSpStatus(p);
  saveProjects();
}

function updateSpStatus(p) {
  const prompts = p.sessionPrompts || {};
  const active = p.panes.filter(pane => prompts[pane.id] && prompts[pane.id].trim());
  if (!active.length)                      elSpStatus.textContent = '';
  else if (active.length === p.panes.length) elSpStatus.textContent = '→ all';
  else                                     elSpStatus.textContent = `→ ${active.map(pn => pn.name).join(', ')}`;
}

// ─── Project View ─────────────────────────────────────────────────────────────

function toggleProjectView() {
  projectViewOpen = !projectViewOpen;
  el('project-view').style.display    = projectViewOpen ? '' : 'none';
  el('terminals-section').style.display = projectViewOpen ? 'none' : '';
  elBtnProject.classList.toggle('active', projectViewOpen);
  elBtnProject.textContent = projectViewOpen ? 'Terminals' : 'Project';
  if (projectViewOpen && currentId) {
    PM.init(currentId);
  } else {
    Object.values(fitAddons).forEach(fa => { try { fa.fit(); } catch (_) {} });
  }
}

// ─── Context Drawer ───────────────────────────────────────────────────────────

function openDrawer() {
  elDrawer.classList.add('open');
  elBackdrop.classList.add('visible');
}

function closeDrawer() {
  elDrawer.classList.remove('open');
  elBackdrop.classList.remove('visible');
  cancelEdit();
}

function cancelEdit() {
  editingEntryId = null;
  elCtxTitle.value = '';
  elCtxContent.value = '';
  elCtxType.value = 'note';
  elBtnCtxSave.textContent = 'Add Entry';
  elBtnCtxCancel.style.display = 'none';
  document.querySelectorAll('.ctx-entry.editing').forEach(e => e.classList.remove('editing'));
}

async function loadContextForProject(projectId) {
  contextEntries = await window.api.loadContext(projectId);
  renderContextList();
}

function renderContextList() {
  if (!contextEntries.length) {
    elContextList.innerHTML = '<div class="ctx-empty">No context entries yet.<br>Add notes, files, or URLs<br>for Claude to reference.</div>';
    return;
  }
  elContextList.innerHTML = '';
  contextEntries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'ctx-entry';
    div.dataset.id = entry.id;

    const subline = entry.type === 'file'
      ? `<div class="ctx-subline">${escHtml(entry.path)}</div>`
      : entry.type === 'url'
      ? `<div class="ctx-subline">${escHtml(entry.url)}</div>`
      : '';

    const canEdit = entry.type !== 'file' && entry.type !== 'url';

    div.innerHTML = `
      <div class="ctx-entry-header">
        <span class="ctx-type-badge ${entry.type || 'note'}">${entry.type || 'note'}</span>
        <span class="ctx-entry-title">${escHtml(entry.title)}</span>
        <div class="ctx-entry-actions">
          ${canEdit ? '<button class="ctx-action-btn edit-btn">Edit</button>' : ''}
          <button class="ctx-action-btn del del-btn">Delete</button>
        </div>
      </div>
      ${subline}
      ${canEdit ? `<div class="ctx-entry-body">${escHtml(entry.content || '')}</div>` : ''}
      ${canEdit ? `<div class="ctx-edit-form">
        <input class="ctx-input edit-title" type="text" value="${escHtml(entry.title)}" spellcheck="false"/>
        <select class="ctx-select edit-type">
          ${['note','spec','doc','code','decision','other'].map(t =>
            `<option value="${t}"${t === entry.type ? ' selected' : ''}>${t}</option>`
          ).join('')}
        </select>
        <textarea class="ctx-textarea edit-content" rows="4" spellcheck="false">${escHtml(entry.content || '')}</textarea>
      </div>` : ''}
    `;

    div.querySelector('.ctx-entry-header').addEventListener('click', e => {
      if (e.target.closest('.ctx-entry-actions')) return;
      div.classList.toggle('expanded');
    });

    if (canEdit) {
      div.querySelector('.edit-btn').addEventListener('click', e => {
        e.stopPropagation();
        document.querySelectorAll('.ctx-entry.editing').forEach(d => d.classList.remove('editing'));
        div.classList.add('editing', 'expanded');
        editingEntryId = entry.id;
        elCtxTitle.value   = entry.title;
        elCtxContent.value = entry.content || '';
        elCtxType.value    = entry.type || 'note';
        elBtnCtxSave.textContent = 'Save Changes';
        elBtnCtxCancel.style.display = '';
        document.querySelectorAll('.ctx-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'text'));
        document.querySelectorAll('.drawer-add').forEach(d => d.style.display = 'none');
        el('tab-text').style.display = '';
        elCtxTitle.focus();
      });
    }

    div.querySelector('.del-btn').addEventListener('click', async e => {
      e.stopPropagation();
      contextEntries = await window.api.deleteContext(currentId, entry.id);
      renderContextList();
    });

    elContextList.appendChild(div);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Project Management ───────────────────────────────────────────────────────

function createProject() {
  const id = `proj-${Date.now()}`;
  projects.push({
    id,
    name: 'New Project',
    panes: [
      { id: newPaneId(), name: 'Frontend', path: '' },
      { id: newPaneId(), name: 'Backend',  path: '' },
    ],
    sessionPrompts: {},
  });
  renderProjectList();
  saveProjects();
  selectProject(id);
  elProjectName.focus();
  elProjectName.select();
}

function selectProject(id) {
  if (running) return;
  currentId = id;
  renderProjectList();
  loadProjectUI();
  loadContextForProject(id);
  if (projectViewOpen) PM.init(id);
}

function getProject(id) { return projects.find(p => p.id === id); }

function deleteCurrentProject() {
  if (!currentId) return;
  if (running) { alert('Kill the terminals before deleting.'); return; }
  projects = projects.filter(p => p.id !== currentId);
  saveProjects();
  renderProjectList();
  if (projects.length > 0) selectProject(projects[0].id);
  else createProject();
}

async function saveProjects() { await window.api.saveProjects(projects); }

// ─── Render ───────────────────────────────────────────────────────────────────

function renderProjectList() {
  elProjectList.innerHTML = '';
  projects.forEach(p => {
    const li = document.createElement('li');
    li.className = 'project-item' + (p.id === currentId ? ' active' : '');
    li.textContent = p.name || 'Untitled';
    li.title = p.name || 'Untitled';
    li.addEventListener('click', () => selectProject(p.id));
    elProjectList.appendChild(li);
  });
}

function loadProjectUI() {
  const p = getProject(currentId);
  if (!p) return;
  migrateProject(p);
  elProjectName.value = p.name || '';
  reloadPaneUI(p);
}

function setTermStatus(id, status) {
  const s = el(`status-${id}`);
  if (!s) return;
  s.textContent = status;
  s.className = 'terminal-status ' + status;
}

// ─── Terminal Launch / Kill ───────────────────────────────────────────────────

async function launchTerminals() {
  const p = getProject(currentId);
  if (!p) return;
  const unset = p.panes.filter(pane => !pane.path);
  if (unset.length) {
    alert(`Please set directories for: ${unset.map(pn => pn.name).join(', ')}`);
    return;
  }

  p.panes.forEach(pane => { if (terms[pane.id]) terms[pane.id].clear(); });
  running = true;
  elBtnLaunch.disabled = true;
  elBtnKill.disabled = false;

  if (window.api.setPanesConfig) {
    window.api.setPanesConfig(p.panes.map((pane, i) => ({
      id: pane.id, name: pane.name, colorIndex: i,
    })));
  }

  for (const pane of p.panes) {
    setTermStatus(pane.id, 'running');
    const dot = el(`dot-${pane.id}`);
    if (dot) dot.className = 'status-dot running';
    const prompt = p.sessionPrompts && p.sessionPrompts[pane.id];
    await window.api.spawnTerminal(pane.id, pane.path, currentId, prompt && prompt.trim() ? prompt.trim() : null);
  }
}

async function killTerminals() {
  const p = getProject(currentId);
  if (!p) return;
  for (const pane of p.panes) {
    await window.api.killTerminal(pane.id);
    setTermStatus(pane.id, 'idle');
    const dot = el(`dot-${pane.id}`);
    if (dot) dot.className = 'status-dot';
  }
  running = false;
  elBtnLaunch.disabled = false;
  elBtnKill.disabled = true;
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
