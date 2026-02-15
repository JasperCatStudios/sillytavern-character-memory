# Batch Extraction & UX Rethink Implementation Plan

> **Status: COMPLETED** — All 7 tasks implemented plus post-implementation fixes. See commit history on `master`.

**Goal:** Add batch extraction across multiple chats, fix lossy message skipping with chunked extraction, and clean up the settings UX.

**Architecture:** Refactor `extractMemories()` and `collectRecentMessages()` to accept external chat arrays and chatId parameters. Add chunked looping with progress/cancellation. Fetch non-active chats via SillyTavern's `POST /api/characters/chats` and `POST /api/chats/get` server endpoints. Reorganize settings.html into logical sections.

**Tech Stack:** Vanilla JS (ES modules), jQuery (SillyTavern convention), SillyTavern extension API

---

## Task 1: Refactor `collectRecentMessages` to accept parameters

**Files:**
- Modify: `index.js:588-614`

**Step 1: Change function signature**

Change `collectRecentMessages(endIndex = null)` to accept an options object so it can work with any chat array, not just the active one:

```js
function collectRecentMessages({ endIndex = null, chatArray = null, lastExtractedIdx = null } = {}) {
    const context = getContext();
    const chat = chatArray || context.chat;
    const lastExtracted = lastExtractedIdx !== null ? lastExtractedIdx : (function () {
        ensureMetadata();
        return chat_metadata[MODULE_NAME].lastExtractedIndex || 0;
    })();

    if (!chat || chat.length === 0) return { text: '', startIndex: -1, endIndex: -1 };

    const startIndex = Math.max(0, lastExtracted + 1);
    const maxMessages = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const end = endIndex !== null ? endIndex + 1 : chat.length;

    if (startIndex >= end) return { text: '', startIndex: -1, endIndex: -1 };

    // Take a chunk of maxMessages starting from startIndex (NOT from end)
    const sliceEnd = Math.min(startIndex + maxMessages, end);
    const slice = chat.slice(startIndex, sliceEnd);

    const lines = [];
    for (const msg of slice) {
        if (msg.is_system) continue;
        const text = msg.mes ? msg.mes.replace(/<[^>]*>/g, '').trim() : '';
        if (text) lines.push(`${msg.name}: ${text}`);
    }

    logActivity(`Collected ${lines.length} messages (indices ${startIndex}-${sliceEnd - 1})`);
    return { text: lines.join('\n\n'), startIndex, endIndex: sliceEnd - 1 };
}
```

Key changes:
- Returns `{ text, startIndex, endIndex }` instead of just a string
- Chunks forward from `startIndex` instead of backward from `end` (fixes the lossy skip bug)
- Accepts external `chatArray` and `lastExtractedIdx`

**Step 2: Update all call sites**

There are 2 call sites:

1. `index.js:852` in `extractMemories`:
```js
// Before
const recentMessages = collectRecentMessages(endIndex);
// After
const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({ endIndex });
```

2. No other direct callers — `extractMemories` is the only consumer.

**Step 3: Commit**

```bash
git add index.js
git commit -m "refactor: collectRecentMessages accepts external chat array and chunks forward"
```

---

## Task 2: Add chunked looping to `extractMemories`

**Files:**
- Modify: `index.js:828-972`

**Step 1: Add an `AbortController`-compatible cancellation mechanism**

Add a module-level variable near `inApiCall` (around line 826):

```js
let extractionAbortController = null;
```

**Step 2: Refactor `extractMemories` to accept options and loop through chunks**

Replace the existing function with one that accepts an options object and loops:

