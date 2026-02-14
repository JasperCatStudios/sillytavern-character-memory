import {
    eventSource,
    event_types,
    generateQuietPrompt,
    saveSettingsDebounced,
    streamingProcessor,
    chat_metadata,
    characters,
    this_chid,
    substituteParamsExtended,
} from '../../../../script.js';
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    getDataBankAttachmentsForSource,
    getFileAttachment,
    uploadFileAttachmentToServer,
    deleteAttachment,
} from '../../../chats.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { isWebLlmSupported, generateWebLlmChatPrompt } from '../../shared.js';

const MODULE_NAME = 'charMemory';
const DEFAULT_FILE_NAME = 'char-memories.md';
const LOG_PREFIX = '[CharMemory]';

function getMemoryFileName() {
    const custom = extension_settings[MODULE_NAME]?.fileName;
    if (custom && custom !== DEFAULT_FILE_NAME) return custom;

    const charName = getCharacterName();
    if (!charName) return DEFAULT_FILE_NAME;

    const safeName = charName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const perChat = extension_settings[MODULE_NAME]?.perChat;
    if (perChat) {
        const context = getContext();
        const chatId = context.chatId || 'default';
        return `${safeName}-chat${chatId}-memories.md`;
    }
    return `${safeName}-memories.md`;
}

let inApiCall = false;
let lastExtractionResult = null;

const defaultExtractionPrompt = `You are a memory extraction assistant. Read the recent chat messages and extract important character memories.

Character name: {{charName}}

EXISTING MEMORIES (do NOT repeat these):
{{existingMemories}}

RECENT CHAT MESSAGES:
{{recentMessages}}

INSTRUCTIONS:
1. Extract only NEW facts, events, relationships, emotional moments, or significant details NOT already in existing memories.
2. Summarize in third person. Do NOT copy or quote text from the chat verbatim.
3. Do NOT use emojis anywhere in the output.
4. Each memory must be wrapped in <memory></memory> tags.
5. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").
6. Each bullet should be one concise fact or detail about {{char}}.
7. If nothing genuinely new or significant to extract, respond with exactly: NO_NEW_MEMORIES
8. Do NOT extract trivial conversation filler.

EXAMPLE OUTPUT FORMAT:
<memory>
- {{char}} revealed that she grew up in a coastal village north of the capital.
- She mentioned having two older brothers who work as fishermen.
</memory>
<memory>
- {{char}} became visibly upset when the topic of her father was raised.
- She refused to elaborate and changed the subject quickly.
</memory>

Output ONLY <memory> blocks (or NO_NEW_MEMORIES). No headers, no commentary, no extra text.`;

const EXTRACTION_SOURCE = {
    MAIN_LLM: 'main_llm',
    WEBLLM: 'webllm',
};

const defaultSettings = {
    enabled: true,
    interval: 10,
    maxMessagesPerExtraction: 20,
    responseLength: 500,
    extractionPrompt: defaultExtractionPrompt,
    source: EXTRACTION_SOURCE.MAIN_LLM,
    fileName: DEFAULT_FILE_NAME,
    perChat: false,
};

// ============ Structured Memory Helpers ============

/**
 * Parse structured memory markdown into an array of memory objects.
 * @param {string} content Raw markdown content.
 * @returns {{number: number, timestamp: string, text: string}[]}
 */
function parseMemories(content) {
    if (!content || !content.trim()) return [];

    // Split on ## Memory N headers
    const parts = content.split(/^## Memory \d+\s*$/m);
    const memories = [];

    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;

        let timestamp = '';
        let text = part;

        // Extract timestamp line: _Extracted: ..._
        const tsMatch = part.match(/^_Extracted:\s*(.+?)_\s*\n/);
        if (tsMatch) {
            timestamp = tsMatch[1].trim();
            text = part.slice(tsMatch[0].length).trim();
        }

        memories.push({ number: memories.length + 1, timestamp, text });
    }

    return memories;
}

/**
 * Serialize an array of memory objects back to structured markdown.
 * @param {{number?: number, timestamp: string, text: string}[]} memories
 * @returns {string}
 */
