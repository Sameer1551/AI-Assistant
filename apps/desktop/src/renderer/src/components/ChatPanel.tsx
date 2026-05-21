import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useChatStore, Message } from '../stores/chat-store'
import { MessageBubble } from './MessageBubble'

export function ChatPanel(): JSX.Element {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { messages, isLoading, error, addMessage, appendToMessage, setMessageStreaming, setLoading, setError, clearMessages } =
    useChatStore()

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const sendMessage = async () => {
    const trimmed = input.trim()
    if (!trimmed || isLoading) return

    setInput('')
    setError(null)

    // Add user message
    addMessage('user', trimmed)

    // Prepare messages for API
    const apiMessages = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: trimmed }
    ]

    // Add placeholder assistant message
    const assistantId = addMessage('assistant', '')
    setMessageStreaming(assistantId, true)
    setLoading(true)

    // Set up stream listeners
    const removeChunkListener = window.api.onStreamChunk((chunk: string) => {
      appendToMessage(assistantId, chunk)
    })

    const removeEndListener = window.api.onStreamEnd(() => {
      setMessageStreaming(assistantId, false)
      setLoading(false)
      cleanup()
    })

    const removeErrorListener = window.api.onStreamError((err: string) => {
      setMessageStreaming(assistantId, false)
      setLoading(false)
      setError(err)
      // If streaming failed, try non-streaming fallback
      fallbackSend(apiMessages, assistantId)
      cleanup()
    })

    function cleanup() {
      removeChunkListener()
      removeEndListener()
      removeErrorListener()
    }

    // Start streaming
    window.api.startStream(apiMessages)
  }

  const fallbackSend = async (
    apiMessages: Array<{ role: string; content: string }>,
    assistantId: string
  ) => {
    try {
      const result = await window.api.sendMessage(apiMessages)
      if (result.content) {
        const { updateMessage } = useChatStore.getState()
        updateMessage(assistantId, result.content)
      } else if (result.error) {
        setError(result.error)
      }
    } catch (e: any) {
      setError(e.message || 'Failed to send message')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center opacity-60">
            <span className="text-3xl mb-3">💬</span>
            <p className="text-sm text-may-muted">
              Ask me anything. I can write text, code, save files to your
              desktop, and more.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {[
                'Write a Python script',
                'Draft an email',
                'Explain async/await',
                'Save a note to desktop'
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion)
                    inputRef.current?.focus()
                  }}
                  className="text-xs px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-may-muted hover:text-white hover:border-may-primary/30 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <MessageBubble message={msg} />
            </motion.div>
          ))}
        </AnimatePresence>

        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mx-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400"
          >
            {error}
          </motion.div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-white/5 p-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask May anything..."
              rows={1}
              className="w-full resize-none rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm text-white placeholder-may-muted focus:border-may-primary/50 focus:outline-none focus:ring-1 focus:ring-may-primary/30 transition-colors"
              style={{ maxHeight: '120px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = 'auto'
                target.style.height = Math.min(target.scrollHeight, 120) + 'px'
              }}
            />
          </div>
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-may-primary text-black transition-all hover:scale-105 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
          >
            {isLoading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            )}
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={clearMessages}
            className="text-[10px] text-may-muted hover:text-white transition-colors"
          >
            Clear chat
          </button>
          <span className="text-[10px] text-may-muted">
            Shift+Enter for new line
          </span>
        </div>
      </div>
    </div>
  )
}
