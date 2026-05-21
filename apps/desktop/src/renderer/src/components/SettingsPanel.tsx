import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useSettingsStore } from '../stores/settings-store'

export function SettingsPanel(): JSX.Element {
  const { apiKey, model, setApiKey, setModel, setShowSettings, setIsConfigured } =
    useSettingsStore()
  const [localKey, setLocalKey] = useState('')
  const [localModel, setLocalModel] = useState(model)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    setLocalModel(model)
  }, [model])

  const handleSaveKey = async () => {
    if (!localKey.trim()) return
    const result = await window.api.setApiKey(localKey.trim())
    if (result.success) {
      setApiKey(localKey.trim().slice(0, 7) + '...' + localKey.trim().slice(-4))
      setIsConfigured(true)
      setStatus('API key saved successfully!')
      setLocalKey('')
      setTimeout(() => setStatus(null), 3000)
    }
  }

  const handleSaveModel = async () => {
    const result = await window.api.setModel(localModel)
    if (result.success) {
      setModel(localModel)
      setStatus('Model updated!')
      setTimeout(() => setStatus(null), 3000)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex-1 overflow-y-auto p-6 space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Settings</h2>
        <button
          onClick={() => setShowSettings(false)}
          className="text-xs text-may-muted hover:text-white transition-colors"
        >
          ← Back to Chat
        </button>
      </div>

      {status && (
        <div className="rounded-lg bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-400">
          {status}
        </div>
      )}

      {/* API Key */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-may-text">
          OpenAI API Key
        </label>
        {apiKey && (
          <p className="text-xs text-may-muted">
            Current: <span className="font-mono">{apiKey}</span>
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="password"
            value={localKey}
            onChange={(e) => setLocalKey(e.target.value)}
            placeholder="sk-..."
            className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder-may-muted focus:border-may-primary/50 focus:outline-none"
          />
          <button
            onClick={handleSaveKey}
            disabled={!localKey.trim()}
            className="rounded-lg bg-may-primary px-4 py-2 text-sm font-medium text-black disabled:opacity-30 hover:scale-105 active:scale-95 transition-all"
          >
            Save
          </button>
        </div>
        <p className="text-[10px] text-may-muted">
          Get your key from{' '}
          <span className="text-may-primary">platform.openai.com/api-keys</span>
        </p>
      </div>

      {/* Model Selection */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-may-text">Model</label>
        <div className="flex gap-2">
          <select
            value={localModel}
            onChange={(e) => setLocalModel(e.target.value)}
            className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white focus:border-may-primary/50 focus:outline-none appearance-none"
          >
            <option value="gpt-4o-mini">GPT-4o Mini (Fast, Cheap)</option>
            <option value="gpt-4o">GPT-4o (Best Quality)</option>
            <option value="gpt-4-turbo">GPT-4 Turbo</option>
            <option value="gpt-3.5-turbo">GPT-3.5 Turbo (Fastest)</option>
          </select>
          <button
            onClick={handleSaveModel}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20 transition-colors"
          >
            Update
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
        <h3 className="text-sm font-medium text-white">About May</h3>
        <p className="text-xs text-may-muted leading-relaxed">
          May is your local AI assistant. All conversations stay on your machine.
          Only the messages you send are transmitted to the OpenAI API for
          processing.
        </p>
        <div className="pt-2 space-y-1 text-xs text-may-muted">
          <p>
            <span className="text-may-primary">Ctrl+Shift+Space</span> — Toggle
            window
          </p>
          <p>
            <span className="text-may-primary">Enter</span> — Send message
          </p>
          <p>
            <span className="text-may-primary">Shift+Enter</span> — New line
          </p>
        </div>
      </div>
    </motion.div>
  )
}
