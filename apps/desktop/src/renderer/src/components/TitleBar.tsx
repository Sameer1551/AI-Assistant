import { useSettingsStore } from '../stores/settings-store'

export function TitleBar(): JSX.Element {
  const { showSettings, setShowSettings } = useSettingsStore()

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 select-none app-drag">
      <div className="flex items-center gap-2 app-no-drag">
        <div className="h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse" />
        <span className="text-xs font-medium text-may-muted">May AI</span>
      </div>

      <div className="flex items-center gap-1 app-no-drag">
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="rounded-lg p-1.5 text-may-muted hover:bg-white/10 hover:text-white transition-colors"
          title="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          onClick={() => window.api.minimizeWindow()}
          className="rounded-lg p-1.5 text-may-muted hover:bg-white/10 hover:text-white transition-colors"
          title="Minimize"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          onClick={() => window.api.closeWindow()}
          className="rounded-lg p-1.5 text-may-muted hover:bg-white/10 hover:text-red-400 transition-colors"
          title="Close"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
