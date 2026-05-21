import { useState } from 'react'
import { Message } from '../stores/chat-store'

interface Props {
  message: Message
}

// Parse [SAVE_FILE: filename] blocks from assistant messages
function parseSaveBlocks(content: string): {
  text: string
  files: Array<{ filename: string; content: string }>
} {
  const files: Array<{ filename: string; content: string }> = []
  const regex = /\[SAVE_FILE:\s*(.+?)\]\n([\s\S]*?)\[\/SAVE_FILE\]/g
  let text = content

  let match
  while ((match = regex.exec(content)) !== null) {
    files.push({ filename: match[1].trim(), content: match[2].trim() })
    text = text.replace(match[0], '')
  }

  return { text: text.trim(), files }
}

// Simple markdown-like rendering
function renderContent(text: string): JSX.Element {
  // Handle code blocks
  const parts = text.split(/(```[\s\S]*?```)/g)

  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3, -3).split('\n')
          const lang = lines[0] || ''
          const code = lines.slice(1).join('\n') || lines.join('\n')
          return (
            <div key={i} className="relative group">
              {lang && (
                <div className="text-[10px] text-may-muted px-3 pt-2 pb-0 bg-black/30 rounded-t-lg border border-b-0 border-white/5">
                  {lang}
                </div>
              )}
              <pre
                className={`text-xs bg-black/30 p-3 overflow-x-auto border border-white/5 ${lang ? 'rounded-b-lg' : 'rounded-lg'}`}
              >
                <code>{code}</code>
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(code)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-[10px] px-2 py-1 rounded bg-white/10 text-may-muted hover:text-white transition-all"
              >
                Copy
              </button>
            </div>
          )
        }

        // Handle inline code
        const inlineParts = part.split(/(`[^`]+`)/g)
        return (
          <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">
            {inlineParts.map((inline, j) => {
              if (inline.startsWith('`') && inline.endsWith('`')) {
                return (
                  <code
                    key={j}
                    className="px-1.5 py-0.5 rounded bg-white/10 text-may-primary text-xs font-mono"
                  >
                    {inline.slice(1, -1)}
                  </code>
                )
              }
              // Handle bold
              return (
                <span
                  key={j}
                  dangerouslySetInnerHTML={{
                    __html: inline
                      .replace(
                        /\*\*(.+?)\*\*/g,
                        '<strong class="text-white font-semibold">$1</strong>'
                      )
                      .replace(/\n/g, '<br/>')
                  }}
                />
              )
            })}
          </p>
        )
      })}
    </div>
  )
}

export function MessageBubble({ message }: Props): JSX.Element {
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<Set<string>>(new Set())

  const isUser = message.role === 'user'
  const { text, files } = isUser
    ? { text: message.content, files: [] }
    : parseSaveBlocks(message.content)

  const handleSave = async (filename: string, content: string) => {
    setSaving(filename)
    const result = await window.api.saveToDesktop(filename, content)
    if (result.success) {
      setSaved((prev) => new Set([...prev, filename]))
    }
    setSaving(null)
  }

  const handleSaveAs = async (filename: string, content: string) => {
    setSaving(filename)
    await window.api.saveWithDialog(filename, content)
    setSaving(null)
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] px-4 py-3 ${isUser ? 'message-user' : 'message-assistant'}`}
      >
        {renderContent(text || message.content)}

        {message.isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-may-primary/70 animate-pulse ml-0.5 rounded-sm" />
        )}

        {/* File save buttons */}
        {files.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
            {files.map((file) => (
              <div
                key={file.filename}
                className="flex items-center gap-2 rounded-lg bg-white/5 p-2"
              >
                <span className="text-xs text-may-muted flex-1 truncate">
                  📄 {file.filename}
                </span>
                {saved.has(file.filename) ? (
                  <span className="text-[10px] text-green-400">✓ Saved</span>
                ) : (
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleSave(file.filename, file.content)}
                      disabled={saving === file.filename}
                      className="text-[10px] px-2 py-1 rounded bg-may-primary/20 text-may-primary hover:bg-may-primary/30 transition-colors disabled:opacity-50"
                    >
                      {saving === file.filename ? '...' : 'Save to Desktop'}
                    </button>
                    <button
                      onClick={() => handleSaveAs(file.filename, file.content)}
                      disabled={saving === file.filename}
                      className="text-[10px] px-2 py-1 rounded bg-white/10 text-may-muted hover:text-white transition-colors disabled:opacity-50"
                    >
                      Save As...
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
