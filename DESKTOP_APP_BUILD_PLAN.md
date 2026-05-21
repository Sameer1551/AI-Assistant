# May AI Assistant — Desktop App Build Plan

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main Process                    │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Tray Icon│  │ Window Mgmt  │  │ Native Integrations   │  │
│  │ & Menu   │  │ (HUD/Chat)   │  │ (Screen, Audio, FS)   │  │
│  └──────────┘  └──────────────┘  └───────────────────────┘  │
│                         │                                   │
│              ┌──────────┴──────────┐                        │
│              │   Service Bridge     │                       │
│              │  (IPC to Renderer)   │                       │
│              └──────────┬──────────┘                        │
│                         │                                   │
│  ┌──────────────────────┴────────────────────────────────┐  │
│  │              Backend Service Layer                    │  │
│  │  (Your existing 35+ services, wired together)         │  │
│  │                                                       │  │
│  │  LLM Gateway → Memory → Context Intelligence →        │  │
│  │  Cognitive State → Personality → Proactive Intel →    │  │
│  │  Goal Engine → Workflow → Control Service             │  │
│  └───────────────────────────────────────────────────────┘  │
│                         │                                   │
│              ┌──────────┴──────────┐                        │
│              │   Data Layer        │                        │
│              │  SQLite + Vector DB │                        │
│              └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │   Renderer Process    │
              │   (React + Tailwind)  │
              │                       │
              │  ┌─────────────────┐  │
              │  │  Chat Interface │  │
              │  │  Goal Dashboard │  │
              │  │  Settings Panel │  │
              │  │  HUD Overlay    │  │
              │  └─────────────────┘  │
              └───────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Desktop Shell | Electron 30+ | Cross-platform, native APIs, system tray |
| Frontend | React 18 + Tailwind CSS + Framer Motion | Fast UI dev, animations for HUD |
| Build Tool | Vite + electron-vite | Fast HMR, TypeScript native |
| State Management | Zustand | Lightweight, works great with Electron IPC |
| Database | better-sqlite3 (structured) + vectra (vectors) | Embedded, no external DB server needed |
| LLM Provider | OpenAI SDK + Anthropic SDK + Ollama (local) | Cloud + local model support |
| Voice STT | Whisper.cpp (local) or Deepgram (cloud) | Low latency transcription |
| Voice TTS | Piper (local) or ElevenLabs (cloud) | Natural speech synthesis |
| Wake Word | Porcupine (Picovoice) | Lightweight, offline wake word |
| Screen Context | active-win + screenshot-desktop | Know what user is doing |
| IPC | electron-trpc or custom typed IPC | Type-safe main↔renderer communication |
| Packaging | electron-builder | Installers for Win/Mac/Linux |

---

## Phase Plan (8 Phases)

---

## Phase 1: Electron Shell + System Tray (Days 1-2)

**Goal:** App launches, sits in system tray, opens a floating chat window.

### Files to Create

```
apps/desktop/
├── electron-vite.config.ts
├── package.json
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron main entry
│   │   ├── tray.ts               # System tray icon + menu
│   │   ├── windows.ts            # Window creation (chat, settings)
│   │   └── ipc-handlers.ts       # IPC bridge registration
│   ├── preload/
│   │   └── index.ts              # Secure preload script
│   └── renderer/
│       ├── index.html
│       ├── main.tsx              # React entry
│       ├── App.tsx
│       ├── components/
│       │   ├── ChatPanel.tsx
│       │   ├── MessageBubble.tsx
│       │   └── InputBar.tsx
│       └── styles/
│           └── globals.css       # Tailwind
├── resources/
│   ├── icon.png                  # App icon (256x256)
│   ├── tray-icon.png             # Tray icon (16x16 / 22x22)
│   └── tray-icon-active.png      # Tray icon when listening
```

### Key Behaviors
- App starts minimized to system tray
- Click tray icon → toggle floating chat window
- Chat window is frameless, always-on-top (optional), rounded corners
- Global hotkey (e.g., `Ctrl+Shift+Space`) to toggle chat
- Window remembers position between sessions
- Graceful quit from tray menu

