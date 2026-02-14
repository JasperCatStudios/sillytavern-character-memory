# CharMemory — SillyTavern Extension

Automatically extracts structured character memories from chat and stores them in character-scoped Data Bank files. Memories are vectorized by SillyTavern's existing Vector Storage for retrieval at generation time.

## What It Does

```
Chat happens (every N character messages)
    → Extension auto-fires on CHARACTER_MESSAGE_RENDERED
    → Extracts new memories via main LLM or WebLLM
    → Appends <memory> blocks to character-scoped Data Bank file
    → Vector Storage vectorizes the file automatically
    → Relevant memories retrieved at generation time
```

- **Automatic**: Extracts memories every N character messages (configurable, default 10)
- **Visible**: Memories stored as a plain markdown file in character Data Bank — fully viewable and editable
- **Per-bullet management**: Browse, edit, or delete individual memory bullets from the Memory Manager
- **Consolidation**: Merge duplicate and related memories with a single click
- **Scoped**: Memories are per-character by default, with optional per-chat isolation
- **Non-destructive**: Only appends, never overwrites existing memories

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
6. Use **Consolidate** to merge duplicates when the file grows large

### Stats Bar

The stats bar at the top of the extension panel shows:
- **File name**: The active memory file for the current character
- **Memory count**: Total number of individual memory bullets stored

### Memory Manager

Click **View / Edit** to open the Memory Manager. Memories are displayed as grouped cards, one per extraction block, showing the chat ID and extraction date. Each bullet within a block has its own edit and delete buttons:

- **Edit**: Modify a single bullet's text
- **Delete**: Remove a single bullet (if the block becomes empty, it's removed entirely)

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
| Extraction source | Main LLM | Choose between Main LLM or WebLLM (browser-local) |
| Interval | 10 | Extract every N character messages |
| Max messages | 20 | Max messages included per extraction |
| Response length | 500 | Token limit for LLM extraction response |
| Per-chat memories | Off | Separate memory file per chat instead of per character |
| File name override | (auto) | Custom file name; leave blank for auto-naming from character name |
| Extraction prompt | (built-in) | Fully customizable, with Restore Default |

## Requirements

- SillyTavern with a working LLM API connection
- Vector Storage extension enabled (for retrieval)
- No other dependencies

## How It Works

The extension listens for `CHARACTER_MESSAGE_RENDERED` events and counts character messages. When the interval is reached, it:

1. Collects messages since the last extraction (up to max messages limit)
2. Reads the existing memory file from character Data Bank
3. Sends both to the LLM with an extraction prompt
4. If the LLM returns new `<memory>` blocks with bullets, appends them with chat ID and timestamp metadata
5. If it returns `NO_NEW_MEMORIES`, skips the update

The extraction prompt instructs the LLM to output `<memory>` blocks containing bulleted lists of third-person facts about the character.

### What This Extension Does NOT Do

- Does not manage lorebooks (use SillyTavern's built-in World Info for that)
- Does not inject memories into the prompt directly (relies on Vector Storage)
- Does not require any external services or subscriptions

## Diagnostics

The Diagnostics panel shows what was injected into the last generation:

- **Memories**: Active file name, file status, total memory count (bullets and blocks), and vectorization status
- **Vectorization**: Whether the memory file has been vectorized and how many chunks exist (requires Vector Storage)
- **Lorebook Entries**: Which World Info entries activated, their keys and content
- **Extension Prompts**: What memory/vector/data bank content was injected

This helps answer "are my memories being vectorized?" and "are my lorebooks even working?" without digging through logs.
