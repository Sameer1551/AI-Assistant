import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { ChatPanel } from './components/ChatPanel'
import { TitleBar } from './components/TitleBar'
import { SettingsPanel } from './components/SettingsPanel'
import { useSettingsStore } from './stores/settings-store'

function App(): JSX.Element {
  const { showSettings, loadSettings, isConfigured } = useSettingsStore()

  useEffect(() => {
    loadSettings()
  }, [])

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden rounded-2xl">
      {/* Main glass container */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="glass glow-primary flex h-full w-full flex-col overflow-hidden"
      >
        <TitleBar />

        {showSettings ? (
          <SettingsPanel />
        ) : !isConfigured ? (
          <WelcomeScreen />
        ) : (
          <ChatPanel />
        )}
      </motion.div>
    </div>
  )
}

function WelcomeScreen(): JSX.Element {
  const { setShowSettings } = useSettingsStore()

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="space-y-6"
      >
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-may-primary/20 border border-may-primary/30">
          <span className="text-4xl">🤖</span>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">Welcome to May</h1>
          <p className="mt-2 text-may-muted">
            Your AI assistant, right on your desktop.
          </p>
        </div>
        <p className="text-sm text-may-muted max-w-xs mx-auto">
          To get started, add your OpenAI API key. May can help you write text,
          code, save files, and more.
        </p>
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-xl bg-may-primary px-6 py-3 text-sm font-semibold text-black transition-all hover:scale-105 active:scale-95"
        >
          Set Up API Key
        </button>
      </motion.div>
    </div>
  )
}

export default App
