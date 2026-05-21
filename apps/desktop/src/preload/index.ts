import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Chat
  sendMessage: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('chat:send', messages),

  startStream: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.send('chat:stream', messages),

  onStreamChunk: (callback: (chunk: string) => void) => {
    const handler = (_event: any, chunk: string) => callback(chunk)
    ipcRenderer.on('chat:stream-chunk', handler)
    return () => ipcRenderer.removeListener('chat:stream-chunk', handler)
  },

  onStreamEnd: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('chat:stream-end', handler)
    return () => ipcRenderer.removeListener('chat:stream-end', handler)
  },

  onStreamError: (callback: (error: string) => void) => {
    const handler = (_event: any, error: string) => callback(error)
    ipcRenderer.on('chat:stream-error', handler)
    return () => ipcRenderer.removeListener('chat:stream-error', handler)
  },

  // Settings
  getApiKey: () => ipcRenderer.invoke('settings:get-api-key'),
  setApiKey: (key: string) => ipcRenderer.invoke('settings:set-api-key', key),
  getModel: () => ipcRenderer.invoke('settings:get-model'),
  setModel: (model: string) => ipcRenderer.invoke('settings:set-model', model),

  // File operations
  saveToDesktop: (filename: string, content: string) =>
    ipcRenderer.invoke('file:save-to-desktop', filename, content),

  saveWithDialog: (defaultName: string, content: string) =>
    ipcRenderer.invoke('file:save-with-dialog', defaultName, content),

  // App
  getVersion: () => ipcRenderer.invoke('app:get-version')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
