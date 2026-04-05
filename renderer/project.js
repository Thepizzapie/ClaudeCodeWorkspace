'use strict';

/* ── Project Module ───────────────────────────────────────────────────────────
   Manages the project view: tasks, worklogs, decisions, architecture,
   dependencies, logs, and history.
   Accessed via window.PM.
───────────────────────────────────────────────────────────────────────────── */

const PM = (() => {
  let projectId = null;
  let data = null;
  let activeTab = 'tasks';
  let taskFilter = 'all';

  const TABS = ['tasks', 'worklogs', 'decisions', 'architecture', 'dependencies', 'logs', 'history'];

  // ── helpers ────────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0,5);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function fmtMins(m) {
    if (!m) return '—';
    const h = Math.floor(m / 60), r = m % 60;
    return h > 0 ? `${h}h${r > 0 ? ` ${r}m` : ''}` : `${r}m`;
  }

  function parseDuration(s) {
    // Accept: "2h 30m", "90m", "1.5h", "90", "2h"
    s = s.trim().toLowerCase();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s);
    let mins = 0;
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
    const m = s.match(/(\d+)\s*m/);
    if (h) mins += parseFloat(h[1]) * 60;
    if (m) mins += parseInt(m[1]);
    return Math.round(mins) || 0;
  }

  function badge(cls, text) {
    return `<span class="badge ${esc(cls)}">${esc(text)}</span>`;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  }

  // ── data ──────────────────────────────────────────────────────────────────

  async function save(section) {
    data = await window.api.saveProjectSection(projectId, section, data[section]);
  }

  function addHistory(type, title, detail = '') {
    data.history.unshift({ id: newId(), type, title, detail, timestamp: new Date().toISOString() });
    if (data.history.length > 500) data.history = data.history.slice(0, 500);
  }

  // ── init ──────────────────────────────────────────────────────────────────

  async function init(pid) {
    projectId = pid;
    data = await window.api.loadProjectData(pid);
    renderShell();
    switchTab(activeTab);
  }

  function renderShell() {
    const view = el('project-view');
    view.innerHTML = `
      <div class="pv-tabbar">
        ${TABS.map(t => `<button class="pv-tab${t===activeTab?' active':''}" data-tab="${t}">${tabLabel(t)}</button>`).join('')}
      </div>
      <div class="pv-panel" id="pv-panel"></div>
    `;
    view.querySelectorAll('.pv-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function tabLabel(t) {
    return { tasks:'Tasks', worklogs:'Worklogs', decisions:'Decisions',
      architecture:'Architecture', dependencies:'Dependencies', logs:'Log', history:'History' }[t] || t;
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.pv-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const panel = el('pv-panel');
    if (!panel) return;
    renderers[tab]();
  }

  // ── TASKS ─────────────────────────────────────────────────────────────────

  function renderTasks() {
    const panel = el('pv-panel');
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <input  id="t-title" class="pv-input grow" placeholder="New task title..." spellcheck="false"/>
          <select id="t-priority" class="pv-select">
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <button id="t-add" class="pv-btn primary">Add Task</button>
        </div>
        <div class="pv-form-row" style="margin-top:6px">
          <textarea id="t-desc" class="pv-textarea" placeholder="Description (optional)..." rows="2"></textarea>
        </div>
      </div>
      <div class="pv-filters">
        ${['all','todo','in-progress','done','blocked'].map(s =>
          `<button class="pv-filter-btn${s===taskFilter?' active':''}" data-filter="${s}">${s==='all'?'All':capitalize(s)}</button>`
        ).join('')}
        <span style="margin-left:auto;font-size:11px;color:var(--text-mute)" id="t-count"></span>
      </div>
      <div class="pv-list" id="t-list"></div>
    `;

    panel.querySelectorAll('.pv-filter-btn').forEach(b => {
      b.addEventListener('click', () => { taskFilter = b.dataset.filter; renderTaskList(); });
    });

    el('t-add').addEventListener('click', async () => {
      const title = el('t-title').value.trim();
      if (!title) return;
      const task = { id: newId(), title, description: el('t-desc').value.trim(),
        status: 'todo', priority: el('t-priority').value,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.tasks.unshift(task);
      addHistory('task', `Added task: ${title}`);
      await save('tasks'); await save('history');
      el('t-title').value = ''; el('t-desc').value = '';
      renderTaskList();
    });

    el('t-title').addEventListener('keydown', e => { if (e.key === 'Enter') el('t-add').click(); });
    renderTaskList();
  }

  function renderTaskList() {
    const list = el('t-list');
    if (!list) return;
    const items = taskFilter === 'all' ? data.tasks : data.tasks.filter(t => t.status === taskFilter);
    el('t-count').textContent = `${items.length} task${items.length!==1?'s':''}`;
    if (!items.length) { list.innerHTML = `<div class="pv-empty">No ${taskFilter === 'all' ? '' : taskFilter + ' '}tasks.</div>`; return; }

    list.innerHTML = items.map(t => `
      <div class="pv-item" id="ti-${t.id}">
        <div class="pv-item-head" data-id="${t.id}">
          ${badge(t.priority, t.priority)}
          ${badge(t.status, t.status)}
          <span class="pv-item-title${t.status==='done'?' done':''}">${esc(t.title)}</span>
          <span class="pv-item-meta">${fmtDate(t.createdAt)}</span>
        </div>
        <div class="pv-item-body">
          ${t.description ? `<div class="pv-body-field"><div class="pv-body-label">Description</div><div class="pv-body-value">${esc(t.description)}</div></div>` : ''}
          <div class="pv-item-actions">
            ${t.status !== 'in-progress' && t.status !== 'done' ? `<button class="pv-btn success" data-action="start" data-id="${t.id}">Start</button>` : ''}
            ${t.status !== 'done' ? `<button class="pv-btn success" data-action="done" data-id="${t.id}">Complete</button>` : ''}
            ${t.status !== 'blocked' && t.status !== 'done' ? `<button class="pv-btn" data-action="block" data-id="${t.id}">Block</button>` : ''}
            ${t.status === 'done' || t.status === 'blocked' ? `<button class="pv-btn" data-action="reopen" data-id="${t.id}">Reopen</button>` : ''}
            <button class="pv-btn" data-action="edit-task" data-id="${t.id}">Edit</button>
            <button class="pv-btn danger" data-action="delete-task" data-id="${t.id}">Delete</button>
          </div>
          <div class="pv-inline-form" id="tedit-${t.id}" style="display:none">
            <input class="pv-input" id="te-title-${t.id}" value="${esc(t.title)}" spellcheck="false"/>
            <select class="pv-select" id="te-priority-${t.id}">
              ${['low','medium','high','critical'].map(p => `<option value="${p}"${p===t.priority?' selected':''}>${capitalize(p)}</option>`).join('')}
            </select>
            <textarea class="pv-textarea" id="te-desc-${t.id}" rows="3" spellcheck="false">${esc(t.description||'')}</textarea>
            <div class="pv-form-row"><button class="pv-btn primary" data-action="save-task" data-id="${t.id}">Save</button><button class="pv-btn" data-action="cancel-task" data-id="${t.id}">Cancel</button></div>
          </div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pv-item-head').forEach(h => {
      h.addEventListener('click', () => h.closest('.pv-item').classList.toggle('expanded'));
    });

    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); handleTaskAction(btn.dataset.action, btn.dataset.id); });
    });
  }

  async function handleTaskAction(action, id) {
    const task = data.tasks.find(t => t.id === id);
    if (!task) return;

    if (action === 'start')  { task.status = 'in-progress'; task.updatedAt = new Date().toISOString(); addHistory('task', `Started: ${task.title}`); }
    if (action === 'done')   { task.status = 'done'; task.updatedAt = new Date().toISOString(); addHistory('task', `Completed: ${task.title}`); }
    if (action === 'block')  { task.status = 'blocked'; task.updatedAt = new Date().toISOString(); addHistory('task', `Blocked: ${task.title}`); }
    if (action === 'reopen') { task.status = 'todo'; task.updatedAt = new Date().toISOString(); addHistory('task', `Reopened: ${task.title}`); }
    if (action === 'delete-task') {
      data.tasks = data.tasks.filter(t => t.id !== id);
      addHistory('task', `Deleted task: ${task.title}`);
      await save('tasks'); await save('history');
      return renderTaskList();
    }
    if (action === 'edit-task') {
      const form = el(`tedit-${id}`);
      form.style.display = form.style.display === 'none' ? '' : 'none';
      return;
    }
    if (action === 'cancel-task') { el(`tedit-${id}`).style.display = 'none'; return; }
    if (action === 'save-task') {
      task.title       = el(`te-title-${id}`).value.trim() || task.title;
      task.priority    = el(`te-priority-${id}`).value;
      task.description = el(`te-desc-${id}`).value.trim();
      task.updatedAt   = new Date().toISOString();
      addHistory('task', `Updated task: ${task.title}`);
    }

    await save('tasks'); await save('history');
    renderTaskList();
  }

  // ── WORKLOGS ───────────────────────────────────────────────────────────────

  function renderWorklogs() {
    const panel = el('pv-panel');
    const today = new Date().toISOString().slice(0, 10);
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <input  id="wl-desc" class="pv-input grow" placeholder="What did you work on?" spellcheck="false"/>
          <input  id="wl-dur"  class="pv-input" style="width:90px" placeholder="e.g. 1h 30m"/>
          <input  id="wl-date" class="pv-input" type="date" value="${today}" style="width:130px"/>
          <button id="wl-add"  class="pv-btn primary">Log</button>
        </div>
        <div class="pv-form-row" style="margin-top:6px">
          <input id="wl-tags" class="pv-input grow" placeholder="Tags (comma separated, optional)" spellcheck="false"/>
        </div>
      </div>
      <div class="worklog-stats" id="wl-stats"></div>
      <div class="pv-list" id="wl-list"></div>
    `;

    el('wl-add').addEventListener('click', async () => {
      const desc = el('wl-desc').value.trim();
      if (!desc) return;
      const mins  = parseDuration(el('wl-dur').value);
      const date  = el('wl-date').value || today;
      const tags  = el('wl-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      const entry = { id: newId(), description: desc, minutes: mins, date, tags, createdAt: new Date().toISOString() };
      data.worklogs.unshift(entry);
      addHistory('worklog', `Worklog: ${desc}`, mins ? fmtMins(mins) : '');
      await save('worklogs'); await save('history');
      el('wl-desc').value = ''; el('wl-dur').value = ''; el('wl-tags').value = '';
      renderWorklogList();
    });

    el('wl-desc').addEventListener('keydown', e => { if (e.key === 'Enter') el('wl-add').click(); });
    renderWorklogList();
  }

  function renderWorklogList() {
    const list = el('wl-list');
    const stats = el('wl-stats');
    if (!list) return;

    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000);
    const weekMins = data.worklogs
      .filter(w => new Date(w.date) >= weekAgo)
      .reduce((s, w) => s + (w.minutes || 0), 0);
    const totalMins = data.worklogs.reduce((s, w) => s + (w.minutes || 0), 0);

    if (stats) stats.innerHTML = `
      <span class="wl-stat">This week: <strong>${fmtMins(weekMins)}</strong></span>
      <span class="wl-stat">Total logged: <strong>${fmtMins(totalMins)}</strong></span>
      <span class="wl-stat">Entries: <strong>${data.worklogs.length}</strong></span>
    `;

    if (!data.worklogs.length) { list.innerHTML = '<div class="pv-empty">No work logged yet.</div>'; return; }

    list.innerHTML = data.worklogs.map(w => `
      <div class="pv-item" id="wli-${w.id}">
        <div class="pv-item-head" data-id="${w.id}">
          <span class="pv-item-meta" style="min-width:80px">${esc(w.date)}</span>
          ${w.minutes ? `<span class="badge note">${fmtMins(w.minutes)}</span>` : ''}
          <span class="pv-item-title">${esc(w.description)}</span>
          ${w.tags && w.tags.length ? `<span class="pv-item-meta">${w.tags.map(t=>`<span class="badge other">${esc(t)}</span>`).join(' ')}</span>` : ''}
          <button class="pv-btn danger" data-action="del-wl" data-id="${w.id}" style="font-size:10px;padding:1px 6px">×</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pv-item-head').forEach(h => {
      h.addEventListener('click', e => {
        if (e.target.dataset.action) return;
        h.closest('.pv-item').classList.toggle('expanded');
      });
    });

    list.querySelectorAll('[data-action="del-wl"]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        data.worklogs = data.worklogs.filter(w => w.id !== btn.dataset.id);
        await save('worklogs');
        renderWorklogList();
      });
    });
  }

  // ── DECISIONS ─────────────────────────────────────────────────────────────

  function renderDecisions() {
    const panel = el('pv-panel');
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <input id="d-title" class="pv-input grow" placeholder="Decision title / question..." spellcheck="false"/>
          <button id="d-add" class="pv-btn primary">Add Decision</button>
        </div>
        <div class="pv-form-row" style="margin-top:6px">
          <textarea id="d-ctx" class="pv-textarea" placeholder="Context / background (optional)..." rows="2"></textarea>
        </div>
      </div>
      <div class="pv-list" id="d-list"></div>
    `;
    el('d-add').addEventListener('click', async () => {
      const title = el('d-title').value.trim();
      if (!title) return;
      const dec = { id: newId(), title, context: el('d-ctx').value.trim(),
        options: [], chosen: '', rationale: '', status: 'open',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.decisions.unshift(dec);
      addHistory('decision', `New decision: ${title}`);
      await save('decisions'); await save('history');
      el('d-title').value = ''; el('d-ctx').value = '';
      renderDecisionList();
    });
    renderDecisionList();
  }

  function renderDecisionList() {
    const list = el('d-list');
    if (!list) return;
    if (!data.decisions.length) { list.innerHTML = '<div class="pv-empty">No decisions recorded yet.</div>'; return; }

    list.innerHTML = data.decisions.map(d => `
      <div class="pv-item" id="di-${d.id}">
        <div class="pv-item-head" data-id="${d.id}">
          ${badge(d.status, d.status)}
          <span class="pv-item-title">${esc(d.title)}</span>
          <span class="pv-item-meta">${fmtDate(d.createdAt)}</span>
        </div>
        <div class="pv-item-body">
          ${d.context ? `<div class="pv-body-field"><div class="pv-body-label">Context</div><div class="pv-body-value">${esc(d.context)}</div></div>` : ''}
          ${d.options.length ? `
            <div class="pv-body-field">
              <div class="pv-body-label">Options</div>
              <div class="decision-options">
                ${d.options.map((o,i) => `
                  <div class="decision-option${d.chosen===String(i)?' chosen':''}">
                    <div class="option-label">${esc(o.label)} ${d.chosen===String(i)?'✓ Chosen':''}</div>
                    ${o.pros ? `<div class="option-meta">+ ${esc(o.pros)}</div>` : ''}
                    ${o.cons ? `<div class="option-meta">− ${esc(o.cons)}</div>` : ''}
                  </div>`).join('')}
              </div>
            </div>` : ''}
          ${d.chosen !== '' && d.rationale ? `<div class="pv-body-field"><div class="pv-body-label">Rationale</div><div class="pv-body-value">${esc(d.rationale)}</div></div>` : ''}
          <div class="pv-item-actions">
            <button class="pv-btn" data-action="add-opt" data-id="${d.id}">Add Option</button>
            ${d.status === 'open' ? `<button class="pv-btn success" data-action="decide" data-id="${d.id}">Resolve</button>` : ''}
            ${d.status !== 'revisiting' ? `<button class="pv-btn" data-action="revisit" data-id="${d.id}">Revisit</button>` : ''}
            <button class="pv-btn danger" data-action="del-dec" data-id="${d.id}">Delete</button>
          </div>
          <div class="pv-inline-form" id="dadd-opt-${d.id}" style="display:none">
            <input class="pv-input" id="dopt-label-${d.id}" placeholder="Option label..." spellcheck="false"/>
            <div class="pv-form-grid-2">
              <input class="pv-input" id="dopt-pros-${d.id}"  placeholder="Pros (optional)" spellcheck="false"/>
              <input class="pv-input" id="dopt-cons-${d.id}"  placeholder="Cons (optional)" spellcheck="false"/>
            </div>
            <div class="pv-form-row"><button class="pv-btn primary" data-action="save-opt" data-id="${d.id}">Add</button></div>
          </div>
          <div class="pv-inline-form" id="dresolve-${d.id}" style="display:none">
            <div class="pv-body-label">Chosen option index (0-based)</div>
            <input class="pv-input" id="dchosen-${d.id}" placeholder="0, 1, 2... or leave blank"/>
            <textarea class="pv-textarea" id="drationale-${d.id}" placeholder="Rationale..." rows="2"></textarea>
            <div class="pv-form-row"><button class="pv-btn primary" data-action="save-resolve" data-id="${d.id}">Save</button></div>
          </div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.pv-item-head').forEach(h => {
      h.addEventListener('click', () => h.closest('.pv-item').classList.toggle('expanded'));
    });
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); handleDecisionAction(btn.dataset.action, btn.dataset.id); });
    });
  }

  async function handleDecisionAction(action, id) {
    const dec = data.decisions.find(d => d.id === id);
    if (!dec) return;
    if (action === 'add-opt')  { const f = el(`dadd-opt-${id}`); f.style.display = f.style.display==='none'?'':'none'; return; }
    if (action === 'decide')   { const f = el(`dresolve-${id}`); f.style.display = f.style.display==='none'?'':'none'; return; }
    if (action === 'revisit')  { dec.status = 'revisiting'; dec.updatedAt = new Date().toISOString(); addHistory('decision', `Revisiting: ${dec.title}`); }
    if (action === 'del-dec')  { data.decisions = data.decisions.filter(d => d.id !== id); addHistory('decision', `Deleted decision: ${dec.title}`); }
    if (action === 'save-opt') {
      const label = el(`dopt-label-${id}`).value.trim();
      if (!label) return;
      dec.options.push({ label, pros: el(`dopt-pros-${id}`).value.trim(), cons: el(`dopt-cons-${id}`).value.trim() });
      dec.updatedAt = new Date().toISOString();
      addHistory('decision', `Option added to: ${dec.title}`, label);
    }
    if (action === 'save-resolve') {
      dec.chosen    = el(`dchosen-${id}`).value.trim();
      dec.rationale = el(`drationale-${id}`).value.trim();
      dec.status    = 'decided';
      dec.updatedAt = new Date().toISOString();
      addHistory('decision', `Resolved: ${dec.title}`, dec.rationale.slice(0,80));
    }
    await save('decisions'); await save('history');
    renderDecisionList();
  }

  // ── ARCHITECTURE ──────────────────────────────────────────────────────────

  const ARCH_TYPES = ['service','database','api','frontend','library','infra','queue','other'];

  function renderArchitecture() {
    const panel = el('pv-panel');
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <input id="a-name" class="pv-input grow" placeholder="Component name..." spellcheck="false"/>
          <select id="a-type" class="pv-select">
            ${ARCH_TYPES.map(t => `<option value="${t}">${capitalize(t)}</option>`).join('')}
          </select>
          <input id="a-tech" class="pv-input" placeholder="Tech / language" style="width:120px" spellcheck="false"/>
          <button id="a-add" class="pv-btn primary">Add</button>
        </div>
        <div class="pv-form-row" style="margin-top:6px">
          <textarea id="a-desc" class="pv-textarea" placeholder="Description..." rows="2"></textarea>
        </div>
      </div>
      <div class="pv-list" id="a-list"></div>
    `;
    el('a-add').addEventListener('click', async () => {
      const name = el('a-name').value.trim();
      if (!name) return;
      const comp = { id: newId(), name, type: el('a-type').value, tech: el('a-tech').value.trim(),
        description: el('a-desc').value.trim(), dependsOn: [], notes: '',
        updatedAt: new Date().toISOString() };
      data.architecture.push(comp);
      addHistory('architecture', `Added component: ${name}`, comp.type);
      await save('architecture'); await save('history');
      el('a-name').value = ''; el('a-tech').value = ''; el('a-desc').value = '';
      renderArchList();
    });
    renderArchList();
  }

  function renderArchList() {
    const list = el('a-list');
    if (!list) return;
    if (!data.architecture.length) { list.innerHTML = '<div class="pv-empty">No architecture components mapped yet.</div>'; return; }
    list.innerHTML = data.architecture.map(c => `
      <div class="pv-item" id="ai-${c.id}">
        <div class="pv-item-head" data-id="${c.id}">
          ${badge(c.type, c.type)}
          <span class="pv-item-title">${esc(c.name)}</span>
          ${c.tech ? `<span class="pv-item-meta">${esc(c.tech)}</span>` : ''}
        </div>
        <div class="pv-item-body">
          ${c.description ? `<div class="pv-body-field"><div class="pv-body-label">Description</div><div class="pv-body-value">${esc(c.description)}</div></div>` : ''}
          ${c.dependsOn && c.dependsOn.length ? `<div class="pv-body-field"><div class="pv-body-label">Depends On</div><div class="pv-body-value">${esc(c.dependsOn.join(', '))}</div></div>` : ''}
          ${c.notes ? `<div class="pv-body-field"><div class="pv-body-label">Notes</div><div class="pv-body-value">${esc(c.notes)}</div></div>` : ''}
          <div class="pv-item-actions">
            <button class="pv-btn" data-action="edit-arch" data-id="${c.id}">Edit</button>
            <button class="pv-btn danger" data-action="del-arch" data-id="${c.id}">Delete</button>
          </div>
          <div class="pv-inline-form" id="aedit-${c.id}" style="display:none">
            <div class="pv-form-grid-2">
              <input class="pv-input" id="ae-name-${c.id}" value="${esc(c.name)}" spellcheck="false"/>
              <select class="pv-select" id="ae-type-${c.id}">
                ${ARCH_TYPES.map(t=>`<option value="${t}"${t===c.type?' selected':''}>${capitalize(t)}</option>`).join('')}
              </select>
              <input class="pv-input" id="ae-tech-${c.id}" value="${esc(c.tech||'')}" placeholder="Tech" spellcheck="false"/>
              <input class="pv-input" id="ae-deps-${c.id}" value="${esc((c.dependsOn||[]).join(', '))}" placeholder="Depends on (comma sep)" spellcheck="false"/>
            </div>
            <textarea class="pv-textarea" id="ae-desc-${c.id}" rows="2" spellcheck="false">${esc(c.description||'')}</textarea>
            <textarea class="pv-textarea" id="ae-notes-${c.id}" rows="2" placeholder="Notes..." spellcheck="false">${esc(c.notes||'')}</textarea>
            <div class="pv-form-row"><button class="pv-btn primary" data-action="save-arch" data-id="${c.id}">Save</button></div>
          </div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.pv-item-head').forEach(h => h.addEventListener('click', () => h.closest('.pv-item').classList.toggle('expanded')));
    list.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); handleArchAction(btn.dataset.action, btn.dataset.id); }));
  }

  async function handleArchAction(action, id) {
    const comp = data.architecture.find(c => c.id === id);
    if (!comp) return;
    if (action === 'edit-arch') { const f = el(`aedit-${id}`); f.style.display = f.style.display==='none'?'':'none'; return; }
    if (action === 'del-arch')  { data.architecture = data.architecture.filter(c => c.id !== id); addHistory('architecture', `Removed component: ${comp.name}`); }
    if (action === 'save-arch') {
      comp.name        = el(`ae-name-${id}`).value.trim() || comp.name;
      comp.type        = el(`ae-type-${id}`).value;
      comp.tech        = el(`ae-tech-${id}`).value.trim();
      comp.description = el(`ae-desc-${id}`).value.trim();
      comp.notes       = el(`ae-notes-${id}`).value.trim();
      comp.dependsOn   = el(`ae-deps-${id}`).value.split(',').map(s=>s.trim()).filter(Boolean);
      comp.updatedAt   = new Date().toISOString();
      addHistory('architecture', `Updated component: ${comp.name}`);
    }
    await save('architecture'); await save('history');
    renderArchList();
  }

  // ── DEPENDENCIES ─────────────────────────────────────────────────────────

  const ECOSYSTEMS = ['npm','pip','cargo','gem','other'];

  function renderDependencies() {
    const panel = el('pv-panel');
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <input id="dep-name" class="pv-input grow" placeholder="Package name..." spellcheck="false"/>
          <input id="dep-ver"  class="pv-input" style="width:90px" placeholder="Version" spellcheck="false"/>
          <select id="dep-eco" class="pv-select">
            ${ECOSYSTEMS.map(e=>`<option value="${e}">${e}</option>`).join('')}
          </select>
          <select id="dep-status" class="pv-select">
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="flagged">Flagged</option>
          </select>
          <button id="dep-add" class="pv-btn primary">Add</button>
        </div>
        <div class="pv-form-row" style="margin-top:6px">
          <input id="dep-notes" class="pv-input grow" placeholder="Review notes (optional)" spellcheck="false"/>
        </div>
      </div>
      <div class="pv-filters">
        ${['all','pending','approved','flagged','removed'].map(s =>
          `<button class="pv-filter-btn" data-dfilter="${s}">${s==='all'?'All':capitalize(s)}</button>`
        ).join('')}
      </div>
      <div class="pv-list" id="dep-list"></div>
    `;
    el('dep-add').addEventListener('click', async () => {
      const name = el('dep-name').value.trim();
      if (!name) return;
      const dep = { id: newId(), name, version: el('dep-ver').value.trim(),
        ecosystem: el('dep-eco').value, status: el('dep-status').value,
        notes: el('dep-notes').value.trim(), reviewedAt: new Date().toISOString() };
      data.dependencies.push(dep);
      addHistory('dependency', `${dep.status}: ${dep.name}@${dep.version||'*'}`, dep.ecosystem);
      await save('dependencies'); await save('history');
      el('dep-name').value=''; el('dep-ver').value=''; el('dep-notes').value='';
      renderDepList('all');
    });
    panel.querySelectorAll('[data-dfilter]').forEach(b => {
      b.addEventListener('click', () => { panel.querySelectorAll('[data-dfilter]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderDepList(b.dataset.dfilter); });
    });
    panel.querySelector('[data-dfilter="all"]').classList.add('active');
    renderDepList('all');
  }

  function renderDepList(filter) {
    const list = el('dep-list');
    if (!list) return;
    const items = filter === 'all' ? data.dependencies : data.dependencies.filter(d => d.status === filter);
    if (!items.length) { list.innerHTML = `<div class="pv-empty">No ${filter==='all'?'':filter+' '}dependencies.</div>`; return; }
    list.innerHTML = items.map(d => `
      <div class="pv-item">
        <div class="pv-item-head">
          ${badge(d.status, d.status)}
          ${badge(d.ecosystem, d.ecosystem)}
          <span class="pv-item-title">${esc(d.name)}${d.version?`<span style="color:var(--text-mute)"> @${esc(d.version)}</span>`:''}</span>
          ${d.notes ? `<span class="pv-item-meta">${esc(d.notes.slice(0,40))}</span>` : ''}
          <div style="display:flex;gap:4px;margin-left:auto">
            ${d.status !== 'approved' ? `<button class="pv-btn success" data-action="approve-dep" data-id="${d.id}" style="font-size:10px;padding:2px 7px">Approve</button>` : ''}
            ${d.status !== 'flagged'  ? `<button class="pv-btn danger"  data-action="flag-dep"    data-id="${d.id}" style="font-size:10px;padding:2px 7px">Flag</button>` : ''}
            <button class="pv-btn danger" data-action="del-dep" data-id="${d.id}" style="font-size:10px;padding:2px 7px">×</button>
          </div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      const dep = data.dependencies.find(d => d.id === btn.dataset.id);
      if (!dep) return;
      if (btn.dataset.action === 'approve-dep') { dep.status='approved'; dep.reviewedAt=new Date().toISOString(); addHistory('dependency',`Approved: ${dep.name}`); }
      if (btn.dataset.action === 'flag-dep')    { dep.status='flagged';  dep.reviewedAt=new Date().toISOString(); addHistory('dependency',`Flagged: ${dep.name}`); }
      if (btn.dataset.action === 'del-dep')     { data.dependencies=data.dependencies.filter(d=>d.id!==btn.dataset.id); addHistory('dependency',`Removed: ${dep.name}`); }
      await save('dependencies'); await save('history');
      renderDepList(filter);
    }));
  }

  // ── LOGS ──────────────────────────────────────────────────────────────────

  function renderLogs() {
    const panel = el('pv-panel');
    panel.innerHTML = `
      <div class="pv-add-form">
        <div class="pv-form-row">
          <select id="log-level" class="pv-select">
            <option value="info">Info</option>
            <option value="note">Note</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input id="log-msg" class="pv-input grow" placeholder="Log entry..." spellcheck="false"/>
          <button id="log-add" class="pv-btn primary">Log</button>
        </div>
      </div>
      <div class="pv-list" id="log-list"></div>
    `;
    el('log-add').addEventListener('click', async () => {
      const msg = el('log-msg').value.trim();
      if (!msg) return;
      const entry = { id: newId(), level: el('log-level').value, message: msg, timestamp: new Date().toISOString() };
      data.logs.unshift(entry);
      addHistory('log', `[${entry.level}] ${msg.slice(0,60)}`);
      await save('logs'); await save('history');
      el('log-msg').value = '';
      renderLogList();
    });
    el('log-msg').addEventListener('keydown', e => { if (e.key === 'Enter') el('log-add').click(); });
    renderLogList();
  }

  function renderLogList() {
    const list = el('log-list');
    if (!list) return;
    if (!data.logs.length) { list.innerHTML = '<div class="pv-empty">No log entries yet.</div>'; return; }
    list.innerHTML = data.logs.map(l => `
      <div class="pv-item">
        <div class="pv-item-head" style="cursor:default">
          ${badge(l.level, l.level)}
          <span class="pv-item-title">${esc(l.message)}</span>
          <span class="pv-item-meta">${fmt(l.timestamp)}</span>
          <button class="pv-btn danger" data-lid="${l.id}" style="font-size:10px;padding:1px 6px">×</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-lid]').forEach(btn => btn.addEventListener('click', async () => {
      data.logs = data.logs.filter(l => l.id !== btn.dataset.lid);
      await save('logs');
      renderLogList();
    }));
  }

  // ── HISTORY ───────────────────────────────────────────────────────────────

  function renderHistory() {
    const panel = el('pv-panel');
    panel.innerHTML = `<div class="pv-list" id="hist-list"></div>`;
    const list = el('hist-list');
    if (!data.history.length) { list.innerHTML = '<div class="pv-empty">No history yet. Actions across all tabs are recorded here automatically.</div>'; return; }
    list.innerHTML = data.history.map(h => `
      <div class="history-item">
        <div class="history-time">${fmt(h.timestamp)}</div>
        <div class="history-body">
          <div class="history-title">${badge(h.type, h.type)} ${esc(h.title)}</div>
          ${h.detail ? `<div class="history-detail">${esc(h.detail)}</div>` : ''}
        </div>
      </div>
    `).join('');
  }

  // ── renderers map ─────────────────────────────────────────────────────────

  const renderers = {
    tasks:        renderTasks,
    worklogs:     renderWorklogs,
    decisions:    renderDecisions,
    architecture: renderArchitecture,
    dependencies: renderDependencies,
    logs:         renderLogs,
    history:      renderHistory,
  };

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // ── public API ────────────────────────────────────────────────────────────

  return { init, switchTab };
})();
