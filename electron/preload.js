const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aihelper', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  chat: (payload) => ipcRenderer.invoke('agent:chat', payload),
  abort: () => ipcRenderer.invoke('agent:abort'),
  testProvider: (key) => ipcRenderer.invoke('agent:testProvider', key),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectFile: (filters) => ipcRenderer.invoke('dialog:selectFile', filters),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getPaths: () => ipcRenderer.invoke('app:getPaths'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getLogStatus: () => ipcRenderer.invoke('logs:status'),
  openLogDir: () => ipcRenderer.invoke('logs:openDir'),
  logUi: (event, data) => {
    try {
      ipcRenderer.send('logs:ui', { event, data });
    } catch (_) {}
  },
  // 多轮会话
  listSessions: () => ipcRenderer.invoke('session:list'),
  getCurrentSession: () => ipcRenderer.invoke('session:current'),
  createSession: (meta) => ipcRenderer.invoke('session:create', meta),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  saveSession: (sess) => ipcRenderer.invoke('session:save', sess),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  openSessionDir: () => ipcRenderer.invoke('session:openDir'),
  browserState: () => ipcRenderer.invoke('browser:state'),
  recordStatus: () => ipcRenderer.invoke('browser:recordStatus'),
  recordStart: (args) => ipcRenderer.invoke('browser:recordStart', args),
  recordStop: (args) => ipcRenderer.invoke('browser:recordStop', args),
  mailTest: () => ipcRenderer.invoke('mail:test'),
  onAgentEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  }
});