### Dependencies to Install
```bash
npm create electron-vite@latest apps/desktop -- --template react-ts
cd apps/desktop
npm install react react-dom zustand framer-motion
npm install -D tailwindcss postcss autoprefixer @types/react
```

---

## Phase 2: LLM Integration + Chat (Days 3-5)

**Goal:** User can type messages and get AI responses via your LLM Gateway.

### Files to Create/Modify

```
apps/desktop/src/main/
├── services/
│   ├── llm-bridge.ts             # Connects to your LLM Gateway service
│   ├── model-config.ts           # API keys, model preferences
│   └── conversation-manager.ts   # Manages conversation history
```

### Architecture
```
User types message
  → Renderer sends via IPC: "chat:send"
  → Main process receives
  → Passes to LLM Gateway (your existing service)
  → LLM Gateway selects model (OpenAI/Anthropic/Ollama)
  → Streams response tokens back
  → Main process forwards chunks via IPC: "chat:stream-chunk"
  → Renderer displays streaming text
```

### Key Behaviors
- Streaming responses (token by token display)
- Model selection based on your multi-factor router (task complexity, cost, latency)
- Conversation history maintained in memory (persisted in Phase 4)
- System prompt injection from Personality Service
- Error handling: model unavailable → fallback chain
- Loading states, typing indicator

### LLM Provider Setup
```typescript
// apps/desktop/src/main/services/llm-bridge.ts
// Wire to your existing ModelRouter + provider abstraction
// Add real API calls:
//   - OpenAI: openai SDK
//   - Anthropic: @anthropic-ai/sdk
//   - Local: Ollama HTTP API (localhost:11434)
```

### Settings Needed
- API key input (stored encrypted via your Secrets Service pattern)
- Model preference (auto / specific model)
- Temperature, max tokens sliders

---

## Phase 3: Context Awareness (Days 6-8)

**Goal:** The assistant knows what you're doing — active app, file, project.

### Files to Create

```
apps/desktop/src/main/services/
├── context/
│   ├── active-window-monitor.ts   # Polls active window every 2s
│   ├── clipboard-monitor.ts       # Watches clipboard changes
│   ├── file-watcher.ts            # Watches active project files
│   ├── git-context.ts             # Current branch, recent commits
│   └── context-assembler.ts       # Assembles Context_Packet
```

### How It Works
```
Every 2-5 seconds:
  1. active-win → get current app name, window title
  2. If IDE detected → extract file path, language, project root
  3. If terminal → extract current directory, last command
  4. If browser → extract page title (from window title)
  5. Assemble into Context_Packet (your existing type)
  6. Inject into next LLM call as system context
```

### Key Behaviors
- Detect active application: VS Code, Chrome, Terminal, Slack, etc.
- Extract file path from IDE window titles
- Read git status of active project (branch, modified files)
- Clipboard content (last copied text, for "paste and explain" flows)
- All context is LOCAL only — never sent to cloud without user action
- Consent toggle: user can disable context monitoring

### Libraries
```bash
npm install active-win           # Get active window info
npm install chokidar             # File watching
npm install simple-git           # Git operations
```

### Context Packet Example
```json
{
  "active_app": "Visual Studio Code",
  "active_file": "/project/src/auth.ts",
  "language": "typescript",
  "git_branch": "feature/login",
  "git_modified_files": ["src/auth.ts", "src/routes.ts"],
  "project_root": "/project",
  "time_of_day": 14,
  "session_duration_minutes": 45
}
```

---

## Phase 4: Persistent Memory + Database (Days 9-11)

**Goal:** The assistant remembers past conversations, your preferences, and project context.

### Files to Create

```
apps/desktop/src/main/services/
├── database/
│   ├── sqlite-store.ts            # SQLite connection + migrations
│   ├── memory-store.ts            # Implements IMemoryStore with SQLite
│   ├── vector-store.ts            # Vectra for embeddings
│   ├── conversation-store.ts      # Chat history persistence
│   └── migrations/
│       ├── 001_init.sql
│       ├── 002_memory_layers.sql
│       └── 003_conversations.sql
```