```js
async function extractMemories({
    force = false,
    endIndex = null,
    chatArray = null,
    chatId = null,
    lastExtractedIdx = null,
    onProgress = null,
    abortSignal = null,
} = {}) {
    if (inApiCall) {
        console.log(LOG_PREFIX, 'Already in API call, skipping');
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    if (!extension_settings[MODULE_NAME].enabled && !force) {
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    const context = getContext();
    const effectiveChatArray = chatArray || context.chat;
    const effectiveChatId = chatId || context.chatId || 'unknown';
    let currentLastExtracted = lastExtractedIdx !== null ? lastExtractedIdx : (function () {
        ensureMetadata();
        return chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;
    })();

    if (!effectiveChatArray || effectiveChatArray.length === 0) {
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    if (context.characterId === undefined) {
        console.log(LOG_PREFIX, 'No character selected');
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    if (streamingProcessor && !streamingProcessor.isFinished) {
        console.log(LOG_PREFIX, 'Streaming in progress, skipping');
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    const effectiveEnd = endIndex !== null ? endIndex + 1 : effectiveChatArray.length;
    const totalUnprocessed = Math.max(0, effectiveEnd - (currentLastExtracted + 1));
    const chunkSize = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const totalChunks = Math.ceil(totalUnprocessed / chunkSize);

    if (totalUnprocessed === 0) {
        if (force) {
            toastr.info('No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.', 'CharMemory', { timeOut: 5000 });
        }
        return { totalMemories: 0, chunksProcessed: 0 };
    }

    // Confirmation for large extractions (>3 chunks) — only for manual/batch
    if (force && totalChunks > 3) {
        const proceed = await callGenericPopup(
            `This will process ${totalUnprocessed} messages in ~${totalChunks} API calls. Continue?`,
            POPUP_TYPE.CONFIRM
        );
        if (!proceed) return { totalMemories: 0, chunksProcessed: 0 };
    }

    const isActiveChat = !chatArray;
    const mode = force ? 'manual' : 'auto';
    logActivity(`Extraction triggered (${mode}), ${totalUnprocessed} messages in ${totalChunks} chunk(s)`);

    let totalNewMemories = 0;
    let chunksProcessed = 0;

    try {
        inApiCall = true;
        lastExtractionTime = Date.now();
        const source = extension_settings[MODULE_NAME].source;
        const sourceLabel = source === EXTRACTION_SOURCE.WEBLLM ? 'WebLLM' : source === EXTRACTION_SOURCE.NANOGPT ? 'NanoGPT' : 'main LLM';

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
            // Check cancellation
            if (abortSignal && abortSignal.aborted) {
                logActivity('Extraction cancelled by user', 'warning');
                break;
            }

            const progressMsg = totalChunks > 1
                ? `Extracting via ${sourceLabel} (chunk ${chunkIdx + 1}/${totalChunks})...`
                : `Extracting memories via ${sourceLabel}...`;
            toastr.info(progressMsg, 'CharMemory', { timeOut: 3000 });

            if (onProgress) {
                onProgress({ chunk: chunkIdx + 1, totalChunks, totalNewMemories });
            }

            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex: endIndex,
                chatArray: effectiveChatArray,
                lastExtractedIdx: currentLastExtracted,
            });

            if (!recentMessages) {
                logActivity('No more messages to extract in this chunk', 'warning');
                break;
            }

            const existingMemories = await readMemories();
            const prompt = buildExtractionPrompt(existingMemories, recentMessages);

            let result;
            if (source === EXTRACTION_SOURCE.NANOGPT) {
                const systemPrompt = extension_settings[MODULE_NAME].nanogptSystemPrompt || 'You are a memory extraction assistant.';
                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ];
                result = await generateNanoGptResponse(messages, extension_settings[MODULE_NAME].responseLength);
            } else if (source === EXTRACTION_SOURCE.WEBLLM) {
                if (!isWebLlmSupported()) {
                    toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                    break;
                }
                const messages = [
                    { role: 'system', content: 'You are a memory extraction assistant.' },
                    { role: 'user', content: prompt },
                ];
                result = await generateWebLlmChatPrompt(messages, {
                    max_tokens: extension_settings[MODULE_NAME].responseLength,
                });
            } else {
                result = await generateQuietPrompt({
                    quietPrompt: prompt,
                    skipWIAN: true,
                    responseLength: extension_settings[MODULE_NAME].responseLength,
                });
            }

            // For active chat: verify context hasn't changed
            if (isActiveChat) {
                const newContext = getContext();
                if (newContext.characterId !== context.characterId || newContext.chatId !== context.chatId) {
                    logActivity('Context changed during extraction, discarding result', 'warning');
                    break;
                }
            }

            let cleanResult = removeReasoningFromString(result);
            cleanResult = cleanResult.trim();
            lastExtractionResult = cleanResult || null;

            if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
                logActivity(`Chunk ${chunkIdx + 1}: LLM returned NO_NEW_MEMORIES`, 'warning');
            } else {
                const existing = parseMemories(await readMemories());
                const now = new Date();
                const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
                const matches = [...cleanResult.matchAll(memoryRegex)];
                const rawEntries = matches.length > 0
                    ? matches.map(m => m[1].trim()).filter(Boolean)
                    : [cleanResult.trim()].filter(Boolean);

                let newBulletCount = 0;
                for (const entry of rawEntries) {
                    const bullets = entry.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('- '))
                        .map(l => l.slice(2).trim())
                        .filter(Boolean);
                    const finalBullets = bullets.length > 0 ? bullets : [entry];
                    existing.push({ chat: effectiveChatId, date: timestamp, bullets: finalBullets });
                    newBulletCount += finalBullets.length;
                }

                await writeMemories(serializeMemories(existing));
                totalNewMemories += newBulletCount;
                logActivity(`Chunk ${chunkIdx + 1}: saved ${newBulletCount} memories`, 'success');
            }

            // Advance lastExtractedIndex
            currentLastExtracted = chunkEndIndex;
            if (isActiveChat) {
                ensureMetadata();
                chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
                saveMetadataDebounced();
            }
            chunksProcessed++;
        }

        // Final status
        if (totalNewMemories > 0) {
            toastr.success(`${totalNewMemories} memor${totalNewMemories === 1 ? 'y' : 'ies'} extracted!`, 'CharMemory');
        } else {
            toastr.info('No new memories found.', 'CharMemory');
        }

        if (isActiveChat) {
            ensureMetadata();
            chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
            saveMetadataDebounced();
            updateStatusDisplay();
            updateAllIndicators();
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        logActivity(`Extraction error: ${err.message}`, 'error');
        toastr.error(`Memory extraction failed: ${err.message}`, 'CharMemory');
    } finally {
        inApiCall = false;
    }

    return { totalMemories: totalNewMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
}
```

