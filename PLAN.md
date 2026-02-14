# CharMemory — Development Plan

## Current State

Core functionality implemented:
- [x] Auto-extraction every N character messages
- [x] Data Bank file CRUD with `<memory>` tag format
- [x] Per-character auto-naming and optional per-chat memory files
- [x] Settings panel with 3 collapsible sections (main, Settings, Diagnostics)
- [x] Stats bar: file name + total bullet count
- [x] Memory Manager with grouped cards and per-bullet edit/delete
- [x] Memory consolidation (merge duplicates via LLM)
- [x] Clear All Memories with extraction state reset
- [x] Customizable extraction prompt with Restore Default
- [x] Extraction via Main LLM or WebLLM (browser-local)
- [x] Diagnostics panel (memory info, vectorization status, lorebook entries, extension prompts)
- [x] `/extract-memories`, `/consolidate-memories`, `/charmemory-debug` slash commands
- [x] Auto-migration from old `## Memory N` format and flat text
- [x] Guards: inApiCall, streaming check, context change detection

## Known Issues / To Investigate

- [ ] Test with group chats — currently only handles single character
- [ ] Test behavior when switching characters mid-extraction
- [ ] Test with very large memory files (performance of delete-then-reupload)
- [ ] Verify vectorization picks up file changes after re-upload (delete + upload cycle)

## Planned Improvements

### Next — Reliability & Polish

- [ ] Add error recovery if extraction fails mid-way (don't lose existing file)
- [ ] Persist diagnostics across page refreshes (save last N to chat_metadata)
- [ ] Add character name to memory file header for clarity
- [ ] Handle edge case: first message in a new chat (lastExtractedIndex = -1)
- [ ] Search within memories from the UI

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
- [ ] Log extraction history (what was extracted when, from which messages)
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
- **LLM calls**: `generateQuietPrompt` (main LLM) or `generateWebLlmChatPrompt` (WebLLM)
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