### Database Schema (SQLite)
```sql
-- Conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT,
  updated_at TEXT,
  metadata JSON
);

-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  role TEXT CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT,
  model_used TEXT,
  tokens_used INTEGER,
  created_at TEXT
);

-- Memory (5 layers)
CREATE TABLE memory_records (
  record_id TEXT PRIMARY KEY,
  layer TEXT CHECK(layer IN ('Working', 'Episodic', 'Semantic', 'Procedural', 'Knowledge_Graph')),
  content TEXT,
  embedding BLOB,
  embedding_model TEXT,
  metadata JSON,
  access_count INTEGER DEFAULT 0,
  created_at TEXT,
  expires_at TEXT
);

-- Goals
CREATE TABLE goals (
  goal_id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  status TEXT,
  priority REAL,
  progress REAL,
  milestones JSON,
  created_at TEXT,
  last_progress_at TEXT
);

-- Settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### Key Behaviors
- Conversations persist across app restarts
- Memory records are searchable by semantic similarity (vector search)
- Your temporal weighting logic applies to memory retrieval
- Goals persist and track progress
- Settings (API keys, preferences) stored encrypted
- Database file lives in: `%APPDATA%/may-assistant/data.db` (Windows)

### Libraries
```bash
npm install better-sqlite3       # Embedded SQLite
npm install vectra               # Local vector database
npm install @xenova/transformers  # Local embeddings (all-MiniLM-L6-v2)
```

---

## Phase 5: Voice Interface (Days 12-15)

**Goal:** Wake word detection, voice input, and spoken responses.

### Files to Create

```
apps/desktop/src/main/services/
├── voice/
│   ├── wake-word-detector.ts      # "Hey May" detection
│   ├── speech-to-text.ts          # Audio → text
│   ├── text-to-speech.ts          # Text → audio
│   ├── audio-capture.ts           # Microphone access
│   └── audio-playback.ts          # Speaker output
```

### Architecture
```
Microphone → Wake Word Detector (always listening, low CPU)
  → On wake: "Hey May"
    → Start recording
    → Silence detection (1.5s pause = end of utterance)
    → Send audio to STT (Whisper local or Deepgram cloud)
    → Transcribed text → LLM Gateway
    → Response text → TTS (Piper local or ElevenLabs cloud)
    → Play audio through speakers
    → Return to wake word listening
```

### Key Behaviors
- Wake word runs locally (Porcupine) — no cloud, ~2% CPU
- Visual indicator in tray when listening (icon changes)
- Push-to-talk alternative (hold hotkey to speak)
- STT supports multiple languages
- TTS voice is configurable
- Consent: microphone access requires explicit opt-in
- Pause button immediately stops all audio capture

### Libraries
```bash
npm install @picovoice/porcupine-node  # Wake word
npm install @picovoice/pvrecorder-node # Audio capture
npm install whisper-node               # Local STT (or use Deepgram SDK)
npm install piper-tts                  # Local TTS (or ElevenLabs SDK)
```

### Offline Mode
- Wake word: always local (Porcupine)
- STT: Whisper.cpp runs locally
- TTS: Piper runs locally
- LLM: Ollama with local model (Llama 3, Mistral, etc.)

---

## Phase 6: Proactive Intelligence + HUD (Days 16-19)

**Goal:** The assistant proactively suggests things and adapts its UI to your state.

### Files to Create

```
apps/desktop/src/main/services/
├── proactive/
│   ├── signal-evaluator.ts        # Scores and filters signals
│   ├── calendar-watcher.ts        # Upcoming meetings/deadlines
│   ├── break-reminder.ts          # Focus break suggestions
│   └── error-detector.ts          # Detect repeated errors in terminal

