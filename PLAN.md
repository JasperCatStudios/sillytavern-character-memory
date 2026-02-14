# CharMemory — Development Plan

## Current State (v1.0)

Core functionality implemented:
- [x] Auto-extraction every N character messages
- [x] Data Bank file CRUD (char-memories.md)
- [x] Settings panel with 3 collapsible sections (Status, Diagnostics, Settings)
- [x] Customizable extraction prompt with Restore Default
- [x] `/extract-memories` slash command
- [x] `/charmemory-debug` slash command
- [x] Diagnostics panel (lorebook entries, extension prompts)
- [x] View Memories button
- [x] Guards: inApiCall, streaming check, context change detection

## Known Issues / To Investigate

- [ ] Test with group chats — currently only handles single character
- [ ] Verify Vector Storage actually picks up the Data Bank file for retrieval
- [ ] Test behavior when switching characters mid-extraction
- [ ] Confirm `deleteAttachment` with `confirm=false` doesn't trigger UI popup
- [ ] Test with very large memory files (performance of delete-then-reupload)

## Planned Improvements

### v1.1 — Reliability & Polish

- [ ] Add error recovery if extraction fails mid-way (don't lose existing file)
- [ ] Show toast with memory count/size after extraction
- [ ] Add "Clear Memories" button with confirmation
- [ ] Persist diagnostics across page refreshes (save last N to chat_metadata)
- [ ] Add character name to memory file header for clarity
- [ ] Handle edge case: first message in a new chat (lastExtractedIndex = -1)

### v1.2 — Memory Management

- [ ] Memory deduplication — detect and remove near-duplicate entries
- [ ] Memory consolidation command — summarize/compress old memories
- [ ] Memory categories/tags (relationships, events, facts, emotions)
- [ ] Search within memories from the UI
- [ ] Export/import memories between characters
- [ ] Memory pruning — remove memories older than N messages if file grows too large

### v1.3 — Smarter Extraction

- [ ] Configurable extraction triggers beyond message count (e.g., keyword-based)
- [ ] Multi-pass extraction: extract then verify/refine
- [ ] Extract relationship maps (character A's relationship with character B)
- [ ] Emotional state tracking over time
- [ ] Allow different extraction prompts per character
- [ ] Option to extract from user messages too (not just character)

### v1.4 — Diagnostics & Debugging

- [ ] Per-message diagnostic icon showing what was injected for that generation
- [ ] Diagnostic diff view: what changed between generations
- [ ] Log extraction history (what was extracted when, from which messages)
- [ ] Warn when Vector Storage is not enabled or not configured for Data Bank
- [ ] Show token count of current memory file

### Future Ideas (Not Yet Prioritized)

- [ ] Multiple memory files per character (e.g., by topic or time period)
- [ ] Memory importance scoring (LLM rates importance, low-importance memories pruned first)
- [ ] Cross-character memories (shared world state)
- [ ] Memory conflict detection (contradictory facts)
- [ ] Integration with ST's built-in Summarize extension (use summary as extraction context)
- [ ] WebSocket/SSE support for real-time memory updates in multi-user setups

## Architecture Notes

### File Structure

```
sillytavern-character-memory/
  manifest.json       # Extension metadata, loading_order: 100
  index.js            # Core logic: extraction, Data Bank ops, event hooks, slash commands
  settings.html       # Settings panel UI (drawer in Extensions tab)
  style.css           # Minimal styling using ST theme variables
  README.md           # User-facing documentation
  PLAN.md             # This file
```

### Key Patterns Used

- **Data Bank CRUD**: delete-then-reupload pattern (matches ST's attachments/index.js)
- **Settings**: `extension_settings.charMemory` with defaults merge pattern
- **Per-chat state**: `chat_metadata.charMemory` with `saveMetadataDebounced()`
- **Event hooks**: `CHARACTER_MESSAGE_RENDERED` for counting, `WORLD_INFO_ACTIVATED` for diagnostics
- **LLM calls**: `generateQuietPrompt` with object params, `removeReasoningFromString` cleanup
- **Guards**: `inApiCall` flag, `streamingProcessor.isFinished` check, context change detection

### Import Map (from extension location)

| Import | Resolves to |
|--------|------------|
| `../../../../script.js` | `/script.js` (main ST script) |
| `../../../extensions.js` | `/scripts/extensions.js` |
| `../../../chats.js` | `/scripts/chats.js` |
| `../../../reasoning.js` | `/scripts/reasoning.js` |
| `../../../slash-commands/SlashCommandParser.js` | `/scripts/slash-commands/SlashCommandParser.js` |
| `../../../slash-commands/SlashCommand.js` | `/scripts/slash-commands/SlashCommand.js` |

### Key ST APIs Used

| API | Source | Purpose |
|-----|--------|---------|
| `generateQuietPrompt()` | script.js | Send extraction prompt to LLM |
| `getDataBankAttachmentsForSource()` | chats.js | Find memory file in character Data Bank |
| `getFileAttachment()` | chats.js | Read memory file content |
| `uploadFileAttachmentToServer()` | chats.js | Upload new/updated memory file |
| `deleteAttachment()` | chats.js | Delete old memory file before re-upload |
| `renderExtensionTemplateAsync()` | extensions.js | Load settings.html into Extensions panel |
| `removeReasoningFromString()` | reasoning.js | Strip reasoning tags from LLM output |
| `eventSource` / `event_types` | script.js | Hook into ST event system |
| `streamingProcessor` | script.js | Check if streaming is in progress |