**Step 3: Update all call sites of `extractMemories`**

There are 4 call sites:

1. `onCharacterMessageRendered` (line 1000): `extractMemories(false)` → `extractMemories({ force: false })`
2. `onExtractHereClick` (line 1862): `extractMemories(true, messageIndex)` → `extractMemories({ force: true, endIndex: messageIndex })`
3. `setupListeners` Extract Now button (line 1689): `extractMemories(true)` → `extractMemories({ force: true })`
4. `onChatChanged` if it calls extract (check) — it doesn't call extractMemories directly

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat: chunked extraction loops through all unprocessed messages with cancellation"
```

---

## Task 3: Settings HTML reorganization

**Files:**
- Modify: `settings.html`

**Step 1: Restructure settings.html**

The new structure should be:

```
Main panel (always visible):
  - Stats bar (unchanged)
  - Enable checkbox (unchanged)
  - Action buttons (unchanged)

Settings drawer:
  1. LLM Provider section
     - "LLM Provider" dropdown (was "Extraction source")
     - NanoGPT sub-settings (unchanged)
  2. Auto-Extraction section
     - "Extract after every ___ messages" slider (moved from main panel)
     - "Minimum wait between extractions: ___ min" slider (moved from main panel)
     - Helper text explaining these only affect auto-extraction
  3. Extraction Settings section
     - "Messages per LLM call: ___" slider (was "Max messages per extraction")
     - "Max response length: ___ tokens" slider (was "Response length")
  4. Storage section (unchanged)
  5. Advanced section
     - Extraction prompt (unchanged)
     - Reset/Clear buttons (unchanged)

Tools & Diagnostics drawer (was "Activity & Diagnostics"):
  Tabs: Batch Extract | Activity Log | Diagnostics
  - Batch Extract tab: placeholder for now (implemented in Task 5)
  - Activity Log tab: unchanged
  - Diagnostics tab: unchanged