apps/desktop/src/renderer/components/
├── HUD/
│   ├── HUDOverlay.tsx             # Floating overlay widget
│   ├── StatusIndicator.tsx        # Current state (idle/listening/thinking)
│   ├── SuggestionChip.tsx         # Proactive suggestion pill
│   ├── GoalWidget.tsx             # Mini goal progress tracker
│   └── FocusModeOverlay.tsx       # Minimal UI during deep focus
```

### Proactive Signals
```
Sources:
  - Calendar: "Meeting in 10 minutes with Design Team"
  - Habit: "You usually review PRs at this time"
  - Error: "Same test has failed 3 times — want me to look?"
  - Break: "You've been coding for 90 minutes — stretch?"
  - Goal: "Milestone 'API integration' is due tomorrow"

Delivery Rules (from your Proactive Intelligence Service):
  - Max 2 signals per hour (budget)
  - Suppress during deep focus unless urgency > 0.9
  - Score = urgency × relevance × recency
  - Only deliver if score > 0.65 threshold
  - Increase threshold after 3 dismissals
```

### HUD Overlay Behaviors
- Small floating widget (corner of screen)
- Shows: status icon + latest suggestion
- Expands on hover/click to show full suggestion
- Adapts to cognitive state:
  - Deep focus (focus > 0.75): minimal mode, hide suggestions
  - Low interruption tolerance (< 0.25): suppress all chips
  - Normal: show suggestion chips, goal progress
- Dismissible with single click/swipe

---

## Phase 7: Goal Tracking + Workflow (Days 20-22)

**Goal:** Users can set goals, track progress, and the assistant helps decompose and advance them.

### Files to Create

```
apps/desktop/src/renderer/components/
├── Goals/
│   ├── GoalList.tsx               # All goals with progress bars
│   ├── GoalDetail.tsx             # Single goal with milestones
│   ├── CreateGoalModal.tsx        # Natural language goal input
│   ├── WeeklyReview.tsx           # Weekly summary view
│   └── NextActionCard.tsx         # Suggested next action

apps/desktop/src/main/services/
├── goals/
│   ├── goal-bridge.ts             # Wires to your Goal Engine Service
│   └── weekly-review-scheduler.ts # Triggers weekly review
```

### User Flow
```
1. User says: "I want to launch my SaaS by March"
2. Assistant uses LLM to decompose into milestones:
   - Build landing page (5h)
   - Set up payment integration (8h)
   - Write documentation (4h)
   - Beta test with 10 users (12h)
3. Goal appears in sidebar with progress bar
4. Each day, assistant suggests next action based on:
   priority × inverse_progress × deadline_urgency
5. Weekly review summarizes progress, flags blockers
```

### Key Behaviors
- Natural language goal creation
- Auto-decomposition into 4-8 milestones (via LLM)
- Progress = completed_milestones / total_milestones
- Blocked detection (no progress for 7 days)
- Status transitions with audit trail
- Weekly review notification (Sunday evening or Monday morning)

---

## Phase 8: Settings, Polish, and Packaging (Days 23-26)

**Goal:** Production-ready app with settings, onboarding, and installers.

### Files to Create

```
apps/desktop/src/renderer/components/
├── Settings/
│   ├── SettingsPanel.tsx           # Main settings view
│   ├── APIKeySection.tsx           # LLM provider API keys
│   ├── VoiceSettings.tsx           # Wake word, TTS voice, STT language
│   ├── PrivacySettings.tsx         # Context monitoring toggles
│   ├── AppearanceSettings.tsx      # Theme, HUD position, hotkeys
│   └── ModelPreferences.tsx        # Routing strategy, preferred models

