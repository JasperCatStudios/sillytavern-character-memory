# CharMemory — SillyTavern Extension

Automatically extracts structured character memories from chat and stores them in character-scoped Data Bank files. Memories are vectorized by SillyTavern's existing Vector Storage for retrieval at generation time.

## What It Does

```
Chat happens (every N character messages)
    → Extension auto-fires on CHARACTER_MESSAGE_RENDERED
    → generateQuietPrompt extracts new memories via main LLM
    → Appends to character-scoped Data Bank file (char-memories.md)
    → Vector Storage vectorizes the file automatically
    → Relevant memories retrieved at generation time
```

- **Automatic**: Extracts memories every N character messages (configurable, default 10)
- **Visible**: Memories stored as a plain markdown file in character Data Bank — fully viewable and editable
- **Non-destructive**: Only appends, never overwrites existing memories
- **Scoped**: Memories are per-character, persist across chats with the same character

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
2. Find **CharMemory** and expand it
3. Enable automatic extraction (on by default)
4. Chat normally — memories are extracted automatically every N messages
5. Check **Data Bank > Character** tab for `char-memories.md`

### Slash Commands

| Command | Description |
|---------|-------------|
| `/extract-memories` | Force extraction regardless of interval |
| `/charmemory-debug` | Capture diagnostics and dump to console |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Interval | 10 | Extract every N character messages |
| Max messages | 20 | Max messages included per extraction |
| Response length | 500 | Token limit for LLM extraction response |
| Extraction prompt | (built-in) | Fully customizable, with Restore Default |

## Requirements

- SillyTavern with a working LLM API connection
- Vector Storage extension enabled (for retrieval)
- No other dependencies

## How It Works

The extension listens for `CHARACTER_MESSAGE_RENDERED` events and counts character messages. When the interval is reached, it:

1. Collects messages since the last extraction (up to max messages limit)
2. Reads existing `char-memories.md` from character Data Bank
3. Sends both to the LLM via `generateQuietPrompt` with an extraction prompt
4. If the LLM returns new memories, appends them to the file
5. If it returns `NO_NEW_MEMORIES`, skips the update

The extraction prompt instructs the LLM to write third-person narrative paragraphs about the character, avoiding duplicates of existing memories.

### What This Extension Does NOT Do

- Does not manage lorebooks (use SillyTavern's built-in World Info for that)
- Does not inject memories into the prompt directly (relies on Vector Storage)
- Does not require any external services or subscriptions

## Diagnostics

The Diagnostics panel shows what was injected into the last generation:

- **Lorebook Entries**: Which World Info entries activated, their keys and content
- **Extension Prompts**: What memory/vector/data bank content was injected

This helps answer "are my lorebooks even working?" without digging through logs.