```

**Step 2: Write the updated HTML**

Key renames in the HTML:
- `<small>Extraction source</small>` → `<small>LLM Provider</small>`
- Title on dropdown: `"Which LLM to use for memory extraction and consolidation"` → `"Which LLM provider to use for memory extraction and consolidation"`
- `<small>Max messages per extraction: <span>` → `<small>Messages per LLM call: <span>`
- Title on max messages slider: update to explain chunking
- `<small>Response length (tokens): <span>` → `<small>Max response length: <span>`
- Move the interval and cooldown slider divs from main panel into Settings drawer
- Add helper text under the Auto-Extraction section
- Rename drawer from `Activity &amp; Diagnostics` to `Tools &amp; Diagnostics`
- Add a third tab button: `<button class="charMemory_tab" data-tab="batch">Batch Extract</button>`
- Add the Batch Extract tab content div (placeholder)

**Step 3: Verify slider bindings still work**

The slider IDs (`charMemory_interval`, `charMemory_minCooldown`, `charMemory_maxMessages`, `charMemory_responseLength`) stay the same — only their position in the DOM changes. All jQuery selectors use IDs, so moving them won't break anything.

**Step 4: Commit**

```bash
git add settings.html
git commit -m "refactor: reorganize settings UX with clearer labels and grouping"
```

---

## Task 4: Add helper functions for fetching chats from server

**Files:**
- Modify: `index.js` (add near the NanoGPT helper section, around line 616)

**Step 1: Add `fetchCharacterChats` function**

```js
/**
 * Fetch all chats for the current character from the server.
 * @returns {Promise<{file_name: string, file_id: string, chat_items: number, last_mes: string}[]>}
 */
async function fetchCharacterChats() {
    const context = getContext();
    if (context.characterId === undefined) return [];

    const avatar = characters[this_chid]?.avatar;
    if (!avatar) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: false }),
    });

    if (!response.ok) {
        console.error(LOG_PREFIX, 'Failed to fetch character chats:', response.status);
        return [];
    }

    const chats = await response.json();
    // Flatten — the API returns an array of single-key objects
    return chats.map(c => {
        const key = Object.keys(c)[0];
        return { file_name: key, ...c[key] };
    });
}
```

**Step 2: Add `fetchChatMessages` function**

```js
/**
 * Fetch full message history for a specific chat file.
 * @param {string} fileName - Chat filename (without .jsonl extension)
 * @returns {Promise<{metadata: object, messages: object[]}|null>}
 */
async function fetchChatMessages(fileName) {
    const avatar = characters[this_chid]?.avatar;
    const charName = getCharacterName();
    if (!avatar || !charName) return null;

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatar,
            file_name: fileName.replace('.jsonl', ''),
            ch_name: charName,
        }),
    });

    if (!response.ok) {
        console.error(LOG_PREFIX, 'Failed to fetch chat:', response.status);
        return null;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    return {
        metadata: data[0]?.chat_metadata || {},
        messages: data.slice(1),
    };
}
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add server API helpers to fetch character chats and messages"
```

---

## Task 5: Build the Batch Extract tab UI and logic

**Files:**
- Modify: `settings.html` (fill in the Batch Extract tab placeholder from Task 3)
- Modify: `index.js` (add batch extraction logic and event handlers)
- Modify: `style.css` (add batch extraction styles)

**Step 1: Add the Batch Extract tab HTML**

In the Batch Extract tab content div:

```html
<div class="charMemory_tabContent" id="charMemory_tabBatch" style="display:none;">
    <div class="charMemory_buttonRow">
        <input type="button" id="charMemory_batchRefresh" class="menu_button" value="Refresh" title="Load chat list for this character" />
        <input type="button" id="charMemory_batchExtract" class="menu_button" value="Extract Selected" title="Run extraction on all selected chats" disabled />
        <input type="button" id="charMemory_batchStop" class="menu_button" value="Stop" title="Cancel batch extraction" style="display:none;" />
    </div>
    <div class="charMemory_batchSelectRow">
        <label class="checkbox_label">
            <input type="checkbox" id="charMemory_batchSelectAll" />
            <small>Select all</small>
        </label>
    </div>
    <div id="charMemory_batchProgress" class="charMemory_batchProgress" style="display:none;">
        <div class="charMemory_batchProgressText"></div>
        <div class="charMemory_batchProgressBar"><div class="charMemory_batchProgressFill"></div></div>
    </div>
    <div id="charMemory_batchChatList" class="charMemory_batchChatList">
        <div class="charMemory_diagEmpty">Click "Refresh" to load chats.</div>
    </div>
