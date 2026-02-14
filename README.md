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
8. Use **Reset Extraction State** (in Settings) after editing or deleting memories so the next extraction re-reads all messages

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

### Memory Format

Memories are stored as `<memory>` tag blocks with chat attribution:

```
<memory chat="main_chat_abc123" date="2024-01-15 14:30">
- Alice grew up in a coastal village.
- She has two older brothers.
</memory>
```

Old `## Memory N` format files are auto-migrated on first read.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/extract-memories` | Force extraction regardless of interval |
| `/consolidate-memories` | Consolidate memories by merging duplicates |
| `/charmemory-debug` | Capture diagnostics and dump to console |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Extraction source | Main LLM | Choose between Main LLM, WebLLM (browser-local), or NanoGPT (direct API) |
| Auto-extract interval | 10 | How many new messages trigger an automatic extraction |
| Min. cooldown | 10 min | Minimum time between auto-extractions (manual Extract Now bypasses this) |
| Max messages | 20 | Max messages included per extraction call |
| Response length | 800 | Token limit for LLM extraction response |
| Per-chat memories | Off | Separate memory file per chat instead of per character |
| File name override | (auto) | Custom file name; leave blank for auto-naming from character name |
| Extraction prompt | (built-in) | Fully customizable, with Restore Default |

### NanoGPT Settings

When NanoGPT is selected as the extraction source, additional settings appear:

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

### Tips

- **Extract Now only processes unread messages.** After extraction, the pointer advances to the last message. To re-extract, click "Reset Extraction State" first.
- **The "Extract Here" brain button** on individual messages lets you target specific parts of a conversation without resetting the whole extraction state.
- **Max messages per extraction** limits how many messages the LLM sees at once. If your chat is 50 messages long but max is 20, only the most recent 20 unprocessed messages are sent. Increase this slider for longer chats, but be aware of token costs.
- **Cooldown only affects auto-extraction.** Manual "Extract Now" and the per-message brain button always work immediately.

## Activity & Diagnostics

The Activity & Diagnostics panel (below Settings) contains two tabs:

### Activity Log

Shows timestamped events for debugging:

- Chat switches with character name, chat ID, and message count
- Extraction state on switch (lastExtractedIndex, unextracted message count)
- Message collection details (how many messages were gathered, index range)
- LLM responses (memories saved or NO_NEW_MEMORIES)
- Cooldown skip notifications
- Errors and warnings

### Diagnostics

Shows what was injected into the last generation:

- **Memories**: Active file name, file status, total memory count (bullets and blocks), and vectorization status
- **Vectorization**: Whether the memory file has been vectorized and how many chunks exist (requires Vector Storage)
- **Lorebook Entries**: Which World Info entries activated, their keys and content
- **Extension Prompts**: What memory/vector/data bank content was injected

This helps answer "are my memories being vectorized?" and "are my lorebooks even working?" without digging through logs.

## Requirements

- SillyTavern with a working LLM API connection
- Vector Storage extension enabled (for retrieval)
- For NanoGPT: a NanoGPT API key (no other dependencies)

## How It Works

The extension listens for `CHARACTER_MESSAGE_RENDERED` events and counts character messages. When the interval is reached and cooldown has elapsed, it:

1. Collects messages since the last extraction (up to max messages limit)
2. Reads the existing memory file from character Data Bank
3. Sends both to the LLM with an extraction prompt (existing memories are clearly bounded with markers to prevent contamination)
4. If the LLM returns new `<memory>` blocks with bullets, appends them with chat ID and timestamp metadata
5. If it returns `NO_NEW_MEMORIES`, skips the update

The extraction prompt instructs the LLM to output `<memory>` blocks containing bulleted lists of third-person facts about the character. It includes:
- A FOCUS list of what to extract (life events, relationships, preferences, emotional developments, significant encounters)
- An AVOID list of what to skip (repetitive minutiae, temporary states, dialogue filler)
- Clear boundary markers between existing memories and new chat content
- Instructions to write in past tense and capture vivid memorable details without sequential play-by-play

### What This Extension Does NOT Do

- Does not manage lorebooks (use SillyTavern's built-in World Info for that)
- Does not inject memories into the prompt directly (relies on Vector Storage)
- Does not require any external services or subscriptions
