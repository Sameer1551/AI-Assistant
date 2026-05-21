import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { ChatService } from './services/chat-service'

let chatService: ChatService | null = null

export function registerIpcHandlers(): void {
  // Initialize chat service
  chatService = new ChatService()

  // Window controls
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.hide()
  })

  // Chat - send message and stream response
  ipcMain.handle('chat:send', async (event, messages: Array<{ role: string; content: string }>) => {
    if (!chatService) {
      return { error: 'Chat service not initialized' }
    }

    try {
      const response = await chatService.sendMessage(messages)
      return { content: response }
    } catch (error: any) {
      return { error: error.message || 'Failed to get response' }
    }
  })

  // Chat - stream response
  ipcMain.on(
    'chat:stream',
    async (event, messages: Array<{ role: string; content: string }>) => {
      if (!chatService) {
        event.sender.send('chat:stream-error', 'Chat service not initialized')
        return
      }

      try {
        await chatService.streamMessage(messages, (chunk: string) => {
          event.sender.send('chat:stream-chunk', chunk)
        })
        event.sender.send('chat:stream-end')
      } catch (error: any) {
        event.sender.send('chat:stream-error', error.message || 'Stream failed')
      }
    }
  )

  // Settings - get/set API key
  ipcMain.handle('settings:get-api-key', async () => {
    return chatService?.getApiKey() || ''
  })

  ipcMain.handle('settings:set-api-key', async (_event, apiKey: string) => {
    if (chatService) {
      chatService.setApiKey(apiKey)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('settings:get-model', async () => {
    return chatService?.getModel() || 'gpt-4o-mini'
  })

  ipcMain.handle('settings:set-model', async (_event, model: string) => {
    if (chatService) {
      chatService.setModel(model)
      return { success: true }
    }
    return { success: false }
  })

  // File operations - save file to desktop
  ipcMain.handle(
    'file:save-to-desktop',
    async (_event, filename: string, content: string) => {
      try {
        const desktopPath = join(homedir(), 'Desktop')
        const filePath = join(desktopPath, filename)
        writeFileSync(filePath, content, 'utf-8')
        return { success: true, path: filePath }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // File operations - save file with dialog
  ipcMain.handle(
    'file:save-with-dialog',
    async (event, defaultName: string, content: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, error: 'No window' }

      const result = await dialog.showSaveDialog(win, {
        defaultPath: join(homedir(), 'Desktop', defaultName),
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Text Files', extensions: ['txt', 'md'] },
          { name: 'Code Files', extensions: ['ts', 'js', 'py', 'html', 'css'] }
        ]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' }
      }

      try {
        const dir = join(result.filePath, '..')
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(result.filePath, content, 'utf-8')
        return { success: true, path: result.filePath }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // App info
  ipcMain.handle('app:get-version', async () => {
    return app.getVersion()
  })
}
