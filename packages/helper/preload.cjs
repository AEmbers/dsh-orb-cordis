const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshOrb', {
  moveBy(dx, dy) {
    ipcRenderer.send('orb:move-by', { dx, dy })
  },
  setExpanded(expanded) {
    ipcRenderer.send('orb:expand', Boolean(expanded))
  },
  session() {
    return ipcRenderer.invoke('orb:session')
  },
  send(text) {
    ipcRenderer.send('orb:prompt', text)
  },
  onLine(callback) {
    ipcRenderer.on('orb:line', (_event, line) => callback(line))
  },
  onSession(callback) {
    ipcRenderer.on('orb:session', (_event, sessionId) => callback(sessionId))
  },
})
