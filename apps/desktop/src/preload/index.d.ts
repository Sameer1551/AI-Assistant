import { ElectronAPI } from '@electron-toolkit/preload'

interface MayAPI {
  minimizeWindow: () => void
  closeWindow: () => void
  sendMessage: (
    messages: Array<{ role: string; content: string }>
  ) => Promise<{ content?: string; error?: string }>
  startStream: (messages: Array<{ role: string; content: string }>) => void
  onStreamChunk: (callback: (chunk: string) => void) => () => void
  onStreamEnd: (callback: () => void) => () => void
  onStreamError: (callback: (error: string) => void) => () => void
  getApiKey: () => Promise<string>
  setApiKey: (key: string) => Promise<{ success: boolean }>
  getModel: () => Promise<string>
  setModel: (model: string) => Promise<{ success: boolean }>
  saveToDesktop: (
    filename: string,
    content: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  saveWithDialog: (
    defaultName: string,
    content: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  getVersion: () => Promise<string>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: MayAPI
  }
}
