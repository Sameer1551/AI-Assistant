import { create } from 'zustand'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isStreaming?: boolean
}

interface ChatState {
  messages: Message[]
  isLoading: boolean
  error: string | null
  addMessage: (role: 'user' | 'assistant', content: string) => string
  updateMessage: (id: string, content: string) => void
  appendToMessage: (id: string, chunk: string) => void
  setMessageStreaming: (id: string, streaming: boolean) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearMessages: () => void
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  error: null,

  addMessage: (role, content) => {
    const id = generateId()
    set((state) => ({
      messages: [
        ...state.messages,
        { id, role, content, timestamp: Date.now(), isStreaming: false }
      ]
    }))
    return id
  },

  updateMessage: (id, content) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, content } : msg
      )
    }))
  },

  appendToMessage: (id, chunk) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, content: msg.content + chunk } : msg
      )
    }))
  },

  setMessageStreaming: (id, streaming) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, isStreaming: streaming } : msg
      )
    }))
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearMessages: () => set({ messages: [], error: null })
}))
