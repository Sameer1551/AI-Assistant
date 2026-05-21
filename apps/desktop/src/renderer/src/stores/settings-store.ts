import { create } from 'zustand'

interface SettingsState {
  apiKey: string
  model: string
  showSettings: boolean
  isConfigured: boolean
  setApiKey: (key: string) => void
  setModel: (model: string) => void
  setShowSettings: (show: boolean) => void
  setIsConfigured: (configured: boolean) => void
  loadSettings: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKey: '',
  model: 'gpt-4o-mini',
  showSettings: false,
  isConfigured: false,

  setApiKey: (key) => set({ apiKey: key }),
  setModel: (model) => set({ model }),
  setShowSettings: (show) => set({ showSettings: show }),
  setIsConfigured: (configured) => set({ isConfigured: configured }),

  loadSettings: async () => {
    try {
      const apiKey = await window.api.getApiKey()
      const model = await window.api.getModel()
      set({
        apiKey: apiKey || '',
        model: model || 'gpt-4o-mini',
        isConfigured: !!apiKey
      })
    } catch {
      // Settings not available yet
    }
  }
}))