├── Onboarding/
│   ├── WelcomeScreen.tsx           # First launch
│   ├── APIKeySetup.tsx             # Enter API keys
│   ├── PermissionsSetup.tsx        # Grant microphone, screen access
│   └── PersonalitySetup.tsx        # Choose communication style
```

### Settings Categories
1. **LLM Providers**: API keys for OpenAI, Anthropic, local Ollama URL
2. **Voice**: Enable/disable, wake word sensitivity, TTS voice selection
3. **Privacy**: Context monitoring on/off, which apps to monitor, data retention
4. **Appearance**: Light/dark theme, HUD position, window opacity
5. **Hotkeys**: Toggle chat, push-to-talk, pause, quick actions
6. **Models**: Routing strategy (cost/quality/balanced), preferred models
7. **Goals**: Review schedule, blocked threshold days
8. **Advanced**: Database location, export data, reset

### Packaging
```bash
# electron-builder config in package.json
{
  "build": {
    "appId": "com.antigravity.may",
    "productName": "May AI Assistant",
    "win": {
      "target": ["nsis", "portable"],
      "icon": "resources/icon.ico"
    },
    "mac": {
      "target": ["dmg"],
      "icon": "resources/icon.icns"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "icon": "resources/icon.png"
    }
  }
}
```

### Auto-Update
```bash
npm install electron-updater
# Configure GitHub Releases as update source
```

---

## Data Flow Summary

```
┌───────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION                           │
│                                                                   │
│  Voice: "Hey May, what's blocking my API project?"                │
│  -OR-                                                             │
│  Text: types in chat panel                                        │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                     CONTEXT ASSEMBLY (2-5s cycle)                 │
│                                                                   │
│  Active App: "VS Code"                                            │
│  Active File: "src/api/routes.ts"                                 │
│  Git Branch: "feature/api-v2"                                     │
│  Time: 14:30, Session: 45min                                      │
│  Cognitive State: focus=0.6, fatigue=0.3                          │
│  Active Goals: "Launch SaaS by March" (progress: 40%)             │
│  Intent Graph: top 5 nodes injected                               │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                     LLM GATEWAY                                   │
│                                                                   │
│  System Prompt = Core Character                                   │
│    + Style Directive (from Personality Service)                   │
│    + Cognitive Directive ("be brief, user is focused")            │
│    + Context Packet (active app, file, git, goals)                │
│    + Intent Graph (top 5 priorities)                              │
│    + Memory (relevant past conversations)                         │
│                                                                   │
│  Model Selection: GPT-4o (complex query, high budget)             │
│  Fallback: Claude 3.5 → GPT-4o-mini → Local Llama                 │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                     RESPONSE + ACTIONS                            │
│                                                                   │
│  Text response streamed to chat                                   │
│  -OR-                                                             │
│  Action proposed: "Create a new test file for the API route"      │
│    → Risk Level: LOW → Execute immediately                        │
│    → Risk Level: HIGH → Show confirmation in HUD                  │
│                                                                   │
│  Memory updated: conversation stored in Episodic layer            │
│  Goal updated: if milestone completed                             │
└───────────────────────────────────────────────────────────────────┘
```

---

## File Structure (Final)

```
apps/desktop/
├── package.json
├── electron-vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.ts                   # Entry point
│   │   ├── tray.ts                    # System tray
│   │   ├── windows.ts                 # Window management
│   │   ├── ipc-handlers.ts           # IPC registration
│   │   ├── global-hotkeys.ts         # Keyboard shortcuts
│   │   └── services/
│   │       ├── service-container.ts   # DI container wiring all services
│   │       ├── llm-bridge.ts         # LLM provider connections
│   │       ├── conversation-manager.ts
│   │       ├── context/
│   │       │   ├── active-window-monitor.ts
│   │       │   ├── clipboard-monitor.ts
│   │       │   ├── git-context.ts
│   │       │   └── context-assembler.ts
│   │       ├── voice/
│   │       │   ├── wake-word-detector.ts
│   │       │   ├── speech-to-text.ts
│   │       │   ├── text-to-speech.ts
│   │       │   └── audio-capture.ts
│   │       ├── database/
│   │       │   ├── sqlite-store.ts
│   │       │   ├── vector-store.ts
│   │       │   └── migrations/
│   │       ├── proactive/
│   │       │   ├── signal-evaluator.ts
│   │       │   ├── calendar-watcher.ts
│   │       │   └── break-reminder.ts
│   │       └── goals/
│   │           ├── goal-bridge.ts
│   │           └── weekly-review-scheduler.ts
│   │
│   ├── preload/
│   │   └── index.ts                   # Secure bridge
│   │
│   └── renderer/                      # React UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── stores/
│       │   ├── chat-store.ts          # Zustand store for chat
│       │   ├── context-store.ts       # Current context state
│       │   ├── settings-store.ts      # User preferences
│       │   └── goal-store.ts          # Goals state
│       ├── components/
│       │   ├── Chat/
│       │   │   ├── ChatPanel.tsx
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── InputBar.tsx
│       │   │   ├── StreamingMessage.tsx
│       │   │   └── ConversationList.tsx
│       │   ├── HUD/
│       │   │   ├── HUDOverlay.tsx
│       │   │   ├── StatusIndicator.tsx
│       │   │   ├── SuggestionChip.tsx
│       │   │   └── FocusModeOverlay.tsx
│       │   ├── Goals/
│       │   │   ├── GoalList.tsx
│       │   │   ├── GoalDetail.tsx
│       │   │   ├── CreateGoalModal.tsx
│       │   │   └── NextActionCard.tsx
│       │   ├── Settings/
│       │   │   ├── SettingsPanel.tsx
│       │   │   ├── APIKeySection.tsx
│       │   │   ├── VoiceSettings.tsx
│       │   │   └── PrivacySettings.tsx
│       │   └── Onboarding/
│       │       ├── WelcomeScreen.tsx
│       │       └── SetupWizard.tsx
│       └── styles/
│           └── globals.css
│
├── resources/
│   ├── icon.png
│   ├── icon.ico
│   ├── tray-icon.png
│   ├── tray-icon-active.png
│   └── models/                        # Local model files (gitignored)
│       └── .gitkeep
│
└── electron-builder.config.js
```

---

## Integration with Existing Services

Your existing `services/` and `packages/` code is the business logic layer. The desktop app imports and uses it:

```typescript
// apps/desktop/src/main/services/service-container.ts

