# Getting Started with CharMemory

This guide walks you through installing CharMemory, running your first memory extraction, and setting up Vector Storage so your characters can actually recall what happened in past conversations.

## What CharMemory Does

When you chat with a character in SillyTavern, the conversation disappears from the LLM's context as it scrolls past the token limit. CharMemory solves this by automatically extracting important facts, events, and developments from your chats and storing them as structured memories.

Memories are stored as plain markdown files in the character's **Data Bank** — SillyTavern's built-in file attachment system. You can view, edit, or delete the memory file at any time, either through CharMemory's Memory Manager or by editing the Data Bank file directly. There's no proprietary format or lock-in.

These memory files are then vectorized by **Vector Storage** (a standard extension that ships with SillyTavern) so that the most relevant memories are automatically retrieved and injected into the LLM's context at generation time. The result: your character remembers things that happened even in very old conversations.

## Prerequisites

- A working SillyTavern installation
- An LLM API connection for your main chat (any provider)
- An API key for memory extraction (see [Step 2](#step-2-choose-an-extraction-provider) below)

## Step 1: Install the Extension

1. Open SillyTavern in your browser
2. Click the **Extensions** icon (puzzle piece) in the top navigation bar
3. Click **Install extension** in the top-right corner of the Extensions panel
4. Paste the GitHub URL:
   ```
   https://github.com/bal-spec/sillytavern-character-memory
   ```
5. Click **Install just for me** and wait for the installation to complete

![Install extension dialog — paste the GitHub URL and click Install](images/02-install-dialog.png)

6. Scroll down in the Extensions panel — you should see **Character Memory** at the bottom

### Recommended: Turn on Message IDs

Before you start chatting, enable **Message IDs** in SillyTavern. This shows a sequential number on each message in the chat, which is helpful when using CharMemory because:

- The Activity Log references message indices (e.g., "Collected 15 messages (indices 0-14)")
- The "Extract Here" button processes up to a specific message index
- Diagnostics show `lastExtractedIndex`, so you can see exactly which messages have been processed

To enable: click the **User Settings** icon (the person silhouette at the top) → scroll to the checkboxes in the UI section → check **Message IDs**.

![User Settings — check "Message IDs" in the UI options](images/03-message-ids.png)

## Step 2: Choose an Extraction Provider

CharMemory needs an LLM to read your chat messages and extract memories from them. This is a separate LLM call from your main chat. Open the **Settings** section inside the CharMemory panel.

You have three options for **LLM Used for Extraction**:

| Option | How it works | Best for |
|--------|-------------|----------|
| **Dedicated API** (recommended) | Sends a clean extraction request directly to an API | Best extraction quality — the extraction prompt isn't polluted by chat context |
| **WebLLM** | Runs a small model locally in your browser | Privacy and no API cost, but limited quality |
| **Main LLM** | Uses whatever LLM you're chatting with | No extra setup, but extraction quality suffers because the prompt gets mixed with chat system prompts and instructions |

### Setting up Dedicated API

Dedicated API is the default and recommended option. It sends a focused extraction prompt directly to an LLM without any of the chat's system prompts, character cards, or other instructions getting mixed in. This produces noticeably better memories.

1. Open **Settings** in the CharMemory panel — **Dedicated API** is already selected
2. Choose a **Provider** from the dropdown. Options include OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Mistral, NanoGPT, Ollama, and others.
3. Enter your **API Key** for that provider
4. Click **Test** to verify the connection works
5. Select a **Model** from the dropdown

![CharMemory Settings — Dedicated API with NanoGPT, model selection, and auto-extraction sliders](images/04-settings-provider.png)

If your provider isn't listed, select **Custom** from the Provider dropdown. You can enter any OpenAI-compatible API base URL and it will work as long as the endpoint supports the `/chat/completions` format. Most LLM providers use this standard.

If you're not sure which model to use, see the [Recommended Models](#recommended-models) section below.

## Step 3: Chat Normally

That's it for basic setup. Now just chat with a character as you normally would.

As you chat, open the extension to watch the **stats bar** at the top of the CharMemory panel. You'll see the extraction progress counter tick up with each character message (e.g., "5/20 msgs"). When the counter reaches the threshold (default: 20 messages), CharMemory will automatically extract memories from the conversation.

![The stats bar shows the memory file, count, extraction progress, and cooldown status](images/05-stats-bar.png)

### What the Stats Bar Shows

- **File name**: The memory file for the current character (e.g., `Flux_the_Cat-memories.md`). This is auto-generated from the character name, but you can set a custom name in Settings → Storage → File name override.
- **Memory count**: Total individual memory bullets stored
- **Progress**: Messages since last extraction vs. the auto-extract threshold (e.g., "1/20 msgs")
- **Status**: "Ready" when extraction can fire, or a cooldown timer

### Your First Extraction

You don't have to wait for the auto-extraction threshold. There are two ways to extract right away:

**Extract Now** (button at the top of the CharMemory panel) processes all unprocessed messages in the entire chat. Click it, and you'll see a toast notification with how many memories were saved.

**Extract Here** (brain icon on any character message) processes all unprocessed messages up to and including that specific message. This is useful when you want to extract from a particular point in the conversation without processing everything after it.

You can follow either extraction in real time in the **Activity Log** (Tools & Diagnostics → Activity Log). It shows each step: messages collected, LLM call sent, response received, and memories saved.

![Activity Log showing a successful extraction — 15 messages collected, 7 memories saved](images/08-activity-log.png)

## Step 4: View Your Memories

Click **View / Edit** to open the Memory Manager. Your extracted memories appear as cards grouped by extraction, showing the chat name and timestamp. Each bullet has its own edit and delete buttons.

![Memory Manager showing 7 extracted memories with edit and delete controls](images/06-memory-manager.png)

You can **edit** any bullet to refine its wording, or **delete** bullets that aren't useful. If a block becomes empty after deleting all its bullets, it's removed entirely.

Since memories are stored as a plain markdown file in the character's Data Bank, you can also edit the file directly if you prefer. Open the character's Data Bank panel (the paperclip icon), find the memory file, and edit it in any text editor. The Memory Manager is simply a more convenient interface for the same file.

## Step 5: Set Up Vector Storage

Extracting memories is only half the story. For your character to actually *use* those memories during conversation, you need **Vector Storage** enabled.

Vector Storage is a standard extension that ships with every SillyTavern installation — you don't need to install anything extra. It converts memories into embeddings (numerical representations) and retrieves the most relevant ones when the character generates a response.

Without Vector Storage enabled for Data Bank files, memories are stored but never injected into the LLM's context — the character won't recall them.

### Enable Vector Storage

1. In the **Extensions** panel, find **Vector Storage** and expand it
2. Choose a **Vectorization Source**. The simplest option is **Local (Transformers)** — runs in your browser, no API key needed.
3. Under **File vectorization settings**, check **Enable for files** — this is the critical setting. CharMemory stores memories as Data Bank files, so this must be on.
4. Configure the **Data Bank files** settings as shown below

![Vector Storage settings — Transformers source, Enable for files checked, Data Bank settings configured](images/07-vector-storage.png)

### Recommended Vector Storage Settings

The Vector Storage panel has two rows of file settings: **Message attachments** (top) and **Data Bank files** (bottom). CharMemory uses the Data Bank, so focus on the bottom row:

| Setting | Recommended | Why |
|---------|-------------|-----|
| **Size threshold** | 1 KB | Controls when chunking kicks in. Below this size, the whole file gets one embedding. At 1 KB (~5-10 memory bullets), individual chunks start getting their own vectors so Vector Storage can retrieve *specific* relevant memories instead of the whole file as a blob. |
| **Chunk size** | 3000 chars | A `<memory>` block with 8 bullets is roughly 500-1500 chars. 3000 keeps 1-2 full blocks per chunk without splitting them mid-sentence. Too small and blocks get cut in half. Too large and you lose retrieval granularity. |
| **Chunk overlap** | 15% | ~450 chars of overlap at 3000 chunk size. Catches memory blocks that straddle a chunk boundary. Without overlap, a block landing exactly on the split gets half in one chunk and half in another, making neither retrievable cleanly. |
| **Retrieve chunks** | 5 | How many memory chunks are retrieved per generation. At ~2 blocks per chunk, that's roughly 10 memory blocks — enough context without flooding the prompt. Going too high (20+) effectively dumps the whole file, defeating the purpose of semantic search. |

### Verify It's Working

After extracting some memories and chatting further:

1. Open CharMemory's **Tools & Diagnostics** section
2. Click the **Diagnostics** tab, then **Refresh**
3. Check **Vectorization** — it should say "Yes" with a chunk count
4. Check **Injected Memories — Last Generation** — after your next message, this will show which specific memories were retrieved and sent to the LLM

![Diagnostics showing memory count, vectorization status, last extraction result, and character lorebooks](images/09-diagnostics.png)

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

We arrived at the default of 50 through testing with several models. Setting this too low (e.g., 10-15) gave the LLM too little context — it would extract trivial details because there wasn't enough conversation to judge what was significant. Setting it too high (150+) didn't improve quality and increased token costs. 50 messages gives the LLM a solid window of conversation to work with while keeping costs reasonable.

The auto-extraction interval (default: 20) was similarly tested. At 10, extractions were too frequent with too little context per call. At 20, the LLM has enough conversation to produce meaningful, selective memories without waiting too long between extractions.

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

## Other Features

### Batch Extraction

If you have existing chats with a character, you don't need to manually extract each one. Batch extraction processes multiple chats at once:

1. Open **Tools & Diagnostics** → **Batch Extract** tab
2. Click **Refresh** to load the list of chats for the current character
3. Select the chats you want to extract (use **Select All** to check all of them)
4. Click **Extract Selected** — a confirmation popup shows the total message count
5. Progress updates show which chat is being processed and chunk progress
6. Use **Stop** to cancel mid-extraction — progress is saved per-chunk, so you won't lose work

Each chat's extraction state is tracked separately. Re-running batch extraction only processes new messages since the last run — it won't re-extract messages that have already been processed.

### Resetting Extraction State

Two reset options are available in Settings:

**Reset Extraction State** resets the extraction tracking for the current character — both the active chat and all batch extraction state. After resetting, the extension treats all messages as unprocessed. This is useful when you want to re-extract from the beginning, perhaps after changing the extraction prompt or switching to a better model. It does **not** delete any memories.

**Clear All Memories** deletes the memory file and resets all extraction tracking. In default mode (not per-chat), the memory file contains memories from **all** of that character's chats, so this clears everything. This cannot be undone.

### The Extraction Prompt

The extraction prompt is the core of what makes CharMemory produce useful memories rather than a play-by-play transcript. You can view and edit it in Settings → Extraction Prompt, and a **Restore Default** button lets you start over.

The default prompt was developed through extensive testing across multiple models and character types. Here's what it does and why:

**Three-section input structure.** The prompt gives the LLM three clearly bounded sections: the character card (baseline knowledge), existing memories (already recorded), and recent chat messages (what to extract from). Each section has explicit `=====` boundary markers and instructions about what to do with it — extract only from recent messages, don't repeat existing memories, and don't re-state character card traits.

**Why the character card is included.** Early versions without the card produced memories that re-extracted baseline traits. If a character's card says "she's a doctor," the LLM would extract "she works in medicine" from every chat where it came up. Including the card as "baseline knowledge — do NOT extract" dramatically reduced this.

**The "would they bring this up months later?" test.** The prompt asks the LLM to evaluate each potential memory against this question. This pushes models toward significant, lasting facts and away from moment-by-moment details.

**Hard 8-bullet limit.** Without a cap, most models produce 15-20 bullets per extraction — far too granular. The 8-bullet limit forces the LLM to prioritize. If a conversation doesn't contain 8 significant things, the LLM can return fewer.

**Negative and positive examples.** The prompt includes a bad example (step-by-step play-by-play of a scene) and a good example (the same scene condensed to 2 bullets capturing outcomes). This was the single most effective change for reducing play-by-play extraction, which was the most common quality problem across models.

**"Write what happened, not that it was discussed."** Models tend to write meta-narration like "she told him about her childhood" instead of the actual fact "she grew up in a coastal village." The prompt explicitly addresses this pattern.

If you customize the prompt, keep the three-section structure and boundary markers intact — models rely on these to understand what to extract from and what to skip.

### Consolidation

When the memory file grows large with many extraction blocks, related or duplicate memories can accumulate across different sessions. **Consolidate** attempts to merge these by sending the full memory file to the LLM with instructions to deduplicate and combine related entries.

A before/after preview is shown before any changes are applied, and **Undo Consolidation** restores the previous version if the result isn't satisfactory.

Note: Consolidation is still being refined. Results vary depending on the model used and the size of the memory file. We recommend reviewing the preview carefully before applying.

### Per-Chat Memories

By default, all chats for a character share one memory file. Enable **Separate memories per chat** in Settings → Storage to give each conversation its own file. This is useful when the same character appears in different scenarios or timelines that shouldn't share context.

### Custom File Names

The memory file is auto-named from the character name (e.g., `Flux_the_Cat-memories.md`). You can override this in Settings → Storage → **File name override**. This is useful if you want a more descriptive name or if you're managing multiple memory files manually.

## Troubleshooting

**"0 memories" after extraction**: Check the Activity Log (Tools & Diagnostics → Activity Log). It shows exactly what happened — whether the LLM returned NO_NEW_MEMORIES, produced unparseable output, or encountered an error. Enable **Verbose** mode to see the full prompt and response.

**Memories extracted but character doesn't use them**: Vector Storage isn't set up, or "Enable for files" isn't checked. Open Diagnostics and verify the Vectorization line shows "Yes" and that Injected Memories shows entries after generating a message.

**Extraction never fires automatically**: Check that "Enable automatic extraction" is checked, the message counter is actually incrementing (visible in the stats bar), and the cooldown timer isn't blocking it.

**"No unprocessed messages" on Extract Now**: All messages have been processed. Click **Reset Extraction State** first to re-read from the beginning, then **Extract Now** again.

**Duplicate or overlapping memories**: The extraction prompt includes existing memories as reference and instructs the LLM not to repeat them. If duplicates still appear, use **Consolidate** to merge them — review the preview before applying.