</div>
```

**Step 2: Add CSS styles for the batch tab**

```css
/* Batch Extract */
.charMemory_batchChatList {
    max-height: 300px;
    overflow-y: auto;
}

.charMemory_batchChatItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.1));
    font-size: 0.85em;
}

.charMemory_batchChatItem label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    cursor: pointer;
}

.charMemory_batchChatName {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.charMemory_batchChatMeta {
    font-size: 0.85em;
    opacity: 0.5;
    white-space: nowrap;
}

.charMemory_batchSelectRow {
    margin: 4px 0;
}

.charMemory_batchProgress {
    margin: 6px 0;
    font-size: 0.85em;
}

.charMemory_batchProgressBar {
    height: 4px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.1));
    border-radius: 2px;
    margin-top: 4px;
    overflow: hidden;
}

.charMemory_batchProgressFill {
    height: 100%;
    background: var(--SmartThemeQuoteColor, #888);
    border-radius: 2px;
    width: 0%;
    transition: width 0.3s;
}
```

**Step 3: Add JS logic for batch extraction**

Add these functions to index.js, in a new `// ============ Batch Extraction ============` section before the Init section:

```js
let batchAbortController = null;

async function loadBatchChatList() {
    const $list = $('#charMemory_batchChatList');
    $list.html('<div class="charMemory_diagEmpty">Loading...</div>');

    const chats = await fetchCharacterChats();
    if (chats.length === 0) {
        $list.html('<div class="charMemory_diagEmpty">No chats found for this character.</div>');
        return;
    }

    const context = getContext();
    const currentChatId = context.chatId;

    const html = chats.map(chat => {
        const name = chat.file_name.replace('.jsonl', '');
        const count = chat.chat_items || '?';
        const isCurrent = name === currentChatId;
        const label = isCurrent ? `${name} (current)` : name;
        const lastMsg = chat.last_mes ? new Date(chat.last_mes).toLocaleDateString() : '';

        return `<div class="charMemory_batchChatItem">
            <label class="checkbox_label">
                <input type="checkbox" class="charMemory_batchChatCheck" data-filename="${name}" ${isCurrent ? '' : 'checked'} />
                <span class="charMemory_batchChatName" title="${name}">${label}</span>
            </label>
            <span class="charMemory_batchChatMeta">${count} msgs${lastMsg ? ' | ' + lastMsg : ''}</span>
        </div>`;
    }).join('');

    $list.html(html);
    updateBatchButtons();
}

function updateBatchButtons() {
    const anyChecked = $('.charMemory_batchChatCheck:checked').length > 0;
    $('#charMemory_batchExtract').prop('disabled', !anyChecked);
}

async function runBatchExtraction() {
    const selected = [];
    $('.charMemory_batchChatCheck:checked').each(function () {
        selected.push($(this).data('filename'));
    });

    if (selected.length === 0) return;

    // Confirmation
    const proceed = await callGenericPopup(
        `Extract memories from ${selected.length} chat(s)? This may make multiple API calls per chat.`,
        POPUP_TYPE.CONFIRM
    );
    if (!proceed) return;

    batchAbortController = new AbortController();
    const $progress = $('#charMemory_batchProgress');
    const $progressText = $progress.find('.charMemory_batchProgressText');
    const $progressFill = $progress.find('.charMemory_batchProgressFill');
    $progress.show();
    $('#charMemory_batchStop').show();
    $('#charMemory_batchExtract').prop('disabled', true);
    $('#charMemory_batchRefresh').prop('disabled', true);

    let totalMemories = 0;
    const context = getContext();
    const currentChatId = context.chatId;

    for (let i = 0; i < selected.length; i++) {
        if (batchAbortController.signal.aborted) break;

        const chatName = selected[i];
        const pct = Math.round((i / selected.length) * 100);
        $progressText.text(`Chat ${i + 1}/${selected.length}: ${chatName}`);
        $progressFill.css('width', `${pct}%`);

        logActivity(`Batch: starting chat "${chatName}" (${i + 1}/${selected.length})`);

        // If this is the current chat, use the active context
        if (chatName === currentChatId) {
            const result = await extractMemories({
                force: true,
                abortSignal: batchAbortController.signal,
                onProgress: ({ chunk, totalChunks }) => {
                    $progressText.text(`Chat ${i + 1}/${selected.length}: ${chatName} (chunk ${chunk}/${totalChunks})`);
                },
            });
            totalMemories += result.totalMemories;
            continue;
        }

        // Fetch chat from server
        const chatData = await fetchChatMessages(chatName);
        if (!chatData || chatData.messages.length === 0) {
            logActivity(`Batch: chat "${chatName}" has no messages, skipping`, 'warning');
            continue;
        }

        // Get batch extraction state for this chat
        const batchStateKey = `${getCharacterName()}:${chatName}`;
        if (!extension_settings[MODULE_NAME].batchState) {
            extension_settings[MODULE_NAME].batchState = {};
        }
        const lastIdx = extension_settings[MODULE_NAME].batchState[batchStateKey]?.lastExtractedIndex ?? -1;

        const result = await extractMemories({
            force: true,
            chatArray: chatData.messages,
            chatId: chatName,
            lastExtractedIdx: lastIdx,
            abortSignal: batchAbortController.signal,
            onProgress: ({ chunk, totalChunks }) => {
                $progressText.text(`Chat ${i + 1}/${selected.length}: ${chatName} (chunk ${chunk}/${totalChunks})`);
            },
        });

        // Save batch state
        extension_settings[MODULE_NAME].batchState[batchStateKey] = {
            lastExtractedIndex: result.lastExtractedIndex ?? lastIdx,
        };
        saveSettingsDebounced();

        totalMemories += result.totalMemories;
    }

    // Done
    $progressFill.css('width', '100%');
    $progressText.text(`Done! ${totalMemories} memories extracted from ${selected.length} chat(s).`);
    $('#charMemory_batchStop').hide();
    $('#charMemory_batchExtract').prop('disabled', false);
    $('#charMemory_batchRefresh').prop('disabled', false);
    batchAbortController = null;

    logActivity(`Batch extraction complete: ${totalMemories} memories from ${selected.length} chats`, 'success');
    updateStatusDisplay();
}
```

**Step 4: Add event listeners in `setupListeners`**

```js
// Batch Extract tab
$('#charMemory_batchRefresh').off('click').on('click', loadBatchChatList);
$('#charMemory_batchExtract').off('click').on('click', runBatchExtraction);
$('#charMemory_batchStop').off('click').on('click', function () {
    if (batchAbortController) batchAbortController.abort();
});
$('#charMemory_batchSelectAll').off('change').on('change', function () {
    const checked = $(this).prop('checked');
    $('.charMemory_batchChatCheck').prop('checked', checked);
    updateBatchButtons();
});
$(document).on('change', '.charMemory_batchChatCheck', updateBatchButtons);
```

**Step 5: Update the tab switching logic**

Find the existing tab click handler (should be in setupListeners) and add `batch` to it. The handler likely toggles `.charMemory_tabContent` visibility based on `data-tab`. Just ensure the new `charMemory_tabBatch` is included.

**Step 6: Commit**

```bash
git add index.js settings.html style.css
git commit -m "feat: batch extraction tab — extract memories from multiple chats"
```

---

## Task 6: Wire up tab switching for the new Batch tab

**Files:**
- Modify: `index.js` (find existing tab handler)

**Step 1: Find and update the tab click handler**

Search for the tab click handler in setupListeners. It should already handle `log` and `diag` tabs. Add `batch`:

The tab handler likely does something like:
```js
$('.charMemory_tab').off('click').on('click', function () {
    const tab = $(this).data('tab');
    $('.charMemory_tab').removeClass('active');
    $(this).addClass('active');
    $('.charMemory_tabContent').hide();
    $(`#charMemory_tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).show();
});
```

The new tab has `data-tab="batch"` and content div `#charMemory_tabBatch`. The capitalization mapping should work: `batch` → `Batch` → `#charMemory_tabBatch`. Verify the existing pattern matches.

