const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const MAX_CLIENTS = 5;
const WS_PORT = 3141;
const MCP_SERVER = path.join(__dirname, 'mcp', 'server.js');

let configPath;
let mainWindow;
const terminals = {};

// ─── Terminal output buffers ──────────────────────────────────────────────────
const termBuffers = {};
const BUFFER_MAX = 150 * 1024;

// ─── Web server state ─────────────────────────────────────────────────────────
let httpServer = null;
let wss = null;
const wsClients = new Set();
let serverToken = null;
let currentPanesConfig = null;

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'projects.json');
  createWindow();
});

app.on('window-all-closed', () => {
  Object.values(terminals).forEach(t => { try { t.kill(); } catch (_) {} });
  stopWebServer();
  if (process.platform !== 'darwin') app.quit();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastWS(msg) {
  const data = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ─── Context store ────────────────────────────────────────────────────────────

function contextDir() {
  const d = path.join(app.getPath('userData'), 'contexts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function contextPath(projectId) {
  return path.join(contextDir(), `${projectId}.json`);
}

function loadContext(projectId) {
  try {
    const p = contextPath(projectId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return { entries: [] };
}

function saveContext(projectId, store) {
  fs.writeFileSync(contextPath(projectId), JSON.stringify(store, null, 2));
}

// ─── MCP config ───────────────────────────────────────────────────────────────

function mcpConfigDir() {
  const d = path.join(app.getPath('userData'), 'mcp-configs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeMcpConfig(projectId) {
  const storePath    = contextPath(projectId);
  const projectStore = projectDataPath(projectId);
  const cfgPath = path.join(mcpConfigDir(), `${projectId}.json`);
  const cfg = {
    mcpServers: {
      'workspace-context': {
        command: process.execPath.includes('electron') ? 'node' : process.execPath,
        args: [MCP_SERVER, '--store', storePath, '--project', projectStore],
      },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// ─── Web server ───────────────────────────────────────────────────────────────

function startWebServer() {
  if (httpServer) return;

  serverToken = crypto.randomBytes(16).toString('hex');

  const expressApp = express();
  expressApp.use(express.json());

  expressApp.use('/xterm',          express.static(path.join(__dirname, 'node_modules/xterm')));
  expressApp.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/xterm-addon-fit')));
  expressApp.get('/', (req, res) => res.status(403).send('Access denied.'));
  expressApp.use(`/${serverToken}`, express.static(path.join(__dirname, 'web')));
  expressApp.use((req, res) => res.status(403).send('Access denied.'));

  httpServer = http.createServer(expressApp);
  wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const token = req.url.split('/')[1]?.split('?')[0];
    if (token !== serverToken) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (wsClients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Too Many Clients\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    wsClients.add(ws);
    sendToRenderer('server:clients', wsClients.size);

    // Replay pane config then terminal buffers
    if (currentPanesConfig) ws.send(JSON.stringify({ type: 'panes-config', panes: currentPanesConfig }));
    Object.entries(termBuffers).forEach(([id, buf]) => {
      if (buf) ws.send(JSON.stringify({ type: 'output', id, data: buf }));
    });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        const { type, id, data, cols, rows } = msg;

        if (type === 'input' && terminals[id]) terminals[id].write(data);
        if (type === 'resize' && terminals[id]) {
          try { terminals[id].resize(cols, rows); } catch (_) {}
        }

        // Context mutations from web clients
        if (type === 'context:add') handleWebContextAdd(ws, msg);
        if (type === 'context:delete') handleWebContextDelete(ws, msg);
      } catch (_) {}
    });

    ws.on('close', () => { wsClients.delete(ws); sendToRenderer('server:clients', wsClients.size); });
    ws.on('error', () => { wsClients.delete(ws); sendToRenderer('server:clients', wsClients.size); });
  });

  httpServer.listen(WS_PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    sendToRenderer('server:started', { port: WS_PORT, url: `http://${ip}:${WS_PORT}/${serverToken}` });
  });
}

function stopWebServer() {
  wsClients.forEach(ws => { try { ws.close(); } catch (_) {} });
  wsClients.clear();
  if (httpServer) { httpServer.close(); httpServer = null; wss = null; }
  sendToRenderer('server:stopped', {});
}

// ─── Web context handlers ─────────────────────────────────────────────────────

function handleWebContextAdd(ws, { projectId, title, content, contextType }) {
  if (!projectId || !title || !content) return;
  const store = loadContext(projectId);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title, content,
    type: contextType || 'note',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.entries.push(entry);
  saveContext(projectId, store);
  // Notify Electron UI and all web clients
  sendToRenderer('context:updated', { projectId, entries: store.entries });
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
}

function handleWebContextDelete(ws, { projectId, id }) {
  if (!projectId || !id) return;
  const store = loadContext(projectId);
  store.entries = store.entries.filter(e => e.id !== id);
  saveContext(projectId, store);
  sendToRenderer('context:updated', { projectId, entries: store.entries });
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
}

// ─── IPC: Server ─────────────────────────────────────────────────────────────

ipcMain.handle('server:start', () => { startWebServer(); return WS_PORT; });
ipcMain.handle('server:stop',  () => { stopWebServer(); });
ipcMain.handle('server:set-panes', (event, panes) => {
  currentPanesConfig = panes;
  broadcastWS({ type: 'panes-config', panes });
});

// ─── IPC: Dialogs ─────────────────────────────────────────────────────────────

ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

// ─── IPC: PTY ────────────────────────────────────────────────────────────────

ipcMain.handle('pty:spawn', (event, { id, cwd, projectId, sessionPrompt }) => {
  if (terminals[id]) {
    try { terminals[id].kill(); } catch (_) {}
    delete terminals[id];
  }

  termBuffers[id] = '';

  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const args  = process.platform === 'win32' ? ['-NoLogo'] : [];

  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-color' },
  });

  terminals[id] = ptyProcess;

  ptyProcess.onData(data => {
    termBuffers[id] = (termBuffers[id] + data).slice(-BUFFER_MAX);
    sendToRenderer('pty:data', { id, data });
    broadcastWS({ type: 'output', id, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    delete terminals[id];
    sendToRenderer('pty:exit', { id, exitCode });
    broadcastWS({ type: 'exit', id, exitCode });
  });

  setTimeout(() => {
    if (!terminals[id]) return;
    if (projectId) {
      const mcpCfg = writeMcpConfig(projectId);
      const cfgArg = process.platform === 'win32'
        ? mcpCfg.replace(/\\/g, '\\\\')
        : mcpCfg;
      ptyProcess.write(`claude --mcp-config "${cfgArg}"\r`);
    } else {
      ptyProcess.write('claude\r');
    }
    // Send session prompt after Claude finishes starting up
    if (sessionPrompt && sessionPrompt.trim()) {
      setTimeout(() => {
        if (terminals[id]) ptyProcess.write(sessionPrompt.trim() + '\r');
      }, 5000);
    }
  }, 600);

  return true;
});

ipcMain.on('pty:write',  (event, { id, data }) => { if (terminals[id]) terminals[id].write(data); });
ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
  if (terminals[id]) { try { terminals[id].resize(cols, rows); } catch (_) {} }
});
ipcMain.handle('pty:kill', (event, { id }) => {
  if (terminals[id]) { try { terminals[id].kill(); } catch (_) {} delete terminals[id]; }
  return true;
});

// ─── IPC: Projects ────────────────────────────────────────────────────────────

ipcMain.handle('projects:load', () => {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}
  return [];
});

ipcMain.handle('projects:save', (event, projects) => {
  try { fs.writeFileSync(configPath, JSON.stringify(projects, null, 2)); return true; }
  catch (_) { return false; }
});

// ─── IPC: Context ─────────────────────────────────────────────────────────────

ipcMain.handle('context:load', (event, projectId) => {
  return loadContext(projectId).entries;
});

ipcMain.handle('context:add', (event, { projectId, title, content, contextType }) => {
  const store = loadContext(projectId);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title, content,
    type: contextType || 'note',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.entries.push(entry);
  saveContext(projectId, store);
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
  return store.entries;
});

ipcMain.handle('context:update', (event, { projectId, id, title, content, contextType }) => {
  const store = loadContext(projectId);
  const entry = store.entries.find(e => e.id === id);
  if (!entry) return store.entries;
  if (title   !== undefined) entry.title   = title;
  if (content !== undefined) entry.content = content;
  if (contextType !== undefined) entry.type = contextType;
  entry.updatedAt = new Date().toISOString();
  saveContext(projectId, store);
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
  return store.entries;
});

ipcMain.handle('context:delete', (event, { projectId, id }) => {
  const store = loadContext(projectId);
  store.entries = store.entries.filter(e => e.id !== id);
  saveContext(projectId, store);
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
  return store.entries;
});

ipcMain.handle('context:add-files', (event, { projectId, filePaths }) => {
  const store = loadContext(projectId);
  for (const fp of filePaths) {
    store.entries.push({
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title:     path.basename(fp),
      path:      fp,
      type:      'file',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  saveContext(projectId, store);
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
  return store.entries;
});

ipcMain.handle('context:add-url', (event, { projectId, title, url }) => {
  const store = loadContext(projectId);
  store.entries.push({
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title:     title || url,
    url,
    type:      'url',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveContext(projectId, store);
  broadcastWS({ type: 'context:sync', projectId, entries: store.entries });
  return store.entries;
});

// ─── Project data store ────────────────────────────────────────────────────────

const PROJECT_DATA_DEFAULTS = {
  tasks: [], worklogs: [], decisions: [], architecture: [],
  dependencies: [], logs: [], history: [],
};

function projectDataDir() {
  const d = path.join(app.getPath('userData'), 'project-data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function projectDataPath(pid) {
  return path.join(projectDataDir(), `${pid}.json`);
}

function loadProjectData(pid) {
  try {
    const p = projectDataPath(pid);
    if (fs.existsSync(p)) return { ...PROJECT_DATA_DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (_) {}
  return { ...PROJECT_DATA_DEFAULTS };
}

function saveProjectData(pid, data) {
  fs.writeFileSync(projectDataPath(pid), JSON.stringify(data, null, 2));
}

// ─── IPC: Project data ────────────────────────────────────────────────────────

ipcMain.handle('project:load', (event, pid) => {
  return loadProjectData(pid);
});

ipcMain.handle('project:save-section', (event, { pid, section, items }) => {
  const data = loadProjectData(pid);
  if (section in data) data[section] = items;
  saveProjectData(pid, data);
  return data;
});
