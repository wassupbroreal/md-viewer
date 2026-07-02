const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize:       () => ipcRenderer.invoke('win-minimize'),
  maximize:       () => ipcRenderer.invoke('win-maximize'),
  close:          () => ipcRenderer.invoke('win-close'),

  openDialog:     ()  => ipcRenderer.invoke('open-dialog'),
  openFile:       (p) => ipcRenderer.invoke('open-file', p),
  getRecent:      ()  => ipcRenderer.invoke('get-recent'),
  removeRecent:   (p) => ipcRenderer.invoke('remove-recent', p),
  showInExplorer: (p) => ipcRenderer.invoke('show-in-explorer', p),

  onLoading: (cb) => ipcRenderer.on('file-loading', ()      => cb()),
  onFile:    (cb) => ipcRenderer.on('file-loaded',  (_, d)  => cb(d)),
  onError:   (cb) => ipcRenderer.on('file-error',   (_, m)  => cb(m)),
});