import { MemoryService } from '@may/memory';
import { CognitiveStateService } from '@may/cognitive-state';
import { PersonalityService } from '@may/personality';
import { ProactiveIntelligenceService } from '@may/proactive-intelligence';
import { GoalEngineService } from '@may/goal-engine';
import { IntentGraphService } from '@may/intent-graph';
import { ContextIntelligenceService } from '@may/context-intelligence';
import { ModelRouter } from '@may/llm-gateway';

// Wire everything together with real implementations
// replacing in-memory stores with SQLite/Vectra stores
```

---

## Priority Order (If Short on Time)

If you can only build some phases, here's what gives the most value:

1. **Phase 1 + 2** = Usable chat assistant in system tray (MVP)
2. **+ Phase 3** = Context-aware (knows what you're working on)
3. **+ Phase 4** = Remembers everything across sessions
4. **+ Phase 7** = Goal tracking makes it a productivity tool
5. **+ Phase 5** = Voice makes it feel like a real assistant
6. **+ Phase 6** = Proactive suggestions make it anticipatory
7. **+ Phase 8** = Polish for distribution

---

## Key Decisions to Make Before Starting

1. **LLM Provider**: Start with OpenAI (easiest SDK) or Ollama (free, local)?
2. **Voice**: Include from start or add later?
3. **Embedding Model**: Local (all-MiniLM-L6-v2 via @xenova/transformers) or cloud (OpenAI embeddings)?
4. **Window Style**: Frameless floating panel or standard window with title bar?
5. **Theme**: Dark-only for v1 or light/dark from start?

---

## Getting Started Command

```bash
# From your monorepo root
mkdir -p apps/desktop
cd apps/desktop
npm create electron-vite@latest . -- --template react-ts
npm install

# Add to root turbo.json
# Add apps/desktop to workspaces in root package.json

# Start developing
npm run dev
```

---

## Success Criteria for v1.0

- [ ] App launches to system tray on Windows/Mac
- [ ] Chat works with streaming responses
- [ ] Context shows current app/file in system prompt
- [ ] Conversations persist across restarts
- [ ] Memory search finds relevant past context
- [ ] Goals can be created and tracked
- [ ] At least one proactive signal type works (break reminder)
- [ ] Settings panel for API keys and preferences
- [ ] Installer works on Windows
- [ ] < 200MB RAM idle, < 5% CPU idle
