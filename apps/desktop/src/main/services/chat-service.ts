import OpenAI from 'openai'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const SYSTEM_PROMPT = `You are May, a helpful AI assistant built into a desktop application. You are friendly, concise, and capable.

You can help users with:
- Writing text, documents, emails, and creative content
- Writing and explaining code in any programming language
- Answering questions and providing information
- Brainstorming ideas and problem-solving
- File operations (when the user asks you to save something)

When the user asks you to save/write a file, create code, or write text that should be saved, include a special marker in your response:
[SAVE_FILE: filename.ext]
content here
[/SAVE_FILE]

The app will detect this and offer to save it. Use appropriate file extensions (.txt for text, .py for Python, .js for JavaScript, .ts for TypeScript, .html for HTML, .md for Markdown, etc.)

Keep responses helpful and to the point. Use markdown formatting for readability.`

export class ChatService {
  private client: OpenAI | null = null
  private apiKey: string = ''
  private model: string = 'gpt-4o-mini'
  private configPath: string

  constructor() {
    const userDataPath = app.getPath('userData')
    this.configPath = join(userDataPath, 'config.json')
    this.loadConfig()
  }

  private loadConfig(): void {
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8'))
        this.apiKey = data.apiKey || ''
        this.model = data.model || 'gpt-4o-mini'
        if (this.apiKey) {
          this.initClient()
        }
      }
    } catch {
      // Config doesn't exist yet, that's fine
    }
  }

  private saveConfig(): void {
    try {
      const dir = join(this.configPath, '..')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(
        this.configPath,
        JSON.stringify({ apiKey: this.apiKey, model: this.model }, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('Failed to save config:', error)
    }
  }

  private initClient(): void {
    if (this.apiKey) {
      this.client = new OpenAI({ apiKey: this.apiKey })
    }
  }

  getApiKey(): string {
    // Return masked key for display
    if (!this.apiKey) return ''
    return this.apiKey.slice(0, 7) + '...' + this.apiKey.slice(-4)
  }

  setApiKey(key: string): void {
    this.apiKey = key
    this.initClient()
    this.saveConfig()
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
    this.saveConfig()
  }

  async sendMessage(messages: ChatMessage[]): Promise<string> {
    if (!this.client) {
      throw new Error(
        'API key not configured. Please set your OpenAI API key in Settings.'
      )
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: fullMessages,
      max_tokens: 4096,
      temperature: 0.7
    })

    return response.choices[0]?.message?.content || 'No response generated.'
  }

  async streamMessage(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void
  ): Promise<void> {
    if (!this.client) {
      throw new Error(
        'API key not configured. Please set your OpenAI API key in Settings.'
      )
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: fullMessages,
      max_tokens: 4096,
      temperature: 0.7,
      stream: true
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        onChunk(content)
      }
    }
  }
}
