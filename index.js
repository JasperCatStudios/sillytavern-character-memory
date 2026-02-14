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
const MEMORY_FILE_NAME = 'char-memories.md';
const LOG_PREFIX = '[CharMemory]';

let inApiCall = false;

const defaultExtractionPrompt = `You are a memory extraction assistant. Read the recent chat messages and extract important character memories.

Character name: {{charName}}

EXISTING MEMORIES (do NOT repeat these):
{{existingMemories}}

RECENT CHAT MESSAGES:
{{recentMessages}}

INSTRUCTIONS:
1. Extract only NEW facts, events, relationships, emotional moments, or significant details NOT already in existing memories.
2. Write each memory as a third-person narrative paragraph starting with "{{char}} ..." (e.g., "{{char}} remembers...", "{{char}} learned that...", "{{char}} felt...").
3. Include specific details: names, dates, locations, emotions, actions, and outcomes.
4. Each memory should be 2-4 self-contained sentences.
5. If nothing genuinely new or significant to extract, respond with exactly: NO_NEW_MEMORIES
6. Do NOT extract trivial conversation filler.
7. Separate each memory with a blank line.

Output ONLY the memory paragraphs (or NO_NEW_MEMORIES). No headers, no commentary.`;

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
};

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

    // Bind UI elements to settings
    $('#charMemory_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#charMemory_interval').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_intervalValue').text(extension_settings[MODULE_NAME].interval);
    $('#charMemory_maxMessages').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_maxMessagesValue').text(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_responseLength').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_responseLengthValue').text(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_extractionPrompt').val(extension_settings[MODULE_NAME].extractionPrompt);
    $('#charMemory_source').val(extension_settings[MODULE_NAME].source);

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
    return attachments.find(a => a.name === MEMORY_FILE_NAME) || null;
}

/**
 * Read existing memories from the Data Bank file.
 * @returns {Promise<string>} The file content or empty string.
 */
async function readMemories() {
    const attachment = findMemoryAttachment();
    if (!attachment) return '';

    try {
        const content = await getFileAttachment(attachment.url);
        return content || '';
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
    const file = new File([content], MEMORY_FILE_NAME, { type: 'text/plain' });
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

/**
 * Build the extraction prompt with substitutions.
 * @param {string} existingMemories Current memories content.
 * @param {string} recentMessages Formatted recent messages.
 * @returns {string} The final prompt.
 */
function buildExtractionPrompt(existingMemories, recentMessages) {
    const charName = getCharacterName() || '{{char}}';
    let prompt = extension_settings[MODULE_NAME].extractionPrompt;

    // Do our custom replacements first
    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, existingMemories || '(none yet)');
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, recentMessages);

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

        if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
            console.log(LOG_PREFIX, 'No new memories extracted');
            toastr.info('No new memories found.', 'CharMemory');
        } else {
            // Append to existing memories
            const separator = existingMemories ? '\n\n' : '';
            const newContent = existingMemories + separator + cleanResult;
            await writeMemories(newContent);
            console.log(LOG_PREFIX, 'Memories updated successfully');
            toastr.success('New memories extracted and saved!', 'CharMemory');
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

    $('#charMemory_viewMemories').off('click').on('click', async function () {
        const content = await readMemories();
        const displayContent = content || '(No memories yet)';
        callGenericPopup(`<pre style="white-space: pre-wrap; max-height: 60vh; overflow-y: auto;">${escapeHtml(displayContent)}</pre>`, POPUP_TYPE.TEXT);
    });

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
