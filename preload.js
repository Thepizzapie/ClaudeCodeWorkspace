const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dialogs
  openFolder: ()  => ipcRenderer.invoke('dialog:open-folder'),
  openFiles:  ()  => ipcRenderer.invoke('dialog:open-files'),

  // Terminals
  spawnTerminal: (id, cwd, projectId, sessionPrompt) => ipcRenderer.invoke('pty:spawn', { id, cwd, projectId, sessionPrompt }),
  writeTerminal: (id, data)           => ipcRenderer.send('pty:write', { id, data }),
  resizeTerminal: (id, cols, rows)    => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killTerminal: (id)                  => ipcRenderer.invoke('pty:kill', { id }),
  onTerminalData: (cb) => ipcRenderer.on('pty:data', (_, p) => cb(p)),
  onTerminalExit: (cb) => ipcRenderer.on('pty:exit', (_, p) => cb(p)),

  // Projects
  loadProjects:  ()         => ipcRenderer.invoke('projects:load'),
  saveProjects:  (projects) => ipcRenderer.invoke('projects:save', projects),

  // Web server
  startServer:    () => ipcRenderer.invoke('server:start'),
  stopServer:     () => ipcRenderer.invoke('server:stop'),
  setPanesConfig: (panes) => ipcRenderer.invoke('server:set-panes', panes),
  onServerStarted: (cb) => ipcRenderer.on('server:started', (_, p) => cb(p)),
  onServerStopped: (cb) => ipcRenderer.on('server:stopped', (_, p) => cb(p)),
  onServerClients: (cb) => ipcRenderer.on('server:clients', (_, n) => cb(n)),

  // Context
  loadContext:   (projectId)                          => ipcRenderer.invoke('context:load', projectId),
  addContext:      (projectId, title, content, type)         => ipcRenderer.invoke('context:add',       { projectId, title, content, contextType: type }),
  updateContext:   (projectId, id, title, content, type)     => ipcRenderer.invoke('context:update',    { projectId, id, title, content, contextType: type }),
  deleteContext:   (projectId, id)                           => ipcRenderer.invoke('context:delete',    { projectId, id }),
  addFileContext:  (projectId, filePaths)                    => ipcRenderer.invoke('context:add-files', { projectId, filePaths }),
  addUrlContext:   (projectId, title, url)                   => ipcRenderer.invoke('context:add-url',   { projectId, title, url }),
  onContextUpdated: (cb) => ipcRenderer.on('context:updated', (_, p) => cb(p)),

  // Project data
  loadProjectData:    (pid)               => ipcRenderer.invoke('project:load', pid),
  saveProjectSection: (pid, section, items) => ipcRenderer.invoke('project:save-section', { pid, section, items }),
});