function serializeMemories(memories) {
    return memories.map((m, i) => {
        const num = i + 1;
        return `## Memory ${num}\n_Extracted: ${m.timestamp}_\n\n${m.text}`;
    }).join('\n\n');
}

/**
 * Migrate flat-text memories to structured format if needed.
 * @param {string} content Existing file content.
 * @returns {string} Structured content.
 */
function migrateMemoriesIfNeeded(content) {
    if (!content || !content.trim()) return content;

    // Already structured?
    if (/^## Memory \d+/m.test(content)) return content;

    // Wrap entire content as Memory 1
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return `## Memory 1\n_Extracted: ${timestamp}_\n\n${content.trim()}`;
}

// Diagnostics state (session-only, not persisted)
let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    // Migrate old default prompts that used --- separators to the new <memory> block format
    const savedPrompt = extension_settings[MODULE_NAME].extractionPrompt || '';
    if (savedPrompt.includes('Separate each memory with a line containing only')) {
        extension_settings[MODULE_NAME].extractionPrompt = defaultExtractionPrompt;
        saveSettingsDebounced();
    }

    // Migrate old hardcoded default fileName so auto-naming kicks in
    if (extension_settings[MODULE_NAME].fileName === DEFAULT_FILE_NAME) {
        extension_settings[MODULE_NAME].fileName = '';
        saveSettingsDebounced();
    }

    // Bind UI elements to settings
    $('#charMemory_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#charMemory_perChat').prop('checked', extension_settings[MODULE_NAME].perChat);
    $('#charMemory_interval').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_intervalValue').text(extension_settings[MODULE_NAME].interval);
    $('#charMemory_maxMessages').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_maxMessagesValue').text(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_responseLength').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_responseLengthValue').text(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_extractionPrompt').val(extension_settings[MODULE_NAME].extractionPrompt);
    $('#charMemory_source').val(extension_settings[MODULE_NAME].source);
    $('#charMemory_fileName').val(extension_settings[MODULE_NAME].fileName);

    updateStatusDisplay();
}

function ensureMetadata() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            lastExtractedIndex: -1,
            messagesSinceExtraction: 0,
        };
    }
}

function updateStatusDisplay() {
    ensureMetadata();
    const meta = chat_metadata[MODULE_NAME];
    $('#charMemory_messagesSince').text(meta?.messagesSinceExtraction ?? 0);
    $('#charMemory_lastIndex').text(meta?.lastExtractedIndex ?? -1);
}

function getCharacterName() {
    const context = getContext();
    if (context.characterId === undefined) return null;
    return context.name2 || characters[this_chid]?.name || 'Character';
}

/**
 * Find the char-memories.md attachment in character Data Bank.
 * @returns {object|null} The attachment object or null.
 */
function findMemoryAttachment() {
    const attachments = getDataBankAttachmentsForSource('character');
    return attachments.find(a => a.name === getMemoryFileName()) || null;
}

/**
 * Read existing memories from the Data Bank file.
 * @returns {Promise<string>} The file content or empty string.
 */
async function readMemories() {
    const attachment = findMemoryAttachment();
    if (!attachment) return '';

    try {
        let content = await getFileAttachment(attachment.url);
        content = content || '';

        // Auto-migrate flat text to structured format
        const migrated = migrateMemoriesIfNeeded(content);
        if (migrated !== content) {
            console.log(LOG_PREFIX, 'Migrating memories to structured format');
            await writeMemories(migrated);
            return migrated;
        }

        return content;
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to read memories file:', err);
        return '';
    }
}

/**
 * Write memories to the Data Bank file (delete old, upload new).
 * @param {string} content The full content to write.
 */
async function writeMemories(content) {
    // Delete existing file if present
    const existing = findMemoryAttachment();
    if (existing) {
        await deleteAttachment(existing, 'character', () => {}, false);
    }

    // Upload new file
    const file = new File([content], getMemoryFileName(), { type: 'text/plain' });
    await uploadFileAttachmentToServer(file, 'character');
}

