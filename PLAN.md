# CharMemory — Development Plan

## Current State

Core functionality implemented:
- [x] Auto-extraction every N character messages
- [x] Data Bank file CRUD with `<memory>` tag format
- [x] Per-character auto-naming and optional per-chat memory files
- [x] Settings panel with 3 collapsible sections (main, Settings, Diagnostics)
- [x] Stats bar: file name + total bullet count
- [x] Memory Manager with grouped cards and per-bullet edit/delete
- [x] Memory consolidation (merge duplicates via LLM) with preview and undo
- [x] Clear All Memories with extraction state reset
- [x] Customizable extraction prompt with Restore Default
- [x] Extraction via Main LLM, WebLLM (browser-local), or NanoGPT (direct API)
- [x] NanoGPT: API key test button, model filters (subscription, open source, roleplay, reasoning)
- [x] Activity Log panel with timestamped events for debugging
- [x] Diagnostics panel (memory info, vectorization status, lorebook entries, extension prompts)
- [x] `/extract-memories`, `/consolidate-memories`, `/charmemory-debug` slash commands
- [x] Auto-migration from old `## Memory N` format and flat text
- [x] Guards: inApiCall, streaming check, context change detection
- [x] Chat-switch awareness: seeds unextracted message count, only advances lastExtractedIndex on successful extraction
- [x] Auto-reset stale lastExtractedIndex when no memories exist for current chat

## Known Issues / To Investigate

- [ ] Test with group chats — currently only handles single character
- [ ] Test behavior when switching characters mid-extraction
- [ ] Test with very large memory files (performance of delete-then-reupload)
- [ ] Verify vectorization picks up file changes after re-upload (delete + upload cycle)
- [ ] Stats bar file status doesn't clear when "Clear All Memories" is used (display not refreshed)
- [ ] Verify NanoGPT API key is stored securely (currently in extension_settings, same as other ST credentials — check if ST encrypts at rest)

## Planned Improvements

### Next — UX & Polish

- [ ] Combine Activity Log and Diagnostics into a single unified panel
- [ ] Richer stats bar: show latest extraction count, chat name; make items clickable to open relevant views (memory manager, memory file, etc.)
- [ ] Fix stats bar not updating after "Clear All Memories"
- [ ] Search within memories from the UI
- [ ] Add error recovery if extraction fails mid-way (don't lose existing file)
- [ ] Add character name to memory file header for clarity

### Next — Multi-Provider LLM Support

- [ ] Design a provider abstraction so adding new LLM endpoints is straightforward
- [ ] Consider: OpenAI-compatible endpoints (user-provided URL + key), OpenRouter, local APIs (Ollama, LM Studio)
- [ ] Shared config pattern: URL, API key, model selector, test button
- [ ] Provider-specific options (temperature, system prompt override, etc.)

### Future — Smarter Extraction

- [ ] Memory categories/tags (relationships, events, facts, emotions)
- [ ] Configurable extraction triggers beyond message count (e.g., keyword-based)
- [ ] Multi-pass extraction: extract then verify/refine
- [ ] Extract relationship maps (character A's relationship with character B)
- [ ] Emotional state tracking over time
- [ ] Allow different extraction prompts per character
- [ ] Option to extract from user messages too (not just character)
- [ ] Export/import memories between characters

### Future — Diagnostics & Debugging

- [ ] Per-message diagnostic icon showing what was injected for that generation
- [ ] Diagnostic diff view: what changed between generations
- [x] Log extraction history (Activity Log panel)
- [ ] Show token count of current memory file

### Future Ideas (Not Yet Prioritized)

- [ ] Memory importance scoring (LLM rates importance, low-importance memories pruned first)
- [ ] Cross-character memories (shared world state)
- [ ] Memory conflict detection (contradictory facts)
- [ ] Integration with ST's built-in Summarize extension (use summary as extraction context)

## Architecture Notes

### File Structure

```
sillytavern-character-memory/
  manifest.json       # Extension metadata, loading_order: 100
  index.js            # Core logic: extraction, Data Bank ops, event hooks, slash commands
  settings.html       # Settings panel UI (drawer in Extensions tab)
  style.css           # Styling using ST theme variables
  README.md           # User-facing documentation
  PLAN.md             # This file
```

### Memory File Format

```
<memory chat="main_chat_abc123" date="2024-01-15 14:30">
- Alice grew up in a coastal village.
- She has two older brothers.
</memory>

<memory chat="consolidated" date="2024-01-16 10:00">
- Alice is afraid of thunderstorms.
</memory>
```

- Each `<memory>` block has `chat` (source chat ID or "consolidated"/"unknown") and `date` attributes
- Individual facts are stored as bullet points (`- `) inside each block
- Each bullet is one discrete memory; the block groups bullets from the same extraction

### Key Patterns Used

- **Data Bank CRUD**: delete-then-reupload pattern (matches ST's attachments/index.js)
- **Settings**: `extension_settings.charMemory` with defaults merge pattern
- **Per-chat state**: `chat_metadata.charMemory` with `saveMetadataDebounced()`
- **Event hooks**: `CHARACTER_MESSAGE_RENDERED` for counting, `WORLD_INFO_ACTIVATED` for diagnostics
- **LLM calls**: `generateQuietPrompt` (main LLM), `generateWebLlmChatPrompt` (WebLLM), or NanoGPT direct API
- **Output cleanup**: `removeReasoningFromString` to strip reasoning tags from LLM output
- **Guards**: `inApiCall` flag, `streamingProcessor.isFinished` check, context change detection

### Import Map (from extension location)

| Import | Resolves to |
|--------|------------|
| `../../../../script.js` | `/script.js` (main ST script) |
| `../../../extensions.js` | `/scripts/extensions.js` |
| `../../../chats.js` | `/scripts/chats.js` |
| `../../../utils.js` | `/scripts/utils.js` |
| `../../../reasoning.js` | `/scripts/reasoning.js` |
| `../../../popup.js` | `/scripts/popup.js` |
| `../../../slash-commands/SlashCommandParser.js` | `/scripts/slash-commands/SlashCommandParser.js` |
| `../../../slash-commands/SlashCommand.js` | `/scripts/slash-commands/SlashCommand.js` |
| `../../shared.js` | `/scripts/extensions/shared.js` |

### Key ST APIs Used

| API | Source | Purpose |
|-----|--------|---------|
| `generateQuietPrompt()` | script.js | Send extraction/consolidation prompt to LLM |
| `generateWebLlmChatPrompt()` | shared.js | Send prompt to browser-local WebLLM |
| `getRequestHeaders()` | script.js | Headers for ST API calls (vectorization check) |
| `getStringHash()` | utils.js | Hash file URL for vector collection ID |
| `getDataBankAttachmentsForSource()` | chats.js | Find memory file in character Data Bank |
| `getFileAttachment()` | chats.js | Read memory file content |
| `uploadFileAttachmentToServer()` | chats.js | Upload new/updated memory file |
| `deleteAttachment()` | chats.js | Delete old memory file before re-upload |
| `renderExtensionTemplateAsync()` | extensions.js | Load settings.html into Extensions panel |
| `removeReasoningFromString()` | reasoning.js | Strip reasoning tags from LLM output |
| `callGenericPopup()` | popup.js | Memory manager popup, edit/delete confirmations |
| `eventSource` / `event_types` | script.js | Hook into ST event system |
| `streamingProcessor` | script.js | Check if streaming is in progress |
| `substituteParamsExtended()` | script.js | Replace {{char}}, {{user}}, etc. in prompts |
