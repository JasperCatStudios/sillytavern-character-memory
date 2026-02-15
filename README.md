# CharMemory — SillyTavern Extension

Automatically extracts structured character memories from chat and stores them in character-scoped Data Bank files. Memories are vectorized by SillyTavern's existing Vector Storage for retrieval at generation time.

## What It Does

```
Chat happens (every N character messages)
    → Extension auto-fires on CHARACTER_MESSAGE_RENDERED
    → Extracts new memories via main LLM, WebLLM, or NanoGPT
    → Appends <memory> blocks to character-scoped Data Bank file
    → Vector Storage vectorizes the file automatically
    → Relevant memories retrieved at generation time
```

- **Automatic**: Extracts memories every N character messages (configurable, default 10) with cooldown to prevent rapid-fire
- **Chunked**: Loops through all unprocessed messages in chunks — no messages are silently skipped
- **Batch extraction**: Extract memories from all (or selected) chats for a character, not just the active one
- **Visible**: Memories stored as a plain markdown file in character Data Bank — fully viewable and editable
- **Per-bullet management**: Browse, edit, or delete individual memory bullets from the Memory Manager
- **Consolidation**: Merge duplicate and related memories with preview before applying and one-click undo
- **Scoped**: Memories are per-character by default, with optional per-chat isolation
- **Non-destructive**: Only appends, never overwrites existing memories
- **Multiple LLM sources**: Main LLM, WebLLM (browser-local), or NanoGPT (direct API)

## Installation

### Option A: Symlink (for development)

```bash
ln -s /path/to/sillytavern-character-memory \
  /path/to/SillyTavern/public/scripts/extensions/third-party/CharMemory
```

### Option B: Clone into SillyTavern

```bash
cd /path/to/SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/bal-spec/sillytavern-character-memory CharMemory
```

Restart SillyTavern after installation.

## Usage

1. Open SillyTavern and go to **Extensions** panel
2. Find **Character Memory** and expand it
3. Enable automatic extraction (on by default)
4. Chat normally — memories are extracted automatically every N messages
5. Use **View / Edit** to browse and manage individual memories
6. Use **Consolidate** to merge duplicates when the file grows large — a Before/After preview is shown before changes are applied
7. Use **Undo Consolidation** to restore the previous memories if the consolidation result isn't satisfactory
8. Use **Batch Extract** (in Tools & Diagnostics) to extract memories from multiple chats at once

### Stats Bar

The stats bar at the top of the extension panel shows:
- **File name**: The active memory file for the current character
- **Memory count**: Total number of individual memory bullets stored
- **Extraction progress**: New messages since last extraction vs. the auto-extract threshold (e.g., "7/10 msgs")
- **Cooldown timer**: Time remaining before the next auto-extraction is allowed, or "Ready"

### Memory Manager

Click **View / Edit** to open the Memory Manager. Memories are displayed as grouped cards, one per extraction block, showing the chat ID and extraction date. Each bullet within a block has its own edit and delete buttons:

