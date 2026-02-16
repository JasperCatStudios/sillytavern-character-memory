# Getting Started with CharMemory

This guide walks you through installing CharMemory, running your first memory extraction, and setting up Vector Storage so your characters can actually recall what happened in past conversations.

## What CharMemory Does

When you chat with a character in SillyTavern, the conversation disappears from the LLM's context as it scrolls past the token limit. CharMemory solves this by automatically extracting important facts, events, and developments from your chats and storing them as structured memories. These memories are then retrieved by Vector Storage at generation time, giving your character long-term recall.

In short: your character remembers things that happened even in very old conversations.

## Prerequisites

- A working SillyTavern installation
- An LLM API connection for your main chat (any provider)
- An API key for memory extraction (see [Choosing an Extraction Provider](#step-2-choose-an-extraction-provider) below)

## Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Click the **Extensions** icon (puzzle piece) in the top navigation bar
3. Click **Install extension** in the top-right corner of the Extensions panel
4. Paste the GitHub URL:
   ```
   https://github.com/bal-spec/sillytavern-character-memory
   ```
5. Click **Save** and wait for the installation to complete
6. Scroll down in the Extensions panel — you should see **Character Memory** at the bottom

You'll see the CharMemory panel with a stats bar showing the memory file name, memory count, extraction progress, and status. Automatic extraction is enabled by default.

## Step 2: Choose an Extraction Provider

CharMemory needs an LLM to read your chat messages and extract memories from them. This is separate from your main chat LLM. Open the **Settings** section inside the CharMemory panel.

You have three options for **LLM Provider**:

| Provider | How it works | Best for |
|----------|-------------|----------|
| **Main LLM** | Uses whatever LLM you're chatting with | Quick start, but lower quality (see below) |
| **WebLLM** | Runs a small model locally in your browser | Privacy, no API cost, but limited quality |
| **API Provider** (recommended) | Sends a clean extraction request directly to an API | Best extraction quality |

**Why API Provider is recommended:** When using Main LLM, the extraction prompt gets mixed in with your chat's system prompts, character cards, and other instructions. This pollutes the extraction and degrades quality. API Provider sends a focused, clean prompt directly to the LLM with nothing else attached.

### Setting up API Provider

1. Set **LLM Provider** to **API Provider (recommended)**
2. Choose a **Provider** from the dropdown. Options include OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Mistral, NanoGPT, Ollama, and others.
3. Enter your **API Key** for that provider
4. Click **Test** to verify the connection works
5. Select a **Model** from the dropdown

If you're not sure which model to use, see the [Recommended Models](#recommended-models) section below.

### If you just want to get started quickly

Set LLM Provider to **Main LLM** and skip the API configuration. This works out of the box with whatever LLM you're already chatting with. You can always switch to API Provider later for better quality.

## Step 3: Chat Normally

That's it for basic setup. Now just chat with a character as you normally would.

As you chat, watch the **stats bar** at the top of the CharMemory panel. You'll see the extraction progress counter tick up with each character message (e.g., "5/20 msgs"). When the counter reaches the threshold (default: 20 messages), CharMemory will automatically extract memories from the conversation.

### Your First Extraction

You don't have to wait for the auto-extraction. To run an extraction right away:

1. Click **Extract Now** at the top of the CharMemory panel
2. You'll see a toast notification: "Extracting via [provider]..."
3. After a few seconds, the notification will update with how many memories were saved
4. The stats bar will show the updated memory count

### What the Stats Bar Shows

- **File name**: The memory file for the current character (e.g., `Flux_the_Cat-memories.md`)
- **Memory count**: Total individual memory bullets stored
- **Progress**: Messages since last extraction vs. the auto-extract threshold (e.g., "12/20 msgs")
- **Status**: "Ready" when extraction can fire, or a cooldown timer

## Step 4: View Your Memories

Click **View / Edit** to open the Memory Manager. Your extracted memories appear as cards grouped by extraction, showing the chat name and timestamp. Each card contains bullet-point memories like:

```
- Alex offered Flux tuna on the first morning, placing the dish on the floor.
- Flux accepted the treat from Alex's open palm, showing growing trust.
- Flux discovered pigeons on the balcony and became obsessed with watching them.
```

You can **edit** or **delete** individual bullets directly from this view.

## Step 5: Set Up Vector Storage

Extracting memories is only half the story. For your character to actually *use* those memories during conversation, you need **Vector Storage** enabled. Vector Storage converts memories into embeddings (numerical representations) and retrieves the most relevant ones when the character generates a response.

Without Vector Storage, memories are stored but never injected into the LLM's context — the character won't recall them.

### Enable Vector Storage

1. In the **Extensions** panel, find **Vector Storage** and expand it
2. Check **Enabled for files (Data Bank)** — this is the critical setting. CharMemory stores memories as Data Bank files, so this must be on.
3. Choose an **Embedding Source**. The simplest option is **Transformers** (runs locally in your browser, no API key needed). Other options include OpenAI, Cohere, or Ollama if you prefer external embeddings.

### Recommended Vector Storage Settings for Memories

These settings are found in the Vector Storage extension panel under the **Data Bank** section (not the chat message section):

| Setting | Recommended | Why |
|---------|-------------|-----|
| **Chunk size** | 2500–3000 chars | Large enough to keep `<memory>` blocks together without splitting them |
| **Chunk overlap** | 10–20% | Prevents chunk boundaries from cutting through the middle of a memory block |
| **Retrieve chunks** | 5–10 | How many memory chunks are retrieved per generation. Too low and the character misses relevant memories. Too high (e.g., 40+) and you're dumping the entire file, which defeats semantic search. |
| **Score threshold** | 0.2–0.25 | How similar a memory must be to the current conversation to be retrieved. The default is fine. |

### Verify It's Working

After extracting some memories and chatting further:

1. Open CharMemory's **Tools & Diagnostics** section
2. Click the **Diagnostics** tab
3. Click **Refresh**
4. Check **Vectorization** — it should say "Yes" with a chunk count
5. Check **Injected Memories — Last Generation** — after your next message, this will show which specific memories were retrieved and sent to the LLM

If "Injected Memories" says "No memory chunks injected yet (generate a message first)", send another message to the character and refresh diagnostics again. The memories are retrieved at generation time, so you need at least one exchange after vectorization for them to appear.

## Understanding the Extraction Settings

Once you're up and running, you may want to tune how often and how extraction happens. Open **Settings** in the CharMemory panel.

### Auto-Extraction Timing

Two sliders control when automatic extraction fires:

**Extract after every N messages** (default: 20, range: 3–100)
How many character messages must arrive before auto-extraction triggers. A higher value gives the LLM more context per extraction, which generally produces better, more selective memories. A lower value extracts more frequently with less context.

**Minimum wait between extractions** (default: 10 min, range: 0–30 min)
A cooldown that prevents rapid-fire extractions during fast-paced chats. When the message threshold is reached, extraction only fires if this much wall-clock time has passed since the last one. If the cooldown hasn't expired, extraction is skipped (not queued) and checks again on each subsequent message. Messages keep accumulating during the cooldown, so when it finally fires, it processes everything that piled up.

These two settings **only affect automatic extraction**. Manual "Extract Now", per-message "Extract Here", and batch extraction always run immediately.

### Extraction Quality

**Messages per LLM call** (default: 50, range: 10–200)
Controls how many messages are sent to the LLM in a single extraction call. If there are more unprocessed messages than this, extraction loops through them in chunks. Larger chunks give the LLM more context per call and produce better memories. The default of 50 is a good balance.

In the common auto-extraction case, only N messages (the interval threshold) will have accumulated, so this slider is irrelevant — the chunk size only kicks in when messages pile up beyond the interval, during manual extraction of long chats, or during batch extraction.

**Max response length** (default: 1000 tokens, range: 100–2000)
Token limit for the LLM's response per chunk. Increase this if extractions seem truncated. Most models produce well-formed output within 1000 tokens.

### How They Work Together

With defaults (interval=20, cooldown=10min, chunk size=50):

- **Leisurely chat**: 20 messages over 45 minutes → cooldown long expired → extracts 20 messages in one call
- **Fast chat**: 20 messages in 3 minutes → cooldown blocks → messages keep accumulating → at 10 minutes, 60 messages have piled up → extracts in two chunks (50 + 10)
- **Manual extract after long chat**: 200 unprocessed messages → "Extract Now" processes in 4 chunks of 50, ignoring interval and cooldown

## Per-Message Buttons

Each message in your chat has two extra buttons (visible when you hover over the message):

**Extract Here** (brain icon, character messages only)
Runs LLM-based extraction on all unprocessed messages up to and including this one. Useful for targeting a specific point in a long conversation. Uses the same provider and settings as auto-extraction.

**Pin as Memory** (bookmark icon, all messages)
Manually saves a message as a memory with no LLM involved. Opens an edit dialog pre-filled with the message text so you can rewrite it however you want before saving. Each line becomes a memory bullet. Use this when you want to remember something specific exactly as you phrase it.

## Recommended Models

Memory extraction is a structured task — the LLM needs to follow instructions precisely, distinguish between existing and new content, and produce well-formatted output. Not all models are equally good at this.

### Good choices

| Model | Notes |
|-------|-------|
| **GLM 4.7** | Best quality and fastest. Concise, significant memories. Recommended first choice. |
| **DeepSeek V3.1 / V3.2** | Good instruction following. Solid second choice. |
| **Mistral Large 3** | Good quality, sometimes verbose. |
| **GPT-4.1 nano / mini** | Reliable instruction following at low cost. |

### Models to avoid

| Model | Issue |
|-------|-------|
| **Reasoning/Thinking variants** | Slower and more expensive with no benefit for extraction. |
| **Very small models** | May reverse who did what or blur the boundary between existing and new memories. |
| **Heavily censored models** | May refuse to extract from mature content, returning nothing even when there are real events to capture. |

## Troubleshooting

**"0 memories" after extraction**: Check the Activity Log (Tools & Diagnostics → Activity Log). It shows exactly what happened — whether the LLM returned NO_NEW_MEMORIES, produced unparseable output, or encountered an error. Enable **Verbose** mode to see the full prompt and response.

**Memories extracted but character doesn't use them**: Vector Storage isn't set up, or "Enabled for files (Data Bank)" isn't checked. Open Diagnostics and verify the Vectorization line shows "Yes" and that Injected Memories shows entries after generating a message.

**Extraction never fires automatically**: Check that "Enable automatic extraction" is checked, the message counter is actually incrementing (visible in the stats bar), and the cooldown timer isn't blocking it.

**"No unprocessed messages" on Extract Now**: All messages have been processed. Click **Reset Extraction State** first to re-read from the beginning, then **Extract Now** again.

**Duplicate or overlapping memories**: The extraction prompt includes existing memories as reference and instructs the LLM not to repeat them. If duplicates still appear, use **Consolidate** to merge them — it shows a before/after preview and can be undone with **Undo Consolidation**.

## Next Steps

- **Batch Extract**: Got existing chats with a character? Use Tools & Diagnostics → Batch Extract to extract memories from all of them at once.
- **Consolidation**: When the memory file grows large, use **Consolidate** to merge duplicate and related memories. A preview is shown before applying, and **Undo Consolidation** restores the previous version.
- **Custom extraction prompt**: If you want to control what kinds of memories are extracted, edit the extraction prompt in Settings → Advanced. A **Restore Default** button is available if you want to start over.
- **Per-chat memories**: Enable "Separate memories per chat" in Storage settings to give each conversation its own memory file instead of sharing one per character.
