# Batch Extraction & UX Rethink Design

## Goals

1. **Batch extraction** — extract memories from all (or selected) chats for a character, not just the active one
2. **Chunked extraction** — fix the current lossy behavior where messages beyond `maxMessages` are silently skipped; loop through all unprocessed messages in chunks
3. **Settings UX cleanup** — rename confusing labels, regroup settings logically, add tooltips

---

## Part 1: Chunked Extraction (core fix)

### Problem

Currently `collectRecentMessages()` skips older unprocessed messages when there are more than `maxMessagesPerExtraction`. If you have 100 unprocessed messages and max is 20, messages 1-80 are never extracted — `lastExtractedIndex` advances past them.

### Solution

Extraction loops through all unprocessed messages in chunks:

```
unprocessed = messages[lastExtractedIndex+1 .. end]
chunks = split unprocessed into groups of chunkSize
for each chunk:
    call LLM to extract memories
    advance lastExtractedIndex to end of chunk
    save progress
    if user cancelled: stop
```

- **Chunk size** = current `maxMessagesPerExtraction` slider (renamed to "Messages per LLM call")
- Progress is saved after each chunk, so cancellation doesn't lose work
- If total chunks > 3, show confirmation: "This will process N messages in ~X API calls. Continue?"
- A **Stop** button appears during multi-chunk extraction

### Applies to

- "Extract Now" button (single chat)
- "Extract Here" per-message button (single chat, up to clicked message)
- Batch extraction (multiple chats)
- Auto-extraction (usually just a few messages, single chunk, no confirmation needed)

---

## Part 2: Batch Extraction

### Data flow

1. Fetch chat list via `POST /api/characters/chats` with `{ avatar_url, simple: false }` — returns chat names, message counts, last message dates
2. User selects chats via checkboxes
3. For each selected chat:
   a. Load full chat via `POST /api/chats/get` with `{ avatar_url, file_name, ch_name }`
   b. Response: first element is metadata (skip), rest are messages
   c. Feed messages through chunked extraction (Part 1), using the loaded chat array instead of `context.chat`
   d. Tag extracted memories with the chat's ID
4. Show progress: "Extracting chat 3/12: adventure_chat (chunk 2/5)"

### Extraction state for non-active chats

- Active chat: uses `chat_metadata[MODULE_NAME].lastExtractedIndex` as today
- Non-active chats: no per-chat metadata available (it's only loaded for the active chat)
- Solution: store batch extraction state in the extension's own settings keyed by `charName:chatId`, e.g.:
  ```js
  extension_settings[MODULE_NAME].batchState = {
    "Alice:chat_abc123": { lastExtractedIndex: 45 },
    "Alice:chat_xyz789": { lastExtractedIndex: -1 }
  }
  ```
- On batch extract, check this state to skip already-processed messages
- When a chat is active and extracted normally, sync this state too

### UI — new "Batch Extract" tab

Located in the "Tools & Diagnostics" drawer, alongside Activity Log and Diagnostics tabs.

Contents:
- **Chat list** with columns: checkbox, chat name, message count, last active date, extraction status (extracted/partial/new)
- **Select All / None** toggle
- **"Extract Selected" button** — triggers batch extraction with confirmation popup
- **Progress bar** with current chat name, overall progress, and stop button
- Chat list is fetched on tab open, with a Refresh button

### Refactoring `collectRecentMessages` and `extractMemories`

These functions currently hardcode `context.chat` and `chat_metadata`. They need to accept parameters:

```js
// Before
function collectRecentMessages(endIndex = null)
// After
function collectRecentMessages(chatArray, lastExtractedIndex, endIndex = null)

// Before
async function extractMemories(force = false, endIndex = null)
// After
async function extractMemories({
  force = false,
  endIndex = null,
  chatArray = null,      // null = use context.chat
  chatId = null,         // null = use context.chatId
  onProgress = null,     // callback for progress updates
  signal = null          // AbortController signal for cancellation
} = {})
```

---

## Part 3: Settings UX Cleanup

### Main panel (always visible)

No change to:
- Stats bar
- Enable checkbox
- Action buttons (Extract Now, View/Edit, Consolidate, Undo)

**Move out** the two sliders (interval, cooldown) — these go into the Settings drawer.

### Settings drawer — regrouped

#### 1. LLM Provider
- **"LLM Provider"** dropdown (was "Extraction source")
  - Options: Main LLM, WebLLM, NanoGPT
- NanoGPT sub-settings (shown when NanoGPT selected) — no changes

#### 2. Auto-Extraction
- **"Extract after every ___ messages"** slider (was "Auto-extract every N new messages")
- **"Minimum wait between extractions: ___ min"** slider (was "Min. cooldown")
- Helper text: "These control when extraction runs automatically. Manual extraction and batch extraction ignore these settings."

#### 3. Extraction Settings
- **"Messages per LLM call: ___"** slider (was "Max messages per extraction")
  - Tooltip: "How many messages to include in each LLM call. The system loops through all unprocessed messages in chunks of this size."
- **"Max response length: ___ tokens"** slider (was "Response length")
  - Tooltip: "Maximum tokens the LLM can use for its response per chunk. Increase if extractions seem truncated."

#### 4. Storage
- Per-chat checkbox — no change
- File name override — no change

#### 5. Advanced
- Extraction prompt textarea — no change
- Reset Extraction State button — no change
- Clear All Memories button — no change

### Drawer rename

"Activity & Diagnostics" → **"Tools & Diagnostics"**

Tabs: **Batch Extract** | Activity Log | Diagnostics

---

## Summary of changes

| Area | Change |
|------|--------|
| Core extraction | Loop through chunks instead of skipping old messages |
| Core extraction | Confirmation popup for large extractions (>3 chunks) |
| Core extraction | Stop button for multi-chunk extraction |
| Core extraction | Refactor to accept chat array + chatId parameters |
| Batch extraction | New tab with chat list, selection, progress |
| Batch extraction | Server API calls to load non-active chats |
| Batch extraction | Per-chat extraction state in extension settings |
| Settings UX | "Extraction source" → "LLM Provider" |
| Settings UX | Move interval/cooldown sliders into Settings drawer |
| Settings UX | Regroup settings into logical sections |
| Settings UX | Better tooltips and helper text |
| Settings UX | Rename drawer to "Tools & Diagnostics" |