- **Edit**: Modify a single bullet's text
- **Delete**: Remove a single bullet (if the block becomes empty, it's removed entirely)

### Per-Message Buttons

Each message in the chat gets additional buttons in its action bar (visible on hover):

- **Extract Here** (brain icon, character messages only): Run memory extraction on all messages up to and including this one. Useful for extracting from specific parts of a long chat.
- **Pin as Memory** (bookmark icon, all messages): Manually save a message's text as a memory, with an edit dialog before saving

These buttons appear on all messages, including those that were already in the chat when it loaded.

### Batch Extraction

Extract memories from multiple chats at once, useful for backfilling memories from existing conversations.

1. Open **Tools & Diagnostics** → **Batch Extract** tab
2. Click **Refresh** to load the list of chats for the current character
3. Select the chats you want to extract from (use Select All to check all)
4. Click **Extract Selected** — a confirmation popup shows the total
5. Progress bar shows which chat is being processed and chunk progress
6. Use **Stop** to cancel mid-extraction (progress is saved per-chunk)

Batch extraction uses the same chunked extraction as single-chat mode. Each chat's extraction state is tracked separately, so re-running batch extraction only processes new messages.

### Memory Format

Memories are stored as `<memory>` tag blocks with chat attribution:

```
<memory chat="main_chat_abc123" date="2024-01-15 14:30">
- Alice grew up in a coastal village.
- She has two older brothers.
</memory>
```

Multiple chunks from the same chat are automatically merged into a single block.

Old `## Memory N` format files are auto-migrated on first read.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/extract-memories` | Force extraction regardless of interval |
| `/consolidate-memories` | Consolidate memories by merging duplicates |
| `/charmemory-debug` | Capture diagnostics and dump to console |

### Settings

Settings are organized in the **Settings** drawer:

#### LLM Provider

| Setting | Default | Description |
|---------|---------|-------------|
| LLM Provider | Main LLM | Choose between Main LLM, WebLLM (browser-local), or NanoGPT (direct API) |

#### Auto-Extraction

| Setting | Default | Description |
|---------|---------|-------------|
| Extract after every N messages | 10 | How many new messages trigger an automatic extraction |
| Minimum wait between extractions | 10 min | Minimum time between auto-extractions (manual Extract Now bypasses this) |

These only affect automatic extraction. Manual extraction and batch extraction ignore them.

#### Extraction Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Messages per LLM call | 20 | How many messages to include in each LLM call. The system loops through all unprocessed messages in chunks of this size. |
| Max response length | 500 | Token limit for LLM extraction response per chunk |

#### Storage

| Setting | Default | Description |
|---------|---------|-------------|
| Separate memories per chat | Off | Each chat gets its own memory file instead of sharing one per character |
| File name override | (auto) | Custom file name; leave blank for auto-naming from character name |

#### Advanced

| Setting | Description |
|---------|-------------|
| Extraction prompt | Fully customizable prompt template with Restore Default |
| Reset Extraction State | Resets extraction tracking for all chats (active + batch) without deleting memories |
| Clear All Memories | Deletes the memory file and resets all extraction tracking |

### NanoGPT Settings

When NanoGPT is selected as the LLM provider, additional settings appear:

| Setting | Description |
|---------|-------------|
| API Key | Your NanoGPT API key. Use the **Test** button to verify it works. |
| Model filters | Filter the model dropdown by: **Subscription** (included in plan), **Open Source**, **Roleplay** (storytelling models), **Reasoning** (models with reasoning capability). Multiple filters combine as intersection. |
| Model | Select from available NanoGPT text models, grouped by provider |
| System prompt | Optional override for the system prompt sent with extraction/consolidation calls |

## Choosing an LLM for Memory Extraction

Memory extraction is a structured task that requires strong instruction following: the LLM must distinguish between "existing memories" (reference context) and "recent messages" (content to extract from), avoid repeating or remixing existing memories, and accurately capture who did what to whom.

### What matters most

1. **Instruction following**: The LLM must respect the AVOID list, past-tense requirement, and the boundary between existing memories and new chat content. Weaker models tend to blur these boundaries and contaminate new extractions with rephrased existing memories.
2. **Factual accuracy**: The LLM must not reverse actions (e.g., "A did X to B" when B did X to A) or hallucinate events that didn't happen.
3. **Structured output**: The LLM must produce well-formed `<memory>` blocks with bulleted lists. Models that struggle with formatting will produce unparseable output.

### Recommended models (NanoGPT subscription tier)

| Model | Notes |
|-------|-------|
| **DeepSeek V3.1 / V3.2** | Strong instruction following, good at structured extraction. Recommended first choice. |
| **Qwen3-235B** | Large model, handles nuanced instructions well |
| **Mistral Large 3 (675B)** | Very capable, good structured output |
| **Hermes 4 (405B)** | Good with roleplay-adjacent content, won't refuse |

### Models to avoid for extraction

| Model | Issue |
|-------|-------|
| **Small/Flash models** (e.g., GLM 4.7 Flash, Ministral 8B) | Too small for reliable instruction following. Tend to remix existing memories into new extractions and get basic facts wrong. |
| **Reasoning/Thinking variants** | Slower and more expensive with no benefit for extraction. The reasoning overhead isn't needed. |
| **Heavily censored models** | May refuse to extract memories from mature/explicit content, returning NO_NEW_MEMORIES even when there are genuine new facts. |

### Troubleshooting extraction quality

- **LLM returns NO_NEW_MEMORIES when there should be new ones**: Existing memories from other chats may overlap with current content. Try clearing the memory file or resetting extraction state.
- **Memories contain facts from existing memories, not from the chat**: The model is too weak to respect the boundary markers. Switch to a larger model (DeepSeek V3.1+).
- **Memories reverse who did what**: Same issue — model too small for accurate comprehension. Use a larger model.
- **Memories are too detailed / play-by-play**: Customize the AVOID section in the extraction prompt to be more specific about what granularity you want.
- **"No unprocessed messages" on Extract Now**: All messages have already been processed. Click "Reset Extraction State" first to re-read from the beginning, then "Extract Now".
- **Memories contain system metadata, relationship metrics, or image prompts**: The extension strips code blocks, markdown tables, `<details>` sections, and HTML tags before sending messages to the LLM. If metadata still leaks through, customize the AVOID section in the extraction prompt.

### Tips

- **Extract Now processes all unread messages in chunks.** The system loops through all unprocessed messages, sending them to the LLM in groups of "Messages per LLM call" size. For large backlogs (>3 chunks), a confirmation popup appears.
- **The "Extract Here" brain button** on individual messages lets you target specific parts of a conversation without resetting the whole extraction state.
- **Messages per LLM call** controls chunk size. If set to 20 and there are 100 unprocessed messages, extraction makes ~5 API calls. Smaller chunks are cheaper but may miss cross-message context. Default of 20 works well; 50+ may cause timeouts with some models.
- **Cooldown only affects auto-extraction.** Manual "Extract Now", per-message brain button, and batch extraction always work immediately.

## Tools & Diagnostics

The Tools & Diagnostics panel (below Settings) contains three tabs:

### Batch Extract

Extract memories from multiple chats for the current character. See [Batch Extraction](#batch-extraction) above.

### Activity Log

Shows timestamped events for debugging:

- Chat switches with character name, chat ID, and message count
- Extraction state on switch (lastExtractedIndex, unextracted message count)
- Message collection details (how many messages were gathered, index range)
- LLM responses (memories saved or NO_NEW_MEMORIES)
- Cooldown skip notifications
- Errors and warnings

Enable **Verbose** mode to see full LLM prompts and responses as collapsible entries — useful for debugging extraction quality issues.

### Diagnostics

Shows what was injected into the last generation:

- **Memories**: Active file name, file status, total memory count (bullets and blocks)
- **Vectorization**: Whether the memory file has been vectorized, how many chunks exist, and which embedding source/model is configured (requires Vector Storage)
- **Injected Memories — Last Generation**: Lists the individual memory bullets that Vector Storage retrieved and injected for the most recent generation. This shows exactly which memories the LLM saw.
- **Character Lorebooks**: Static list of lorebooks bound to the current character, with entry counts and trigger keys for each entry
- **Activated Entries — Last Generation**: Which World Info entries actually fired during the last generation, their keys and content
- **Extension Prompts**: What memory/vector/data bank content was injected

This helps answer "which memories are being retrieved?", "are my lorebooks bound correctly?", and "what did the LLM actually see?" without digging through logs.

## Important Notes

- **Reset Extraction State** resets tracking for the active chat and all batch extraction state for the character. It does not delete any memories. Use this before "Extract Now" or "Batch Extract" to re-process messages from the beginning.
- **Clear All Memories** deletes the memory file for the current character. In default mode (not per-chat), this file contains memories from **all** of that character's chats — so it clears all chats' memories for that character, not just the active chat's.
- **Separate memories per chat** mode gives each chat its own memory file. Note: batch extraction in per-chat mode is not fully supported yet.

## Vector Storage & Data Bank

The extension stores memories as a Data Bank file that Vector Storage vectorizes automatically. There are some important gotchas:

### Memory file format

All Data Bank memory files must use the `<memory>` tag format for the extension to parse them correctly:

```
<memory chat="imported" date="2024-01-15">
- Each memory is a bullet line starting with "- "
- Multiple bullets per block are fine
</memory>
```

If you have existing freeform memory files in the Data Bank (e.g., prose paragraphs, `<memories>` tags, or other formats), convert them to `<memory>` blocks with `- ` bullet lines. The diagnostics panel can only display injected memories that use this format.

### Revectorization

Vector Storage does **not** incrementally update — when you revectorize a file, it re-chunks and re-embeds the entire file from scratch. This means:

- **After consolidation**: The memory file changes but the vector index is now stale. Revectorize the file so the index reflects the consolidated content.
- **After format migration**: If the extension auto-migrates an old format file, the vectorized chunks still contain the old format. Purge vectors and revectorize.
- **After manual edits**: If you edit the memory file directly, revectorize to update the index.

**Always purge vectors before revectorizing** to ensure stale chunks from the old format are fully removed.

### Recommended Vector Storage settings

| Setting | Recommended | Notes |
|---------|-------------|-------|
| Chunk size (Data Bank files) | 3000 chars | Large enough to keep `<memory>` blocks together |
| Chunk overlap | 10-20% | Prevents chunk boundaries from splitting memory blocks. More important with fewer retrieve chunks. |
| Retrieve chunks | 5-10 | Retrieves the most semantically relevant memories. Setting this too high (e.g., 44) effectively dumps the entire file, defeating the purpose of semantic search. |
| Score threshold | 0.2 | Default is fine for most use cases |

## Requirements

- SillyTavern with a working LLM API connection
- Vector Storage extension enabled (for retrieval)
- For NanoGPT: a NanoGPT API key (no other dependencies)

## How It Works

The extension listens for `CHARACTER_MESSAGE_RENDERED` events and counts character messages. When the interval is reached and cooldown has elapsed, it:

1. Collects unprocessed messages in chunks (up to "Messages per LLM call" per chunk)
2. Strips non-diegetic content (code blocks, markdown tables, `<details>` sections, HTML tags) from messages before sending
3. Reads the existing memory file from character Data Bank
4. Sends both to the LLM with an extraction prompt (existing memories are clearly bounded with markers to prevent contamination)
5. If the LLM returns new `<memory>` blocks with bullets, appends them with chat ID and timestamp metadata
6. If it returns `NO_NEW_MEMORIES`, skips the update
7. Advances the extraction pointer and repeats for the next chunk until all unprocessed messages are covered
8. Merges memory blocks from the same chat into a single block

The extraction prompt instructs the LLM to output `<memory>` blocks containing bulleted lists of third-person facts about the character. It includes:
- A FOCUS list of what to extract (life events, relationships, preferences, emotional developments, significant encounters)
- An AVOID list of what to skip (repetitive minutiae, temporary states, dialogue filler, system metadata)
- Clear boundary markers between existing memories and new chat content
- Instructions to write in past tense and capture vivid memorable details without sequential play-by-play

### What This Extension Does NOT Do

- Does not manage lorebooks (use SillyTavern's built-in World Info for that)
- Does not inject memories into the prompt directly (relies on Vector Storage)
- Does not require any external services or subscriptions
