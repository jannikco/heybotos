// The only bridge between the page and the desktop shell: a flag, a few messages, and the system's
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
  /** Install the newer version: the app fetches it if needed, closes, replaces itself and opens again. Resolves to { ok, problem }. */
  installUpdate: () => ipcRenderer.invoke('install-update'),
})

window.addEventListener('DOMContentLoaded', () => {
  // On the Mac the page is its own title bar: it leaves room for the window buttons and its top edge
  // is what the window is dragged by. Elsewhere the window has the system's frame.
  document.documentElement.dataset.desktop = process.platform === 'darwin' ? 'mac' : 'framed'
})