**Step 2: Commit (combine with Task 5 if done together)**

---

## Task 7: Test and verify end-to-end

**Files:** None (testing only)

**Step 1: Verify single-chat chunked extraction**

1. Open a character with many messages
2. Reset extraction state
3. Click "Extract Now"
4. Verify: confirmation popup shows if >3 chunks needed
5. Verify: extraction loops through all messages in chunks
6. Verify: `lastExtractedIndex` advances after each chunk
7. Verify: activity log shows chunk-by-chunk progress

**Step 2: Verify batch extraction**

1. Open a character with multiple chats
2. Open Tools & Diagnostics → Batch Extract tab
3. Click Refresh — verify chat list populates
4. Select a few chats, click Extract Selected
5. Verify: confirmation popup
6. Verify: progress bar and per-chat progress
7. Verify: Stop button cancels mid-extraction
8. Verify: memories are tagged with correct chatId
9. Verify: re-running batch skips already-extracted messages

**Step 3: Verify settings UX**

1. Verify sliders moved to Settings drawer
2. Verify labels match new names
3. Verify all slider bindings still work (change values, reload, check persistence)
4. Verify drawer is now labeled "Tools & Diagnostics"

**Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```

---

## Summary

| Task | Description | Files |
|------|------------|-------|
| 1 | Refactor `collectRecentMessages` to accept params, chunk forward | index.js |
| 2 | Add chunked looping to `extractMemories` with cancellation | index.js |
| 3 | Reorganize settings HTML with new labels and grouping | settings.html |
| 4 | Add server API helpers for fetching chats | index.js |
| 5 | Build Batch Extract tab UI and logic | settings.html, index.js, style.css |
| 6 | Wire up tab switching for new Batch tab | index.js |
| 7 | End-to-end testing and verification | - |

---

## Post-Implementation Fixes

Issues discovered during testing and fixed after the initial implementation:

| Fix | Description |
|-----|-------------|
| API response parsing | `fetchCharacterChats` assumed single-key wrapper objects; API returns flat array |
| is_system filter | Some chats have `is_system: true` on all messages (set by other extensions). Changed filter to `is_system && !is_user && !name` |
| Invalid dates | Some `last_mes` values produce Invalid Date in batch list; added `isNaN` guard |
| Progress toasts | Added `progressLabel` parameter so batch shows "Chat 3/10: chatname" context |
| Verbose logging | Added toggle to show full LLM prompts and responses as collapsible entries |
| Content stripping | Strip code blocks, `<details>`, markdown tables, HTML tags from messages before extraction to remove non-diegetic content (relationship metrics, image prompts) |
| Consolidation logging | Added full activity logging with phase/timing/verbose support |
| Memory block merging | Multi-chunk extraction created separate blocks per chunk; added `mergeMemoryBlocks()` post-processing. Merge keys on chat ID only (not chat+date) since chunks get different timestamps |
| Reset + batch state | "Reset Extraction State" now clears `batchState` entries for the character, not just active chat metadata |
| Early return crashes | Five early `return;` in `extractMemories` returned undefined; callers destructured result. Fixed with `noopResult` |
| `?? -1` vs `|| 0` | `lastExtractedIndex` of 0 was treated as "never extracted" by `|| 0`. Changed to `?? -1` |
| XSS in batch list | Chat names sanitized in batch list HTML |
| Batch confirmation | Suppressed per-chat confirmation during batch; added batch-level confirmation instead |

### Known Remaining Issues

| Issue | Description |
|-------|-------------|
| perChat + batch | `getMemoryFileName()` uses `context.chatId` (active chat) so batch-extracted memories from non-active chats go to the wrong file when per-chat mode is enabled |
