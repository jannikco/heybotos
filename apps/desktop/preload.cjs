// The only bridge between the page and the desktop shell: a flag, a few messages, and the Mac's
// folder chooser.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('heybotosDesktop', {
  /** Close the quick-ask window and bring the main window forward on the conversation. */
  quickDone: () => ipcRenderer.send('quick-done'),
  quickCancel: () => ipcRenderer.send('quick-cancel'),
  /** The shell tells the page where to go (menu items, notification clicks). */
  onNavigate: (fn) => ipcRenderer.on('navigate', (_e, path) => fn(path)),
  onCommand: (fn) => ipcRenderer.on('command', (_e, name) => fn(name)),
  /** Let the owner point at a folder; resolves to its path, or null when they cancel. */
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
})

window.addEventListener('DOMContentLoaded', () => {
  // Lets the page leave room for the window buttons and make its top edge draggable.
  document.documentElement.dataset.desktop = '1'
})