/**
 * Collect recent messages for extraction.
 * @returns {string} Formatted messages string.
 */
function collectRecentMessages() {
    ensureMetadata();
    const context = getContext();
    const meta = chat_metadata[MODULE_NAME];
    const chat = context.chat;

    if (!chat || chat.length === 0) return '';

    const startIndex = Math.max(0, (meta.lastExtractedIndex || 0) + 1);
    const maxMessages = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const endIndex = chat.length;

    // Get messages from startIndex to endIndex, limited by maxMessages
    const slice = chat.slice(Math.max(startIndex, endIndex - maxMessages), endIndex);

    const lines = [];
    for (const msg of slice) {
        if (msg.is_system) continue;
        lines.push(`${msg.name}: ${msg.mes}`);
    }

    return lines.join('\n\n');
}

// Approximate character limit for WebLLM prompt content (leaves room for response)
const WEBLLM_MAX_PROMPT_CHARS = 6000;

/**
 * Truncate a string to a maximum character count, breaking at a newline boundary.
 * @param {string} text The text to truncate.
 * @param {number} maxChars Maximum characters.
 * @returns {string}
 */
function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '\n[...truncated]';
}

/**
 * Build the extraction prompt with substitutions.
 * @param {string} existingMemories Current memories content.
 * @param {string} recentMessages Formatted recent messages.
 * @returns {string} The final prompt.
 */
function buildExtractionPrompt(existingMemories, recentMessages) {
    const charName = getCharacterName() || '{{char}}';
    let prompt = extension_settings[MODULE_NAME].extractionPrompt;
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;

    let memories = existingMemories || '(none yet)';
    let messages = recentMessages;

    // Truncate content for WebLLM's smaller context window
    if (isWebLlm) {
        const templateLength = prompt.replace(/\{\{charName\}\}/g, charName)
            .replace(/\{\{existingMemories\}\}/g, '')
            .replace(/\{\{recentMessages\}\}/g, '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        // Give 1/3 to existing memories, 2/3 to recent messages
        const memoriesBudget = Math.floor(available / 3);
        const messagesBudget = available - memoriesBudget;
        memories = truncateText(memories, memoriesBudget);
        messages = truncateText(messages, messagesBudget);
    }

    // Do our custom replacements first
    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, memories);
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, messages);

    // Then let ST handle {{char}}, {{user}}, etc.
    prompt = substituteParamsExtended(prompt);

    return prompt;
}

/**
 * Run memory extraction.
 * @param {boolean} force If true, ignore interval check.
 */
