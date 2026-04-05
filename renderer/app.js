'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let projects = [];
let currentId = null;
let running = false;
let serverRunning = false;
let contextEntries = [];

const PANES = ['frontend', 'backend'];
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
// Session prompt
const elSpToggle      = document.getElementById('sp-toggle');
const elSpArrow       = document.getElementById('sp-arrow');
const elSpBody        = document.getElementById('sp-body');
const elSpFrontend    = document.getElementById('sp-frontend');
const elSpBackend     = document.getElementById('sp-backend');
const elSpStatus      = document.getElementById('sp-status');

let editingEntryId = null;

function el(id) { return document.getElementById(id); }

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  projects = await window.api.loadProjects();
  setupTerminals();
  setupIPC();
  bindUI();
  renderProjectList();
  if (projects.length > 0) selectProject(projects[0].id);
  else createProject();
}

// ─── Terminals ────────────────────────────────────────────────────────────────

function setupTerminals() {
  PANES.forEach(id => {
    const container = el(`term-${id}`);
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
    fitAddon.fit();
    term.onData(data => { if (running) window.api.writeTerminal(id, data); });
    terms[id] = term;
    fitAddons[id] = fitAddon;
    new ResizeObserver(() => {
      fitAddon.fit();
      window.api.resizeTerminal(id, term.cols, term.rows);
    }).observe(container);
  });
}

function setupIPC() {
  window.api.onTerminalData(({ id, data }) => { if (terms[id]) terms[id].write(data); });
  window.api.onTerminalExit(({ id }) => {
    setTermStatus(id, 'exited');
    el(`dot-${id}`).className = 'status-dot exited';
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
  const allDone = PANES.every(id => {
    const s = el(`status-${id}`);
    return s && (s.textContent === 'exited' || s.textContent === 'idle');
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

  PANES.forEach(role => {
    el(`browse-${role}`).addEventListener('click', async () => {
      const dir = await window.api.openFolder();
      if (!dir) return;
      const p = getProject(currentId);
      if (!p) return;
      p[role] = dir;
      updatePathDisplay(role, dir);
      saveProjects();
    });
  });

  // Server
  elBtnServer.addEventListener('click', async () => {
    if (!serverRunning) await window.api.startServer();
    else await window.api.stopServer();
  });
  elBtnCopyUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(elServerUrl.textContent);
    elBtnCopyUrl.textContent = 'Copied!';
    setTimeout(() => { elBtnCopyUrl.textContent = 'Copy'; }, 1500);
  });

  // Session prompt toggle
  elSpToggle.addEventListener('click', () => {
    const open = elSpBody.style.display === 'none';
    elSpBody.style.display = open ? '' : 'none';
    elSpArrow.classList.toggle('open', open);
  });

  // Session prompt auto-save on change
  elSpFrontend.addEventListener('input', saveSessionPrompt);
  elSpBackend.addEventListener('input', saveSessionPrompt);

  // Project view toggle
  elBtnProject.addEventListener('click', toggleProjectView);

  // Context drawer
  elBtnContext.addEventListener('click', openDrawer);
  elBtnCtxCancel.addEventListener('click', cancelEdit);
  elBackdrop.addEventListener('click', closeDrawer);
  el('btn-close-context').addEventListener('click', closeDrawer);

  // Context add tabs
  document.querySelectorAll('.ctx-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ctx-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.drawer-add').forEach(d => d.style.display = 'none');
      el(`tab-${tab.dataset.tab}`).style.display = '';
    });
  });

  // Text context save
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

  // File context
  el('btn-add-files').addEventListener('click', async () => {
    const files = await window.api.openFiles();
    if (!files.length) return;
    contextEntries = await window.api.addFileContext(currentId, files);
    renderContextList();
  });

  // URL context
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

// ─── Session Prompt ───────────────────────────────────────────────────────────

function saveSessionPrompt() {
  const p = getProject(currentId);
  if (!p) return;
  p.sessionPrompt = {
    frontend: elSpFrontend.value,
    backend:  elSpBackend.value,
  };
  updateSpStatus(p.sessionPrompt);
  saveProjects();
}

function loadSessionPrompt(p) {
  const sp = p.sessionPrompt || {};
  elSpFrontend.value = sp.frontend || '';
  elSpBackend.value  = sp.backend  || '';
  updateSpStatus(sp);
}

function updateSpStatus(sp) {
  const fe = sp && sp.frontend && sp.frontend.trim();
  const be = sp && sp.backend  && sp.backend.trim();
  if (fe && be)  elSpStatus.textContent = '→ both';
  else if (fe)   elSpStatus.textContent = '→ frontend';
  else if (be)   elSpStatus.textContent = '→ backend';
  else           elSpStatus.textContent = '';
}

function getSessionPromptFor(role, p) {
  const sp = p.sessionPrompt;
  if (!sp) return null;
  const text = sp[role];
  return text && text.trim() ? text.trim() : null;
}

// ─── Context Drawer ───────────────────────────────────────────────────────────

// ─── Project View ─────────────────────────────────────────────────────────────

let projectViewOpen = false;

function toggleProjectView() {
  projectViewOpen = !projectViewOpen;
  el('project-view').style.display    = projectViewOpen ? '' : 'none';
  el('terminals-section') && (document.querySelector('.terminals-section').style.display = projectViewOpen ? 'none' : '');
  elBtnProject.classList.toggle('active', projectViewOpen);
  elBtnProject.textContent = projectViewOpen ? 'Terminals' : 'Project';
  if (projectViewOpen && currentId) {
    PM.init(currentId);
  } else {
    PANES.forEach(id => fitAddons[id] && fitAddons[id].fit());
  }
}

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
        // Switch to text tab
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
  projects.push({ id, name: 'New Project', frontend: '', backend: '' });
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
  elProjectName.value = p.name || '';
  updatePathDisplay('frontend', p.frontend);
  updatePathDisplay('backend',  p.backend);
  loadSessionPrompt(p);
  PANES.forEach(id => {
    setTermStatus(id, 'idle');
    el(`dot-${id}`).className = 'status-dot';
    el(`cwd-${id}`).textContent = '';
  });
}

function updatePathDisplay(role, dir) {
  const e = el(`${role}-path`);
  if (dir) {
    e.textContent = dir;
    e.classList.add('has-path');
    el(`cwd-${role}`).textContent = dir;
  } else {
    e.textContent = 'No directory selected';
    e.classList.remove('has-path');
    el(`cwd-${role}`).textContent = '';
  }
}

function setTermStatus(id, status) {
  const s = el(`status-${id}`);
  s.textContent = status;
  s.className = 'terminal-status ' + status;
}

// ─── Terminal Launch / Kill ───────────────────────────────────────────────────

async function launchTerminals() {
  const p = getProject(currentId);
  if (!p) return;
  if (!p.frontend || !p.backend) {
    alert('Please set both frontend and backend directories first.');
    return;
  }

  PANES.forEach(id => terms[id].clear());
  running = true;
  elBtnLaunch.disabled = true;
  elBtnKill.disabled = false;

  for (const role of PANES) {
    setTermStatus(role, 'running');
    el(`dot-${role}`).className = 'status-dot running';
    const prompt = getSessionPromptFor(role, p);
    await window.api.spawnTerminal(role, p[role], currentId, prompt);
  }
}

async function killTerminals() {
  for (const id of PANES) {
    await window.api.killTerminal(id);
    setTermStatus(id, 'idle');
    el(`dot-${id}`).className = 'status-dot';
  }
  running = false;
  elBtnLaunch.disabled = false;
  elBtnKill.disabled = true;
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
