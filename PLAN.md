# CharMemory — Development Plan

## Current State

Core functionality implemented:
- [x] Auto-extraction every N character messages
- [x] Data Bank file CRUD with `<memory>` tag format
- [x] Per-character auto-naming and optional per-chat memory files
- [x] Settings panel with collapsible sections (main, Settings, Activity & Diagnostics)
- [x] Stats bar: file name, memory count, extraction progress, cooldown timer
- [x] Memory Manager with grouped cards and per-bullet edit/delete
- [x] Memory consolidation (merge duplicates via LLM) with preview and undo
- [x] Clear All Memories with extraction state reset
- [x] Customizable extraction prompt with Restore Default
- [x] Extraction via Main LLM, WebLLM (browser-local), or NanoGPT (direct API)
- [x] NanoGPT: API key test button, model filters (subscription, open source, roleplay, reasoning)
- [x] Activity Log + Diagnostics in a combined tabbed panel
- [x] `/extract-memories`, `/consolidate-memories`, `/charmemory-debug` slash commands
- [x] Auto-migration from old `## Memory N` format and flat text
- [x] Guards: inApiCall, streaming check, context change detection
- [x] Chat-switch awareness: seeds unextracted message count, only advances lastExtractedIndex on successful extraction
- [x] Auto-reset stale lastExtractedIndex when no memories exist for current chat
- [x] Extraction cooldown (min. time between auto-extractions, manual bypasses)
- [x] Per-message buttons (Extract Here, Pin as Memory) on both new and existing messages
- [x] Improved extraction prompt: FOCUS/AVOID lists, boundary markers to prevent existing memory contamination, past tense, vivid details without play-by-play
- [x] Tooltips on all UI elements
- [x] Helpful toast messages (e.g., "no unprocessed messages" suggests Reset Extraction State)

## Known Issues / To Investigate

- [ ] Test with group chats — currently only handles single character
- [ ] Test behavior when switching characters mid-extraction
- [ ] Test with very large memory files (performance of delete-then-reupload)
- [x] Verify vectorization picks up file changes after re-upload (delete + upload cycle) — confirmed: requires manual revectorization, not automatic
- [ ] Verify NanoGPT API key is stored securely (currently in extension_settings, same as other ST credentials — check if ST encrypts at rest)
- [ ] Small LLMs (e.g., GLM 4.7 Flash) produce low-quality extractions: reversed facts, contamination from existing memories. Document recommended models.

## Planned Improvements

### Next — Extraction Quality

- [ ] Experiment with splitting the prompt: send existing memories as a "deduplication checklist" rather than full text, to reduce contamination risk
- [ ] Add option to limit how many existing memories are sent (e.g., only most recent N blocks)
- [ ] Multi-pass extraction: extract then verify/refine with a second LLM call
- [ ] Memory categories/tags (relationships, events, facts, emotions)
- [ ] Per-character extraction prompt overrides

### Next — Multi-Provider LLM Support

- [ ] Design a provider abstraction so adding new LLM endpoints is straightforward
- [ ] Consider: OpenAI-compatible endpoints (user-provided URL + key), OpenRouter, local APIs (Ollama, LM Studio)
- [ ] Shared config pattern: URL, API key, model selector, test button
- [ ] Provider-specific options (temperature, system prompt override, etc.)

### Next — Rethink Consolidation & Deduplication

- [ ] More granular control over consolidation — current approach is all-or-nothing (send everything to LLM, accept/reject entire result)
- [ ] Per-block or per-bullet consolidation: select which memory blocks to consolidate rather than all at once
- [ ] Deduplication as a separate step from consolidation (detect duplicates, let user review and merge/delete individually)
- [ ] Side-by-side diff view showing exactly what changed per bullet during consolidation
- [ ] Configurable consolidation strategies: merge duplicates only, summarize related, or aggressive compression
- [ ] Preserve provenance: track which original memories were merged into a consolidated one
- [ ] Undo at the bullet level, not just whole-consolidation undo

### Future — UX

- [ ] Search within memories from the UI
- [ ] Add error recovery if extraction fails mid-way (don't lose existing file)
- [ ] Add character name to memory file header for clarity
- [ ] Show token count of current memory file

### Future — Diagnostics & Debugging

- [ ] Per-message diagnostic icon showing what was injected for that generation
- [ ] Diagnostic diff view: what changed between generations
- [x] Log extraction history (Activity Log panel)
- [x] Fix vectorization status check — pass source/model to `/api/vector/list` (was always showing "No")
- [x] Show injected memory bullets in diagnostics (extracted from Vector Storage injection)
- [x] Show character-bound lorebooks with entry counts and trigger keys
- [x] Split World Info section into static (lorebooks) and runtime (activated entries)

### Future Ideas (Not Yet Prioritized)

- [ ] Memory importance scoring (LLM rates importance, low-importance memories pruned first)
- [ ] Cross-character memories (shared world state)
- [ ] Memory conflict detection (contradictory facts)
- [ ] Integration with ST's built-in Summarize extension (use summary as extraction context)
- [ ] Export/import memories between characters

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
- **Session state**: `lastExtractionTime` (cooldown), `cooldownTimerInterval` — not persisted, reset on page load
- **Event hooks**: `CHARACTER_MESSAGE_RENDERED` for counting, `CHAT_CHANGED` for button injection, `WORLD_INFO_ACTIVATED` for diagnostics
- **LLM calls**: `generateQuietPrompt` (main LLM), `generateWebLlmChatPrompt` (WebLLM), or NanoGPT direct API
- **Output cleanup**: `removeReasoningFromString` to strip reasoning tags from LLM output
- **Guards**: `inApiCall` flag, `streamingProcessor.isFinished` check, context change detection, cooldown check

### Import Map (from extension location)

| Import | Resolves to |
|--------|------------|
| `../../../../script.js` | `/script.js` (main ST script) |
| `../../../extensions.js` | `/scripts/extensions.js` |
| `../../../chats.js` | `/scripts/chats.js` |
| `../../../utils.js` | `/scripts/utils.js` (getStringHash, getCharaFilename) |
| `../../../reasoning.js` | `/scripts/reasoning.js` |
| `../../../popup.js` | `/scripts/popup.js` |
| `../../../slash-commands/SlashCommandParser.js` | `/scripts/slash-commands/SlashCommandParser.js` |
| `../../../slash-commands/SlashCommand.js` | `/scripts/slash-commands/SlashCommand.js` |
| `../../../world-info.js` | `/scripts/world-info.js` (world_info, loadWorldInfo) |
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