async function extractMemories(force = false) {
    if (inApiCall) {
        console.log(LOG_PREFIX, 'Already in API call, skipping');
        return;
    }

    if (!extension_settings[MODULE_NAME].enabled && !force) {
        return;
    }

    const context = getContext();
    if (context.characterId === undefined) {
        console.log(LOG_PREFIX, 'No character selected');
        return;
    }

    // Check streaming
    if (streamingProcessor && !streamingProcessor.isFinished) {
        console.log(LOG_PREFIX, 'Streaming in progress, skipping');
        return;
    }

    const recentMessages = collectRecentMessages();
    if (!recentMessages) {
        console.log(LOG_PREFIX, 'No new messages to extract');
        toastr.info('No new messages to extract.', 'CharMemory');
        return;
    }

    const existingMemories = await readMemories();
    const prompt = buildExtractionPrompt(existingMemories, recentMessages);

    // Save context identifiers to check for changes after async call
    const savedCharId = context.characterId;
    const savedChatId = context.chatId;

    try {
        inApiCall = true;
        const source = extension_settings[MODULE_NAME].source;
        toastr.info(`Extracting memories via ${source === EXTRACTION_SOURCE.WEBLLM ? 'WebLLM' : 'main LLM'}...`, 'CharMemory', { timeOut: 3000 });

        let result;
        if (source === EXTRACTION_SOURCE.WEBLLM) {
            if (!isWebLlmSupported()) {
                toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                return;
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

        // Verify context hasn't changed
        const newContext = getContext();
        if (newContext.characterId !== savedCharId || newContext.chatId !== savedChatId) {
            console.log(LOG_PREFIX, 'Context changed during extraction, discarding result');
            return;
        }

        let cleanResult = removeReasoningFromString(result);
        cleanResult = cleanResult.trim();

        lastExtractionResult = cleanResult || null;

        if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
            console.log(LOG_PREFIX, 'No new memories extracted');
            toastr.info('No new memories found.', 'CharMemory');
        } else {
            // Parse existing memories
            const existing = parseMemories(existingMemories);
            const now = new Date();
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

            // Parse <memory> blocks; fallback: treat entire result as one entry
            let newEntries;
            const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
            const matches = [...cleanResult.matchAll(memoryRegex)];
            if (matches.length > 0) {
                newEntries = matches.map(m => m[1].trim()).filter(Boolean);
            } else {
                newEntries = [cleanResult.trim()].filter(Boolean);
            }

            for (const entry of newEntries) {
                existing.push({ number: existing.length + 1, timestamp, text: entry });
            }

            await writeMemories(serializeMemories(existing));
            console.log(LOG_PREFIX, 'Memories updated successfully');
            toastr.success(`${newEntries.length} new memor${newEntries.length === 1 ? 'y' : 'ies'} extracted and saved!`, 'CharMemory');
        }

        // Update metadata
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = context.chat.length - 1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();
        updateStatusDisplay();
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        toastr.error('Memory extraction failed. Check console for details.', 'CharMemory');
    } finally {
        inApiCall = false;
    }
}

/**
 * Event handler for CHARACTER_MESSAGE_RENDERED.
 */
function onCharacterMessageRendered() {
    if (!extension_settings[MODULE_NAME].enabled) return;

    const context = getContext();
    if (context.characterId === undefined) return;

    ensureMetadata();
    chat_metadata[MODULE_NAME].messagesSinceExtraction = (chat_metadata[MODULE_NAME].messagesSinceExtraction || 0) + 1;
    saveMetadataDebounced();
    updateStatusDisplay();

    const count = chat_metadata[MODULE_NAME].messagesSinceExtraction;
    const interval = extension_settings[MODULE_NAME].interval;

    if (count >= interval) {
        extractMemories(false);
    }
}

/**
 * Event handler for CHAT_CHANGED — reset status display.
 */
function onChatChanged() {
    updateStatusDisplay();
}

// ============ Diagnostics ============

/**
 * Capture diagnostics data from WORLD_INFO_ACTIVATED event.
 */
function onWorldInfoActivated(entries) {
    lastDiagnostics.worldInfoEntries = Array.isArray(entries) ? entries.map(e => ({
        comment: e.comment || e.key?.join(', ') || '(unnamed)',
        keys: Array.isArray(e.key) ? e.key : [],
        content: e.content ? e.content.substring(0, 200) : '',
        uid: e.uid,
    })) : [];
}

/**
 * Capture diagnostics from extension prompts after generation.
 */
function captureDiagnostics() {
    const context = getContext();
    lastDiagnostics.extensionPrompts = {};
    lastDiagnostics.timestamp = new Date().toLocaleTimeString();

    if (context.extensionPrompts) {
        for (const [key, value] of Object.entries(context.extensionPrompts)) {
            if (value && value.value) {
                lastDiagnostics.extensionPrompts[key] = {
                    label: key,
                    content: typeof value.value === 'string' ? value.value.substring(0, 300) : String(value.value).substring(0, 300),
                    position: value.position,
                    depth: value.depth,
                };
            }
        }
    }

    // Store in history (keep last 5)
    diagnosticsHistory.unshift({ ...lastDiagnostics, worldInfoEntries: [...lastDiagnostics.worldInfoEntries] });
    if (diagnosticsHistory.length > 5) diagnosticsHistory.pop();

    updateDiagnosticsDisplay();
}

function updateDiagnosticsDisplay() {
    const container = $('#charMemory_diagnosticsContent');
    if (!container.length) return;

    let html = '';

    // Timestamp
    if (lastDiagnostics.timestamp) {
        html += `<div class="charMemory_diagTimestamp">Last capture: ${lastDiagnostics.timestamp}</div>`;
    }

    // Memory Info
    html += '<div class="charMemory_diagSection"><strong>Memories</strong>';
    const memFileName = getMemoryFileName();
    const memAttachment = findMemoryAttachment();
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Active file name</div>
        <div class="charMemory_diagCardContent">${escapeHtml(memFileName)}</div>
    </div>`;
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">File status</div>
        <div class="charMemory_diagCardContent">${memAttachment ? 'Exists in Data Bank' : 'Not found in Data Bank'}</div>
    </div>`;

    if (memAttachment) {
        // Read content synchronously from cache is not possible, so show count from last known state
        // We do an async read and update when available
        getFileAttachment(memAttachment.url).then(content => {
            const memories = parseMemories(content || '');
            const countEl = document.getElementById('charMemory_diagMemoryCount');
            if (countEl) countEl.textContent = String(memories.length);
        }).catch(() => {});
    }
    const countDisplay = memAttachment ? '...' : '0';
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Memory count</div>
        <div class="charMemory_diagCardContent" id="charMemory_diagMemoryCount">${countDisplay}</div>
    </div>`;

    if (lastExtractionResult) {
        const truncated = lastExtractionResult.length > 500
            ? lastExtractionResult.substring(0, 500) + '...'
            : lastExtractionResult;
        html += `<div class="charMemory_diagCard">
            <div class="charMemory_diagCardTitle">Last extraction result</div>
            <div class="charMemory_diagCardContent">${escapeHtml(truncated)}</div>
        </div>`;
    }
    html += '</div>';

    // World Info Entries
    const wiEntries = lastDiagnostics.worldInfoEntries;
    html += `<div class="charMemory_diagSection"><strong>Lorebook Entries (${wiEntries.length} active)</strong>`;
    if (wiEntries.length > 0) {
        for (const entry of wiEntries) {
            const keysStr = entry.keys.length > 0 ? entry.keys.join(', ') : '(no keys)';
            html += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(entry.comment)}</div>
                <div class="charMemory_diagCardKeys">Keys: ${escapeHtml(keysStr)}</div>
                <div class="charMemory_diagCardContent">${escapeHtml(entry.content)}${entry.content.length >= 200 ? '...' : ''}</div>
            </div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No lorebook entries activated</div>';
    }
    html += '</div>';

    // Extension Prompts
    const prompts = lastDiagnostics.extensionPrompts;
    const promptKeys = Object.keys(prompts);
    html += `<div class="charMemory_diagSection"><strong>Extension Prompts (${promptKeys.length})</strong>`;
    if (promptKeys.length > 0) {
        for (const key of promptKeys) {
            const p = prompts[key];
            html += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(p.label)}</div>
                <div class="charMemory_diagCardContent">${escapeHtml(p.content)}${p.content.length >= 300 ? '...' : ''}</div>
            </div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No extension prompts active</div>';
    }
    html += '</div>';

    container.html(html);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============ Memory Manager ============

async function showMemoryManager() {
    const content = await readMemories();
    const memories = parseMemories(content);

    if (memories.length === 0) {
        callGenericPopup('No memories yet.', POPUP_TYPE.TEXT);
        return;
    }

    let html = '<div class="charMemory_manager">';
    for (let i = 0; i < memories.length; i++) {
        const m = memories[i];
        html += `<div class="charMemory_card" data-index="${i}">
            <div class="charMemory_cardHeader">
                <span class="charMemory_cardTitle">Memory ${i + 1}</span>
                <span class="charMemory_cardTimestamp">${escapeHtml(m.timestamp)}</span>
                <span class="charMemory_cardActions">
                    <button class="charMemory_editBtn menu_button menu_button_icon" data-index="${i}" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="charMemory_deleteBtn menu_button menu_button_icon" data-index="${i}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            <div class="charMemory_cardBody">${escapeHtml(m.text)}</div>
        </div>`;
    }
    html += '</div>';

    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Wire up event handlers using delegation
    $(document).off('click.charMemoryManager').on('click.charMemoryManager', '.charMemory_editBtn', async function (e) {
        e.stopPropagation();
        const idx = Number($(this).data('index'));
        await editMemory(idx);
    });

    $(document).off('click.charMemoryDelete').on('click.charMemoryDelete', '.charMemory_deleteBtn', async function (e) {
        e.stopPropagation();
        const idx = Number($(this).data('index'));
        await deleteMemory(idx);
    });

    // Clean up when popup closes
    popup.finally(() => {
        $(document).off('click.charMemoryManager');
        $(document).off('click.charMemoryDelete');
    });
}

async function editMemory(index) {
    const content = await readMemories();
    const memories = parseMemories(content);

    if (index < 0 || index >= memories.length) return;

    const edited = await callGenericPopup('Edit memory:', POPUP_TYPE.INPUT, memories[index].text, { rows: 6 });

    if (edited === null || edited === false) return; // cancelled

    memories[index].text = String(edited).trim();
    await writeMemories(serializeMemories(memories));
    toastr.success('Memory updated.', 'CharMemory');
    showMemoryManager(); // refresh
}

async function deleteMemory(index) {
    const content = await readMemories();
    const memories = parseMemories(content);

    if (index < 0 || index >= memories.length) return;

    const confirm = await callGenericPopup(`Delete Memory ${index + 1}?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    memories.splice(index, 1);
    await writeMemories(serializeMemories(memories));
    toastr.success('Memory deleted.', 'CharMemory');
    showMemoryManager(); // refresh
}

// ============ Consolidation ============

const consolidationPrompt = `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
1. Merge duplicate or near-duplicate memories into one.
2. Combine closely related facts about the same event or topic.
3. Preserve all unique information — do NOT discard distinct memories.
4. Summarize in third person. Do NOT copy text verbatim from the input.
5. Do NOT use emojis anywhere in the output.
6. Each consolidated memory must be wrapped in <memory></memory> tags.
7. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").

MEMORIES TO CONSOLIDATE:
{{memories}}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;

async function consolidateMemories() {
    if (inApiCall) {
        toastr.warning('An API call is already in progress.', 'CharMemory');
        return;
    }

    const content = await readMemories();
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info('Not enough memories to consolidate.', 'CharMemory');
        return;
    }

    const beforeCount = memories.length;
    let memoriesText = memories.map((m, i) => `[Memory ${i + 1}]\n${m.text}`).join('\n\n');

    // Truncate for WebLLM's smaller context window
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    if (isWebLlm) {
        const templateLength = consolidationPrompt.replace('{{memories}}', '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        memoriesText = truncateText(memoriesText, available);
    }

    let prompt = consolidationPrompt.replace('{{memories}}', memoriesText);
    prompt = substituteParamsExtended(prompt);

    try {
        inApiCall = true;
        const source = extension_settings[MODULE_NAME].source;
        toastr.info(`Consolidating ${beforeCount} memories via ${source === EXTRACTION_SOURCE.WEBLLM ? 'WebLLM' : 'main LLM'}...`, 'CharMemory', { timeOut: 3000 });

        let result;
        if (source === EXTRACTION_SOURCE.WEBLLM) {
            if (!isWebLlmSupported()) {
                toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                return;
            }
            const messages = [
                { role: 'system', content: 'You are a memory consolidation assistant.' },
                { role: 'user', content: prompt },
            ];
            result = await generateWebLlmChatPrompt(messages, {
                max_tokens: extension_settings[MODULE_NAME].responseLength * 2,
            });
        } else {
            result = await generateQuietPrompt({
                quietPrompt: prompt,
                skipWIAN: true,
                responseLength: extension_settings[MODULE_NAME].responseLength * 2,
            });
        }

        let cleanResult = removeReasoningFromString(result);
        cleanResult = cleanResult.trim();

        if (!cleanResult) {
            toastr.warning('Consolidation returned empty result. Memories unchanged.', 'CharMemory');
            return;
        }

        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        let newEntries;
        const consolidationRegex = /<memory>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        if (consolidationMatches.length > 0) {
            newEntries = consolidationMatches.map(m => m[1].trim()).filter(Boolean);
        } else {
            newEntries = [cleanResult.trim()].filter(Boolean);
        }

        const consolidated = newEntries.map((text, i) => ({
            number: i + 1,
            timestamp,
            text,
        }));

        await writeMemories(serializeMemories(consolidated));
        const afterCount = consolidated.length;
        toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
        console.log(LOG_PREFIX, `Consolidation: ${beforeCount} → ${afterCount}`);
    } catch (err) {
        console.error(LOG_PREFIX, 'Consolidation failed:', err);
        toastr.error('Memory consolidation failed. Check console for details.', 'CharMemory');
    } finally {
        inApiCall = false;
    }
}

// ============ Slash Commands ============

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'extract-memories',
        callback: async () => {
            await extractMemories(true);
            return '';
        },
        helpString: 'Force memory extraction from recent chat messages.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'consolidate-memories',
        callback: async () => {
            await consolidateMemories();
            return '';
        },
        helpString: 'Consolidate character memories by merging duplicates and related entries.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'charmemory-debug',
        callback: async () => {
            captureDiagnostics();
            console.log(LOG_PREFIX, 'Diagnostics:', lastDiagnostics);
            console.log(LOG_PREFIX, 'History:', diagnosticsHistory);
            toastr.info('Diagnostics captured. Check console and Diagnostics panel.', 'CharMemory');
            return '';
        },
        helpString: 'Capture and display CharMemory diagnostics data.',
    }));
}

// ============ UI Setup ============

function setupListeners() {
    $('#charMemory_enabled').off('change').on('change', function () {
        extension_settings[MODULE_NAME].enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_interval').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].interval = val;
        $('#charMemory_intervalValue').text(val);
        saveSettingsDebounced();
    });

    $('#charMemory_maxMessages').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].maxMessagesPerExtraction = val;
        $('#charMemory_maxMessagesValue').text(val);
        saveSettingsDebounced();
    });

    $('#charMemory_responseLength').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].responseLength = val;
        $('#charMemory_responseLengthValue').text(val);
        saveSettingsDebounced();
    });

    $('#charMemory_source').off('change').on('change', function () {
        extension_settings[MODULE_NAME].source = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_extractionPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].extractionPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_restorePrompt').off('click').on('click', function () {
        extension_settings[MODULE_NAME].extractionPrompt = defaultExtractionPrompt;
        $('#charMemory_extractionPrompt').val(defaultExtractionPrompt);
        saveSettingsDebounced();
        toastr.info('Extraction prompt restored to default.', 'CharMemory');
    });

    $('#charMemory_extractNow').off('click').on('click', function () {
        extractMemories(true);
    });

    $('#charMemory_resetExtraction').off('click').on('click', async function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();

        // Also clear stored memories so re-extraction starts fresh
        const existing = findMemoryAttachment();
        if (existing) {
            await deleteAttachment(existing, 'character', () => {}, false);
        }

        updateStatusDisplay();
        toastr.success('Memories cleared and extraction state reset. Next extraction will start from the beginning.', 'CharMemory');
    });

    $('#charMemory_fileName').off('input').on('input', function () {
        const val = String($(this).val()).trim();
        extension_settings[MODULE_NAME].fileName = val;
        saveSettingsDebounced();
    });

    $('#charMemory_perChat').off('change').on('change', function () {
        extension_settings[MODULE_NAME].perChat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_manageMemories').off('click').on('click', () => showMemoryManager());

    $('#charMemory_consolidate').off('click').on('click', () => consolidateMemories());

    $('#charMemory_refreshDiag').off('click').on('click', function () {
        captureDiagnostics();
        toastr.info('Diagnostics refreshed.', 'CharMemory');
    });
}

// ============ Init ============

jQuery(async function () {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/sillytavern-character-memory', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    setupListeners();
    registerSlashCommands();

    // Event hooks
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Diagnostics hooks
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, captureDiagnostics);

    console.log(LOG_PREFIX, 'Extension loaded');
});
