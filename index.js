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
    getRequestHeaders,
} from '../../../../script.js';
import { getStringHash } from '../../../utils.js';
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
let consolidationBackup = null;

// ============ Activity Log ============

const MAX_LOG_ENTRIES = 50;
let activityLog = [];

function logActivity(message, type = 'info') {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    activityLog.unshift({ timestamp, message, type });
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
    updateActivityLogDisplay();
}

function updateActivityLogDisplay() {
    const $container = $('#charMemory_activityLog');
    if (!$container.length) return;

    if (activityLog.length === 0) {
        $container.html('<div class="charMemory_diagEmpty">No activity yet.</div>');
        return;
    }

    const html = activityLog.map(entry => {
        const typeClass = `charMemory_log_${entry.type}`;
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${escapeHtml(entry.message)}</div>`;
    }).join('');
    $container.html(html);
}

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
    NANOGPT: 'nanogpt',
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
    nanogptApiKey: '',
    nanogptModel: '',
    nanogptSystemPrompt: '',
    nanogptFilterSubscription: false,
    nanogptFilterOpenSource: false,
    nanogptFilterRoleplay: false,
    nanogptFilterReasoning: false,
};

// ============ Structured Memory Helpers ============

/**
 * Parse <memory> tag blocks into an array of memory objects.
 * @param {string} content Raw file content.
 * @returns {{chat: string, date: string, bullets: string[]}[]}
 */
function parseMemories(content) {
    if (!content || !content.trim()) return [];

    const blocks = [];
    const regex = /<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const attrs = match[1];
        const body = match[2];

        // Extract chat and date attributes
        const chatMatch = attrs.match(/chat="([^"]*)"/);
        const dateMatch = attrs.match(/date="([^"]*)"/);
        const chat = chatMatch ? chatMatch[1] : 'unknown';
        const date = dateMatch ? dateMatch[1] : '';

        // Extract bullets (lines starting with "- ")
        const bullets = body.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean);

        if (bullets.length > 0) {
            blocks.push({ chat, date, bullets });
        }
    }

    return blocks;
}

/**
 * Count total individual memories (bullets) across all blocks.
 * @param {{bullets: string[]}[]} blocks Parsed memory blocks.
 * @returns {number}
 */
function countMemories(blocks) {
    return blocks.reduce((sum, b) => sum + b.bullets.length, 0);
}

/**
 * Serialize an array of memory blocks back to <memory> tag format.
 * @param {{chat: string, date: string, bullets: string[]}[]} blocks
 * @returns {string}
 */
function serializeMemories(blocks) {
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${b.chat}" date="${b.date}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}

/**
 * Migrate old memory formats to <memory> tag format if needed.
 * @param {string} content Existing file content.
 * @returns {string} Content in <memory> tag format.
 */
function migrateMemoriesIfNeeded(content) {
    if (!content || !content.trim()) return content;

    // Already in <memory> tag format?
    if (/<memory\b[^>]*>/i.test(content)) return content;

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Old ## Memory N format?
    if (/^## Memory \d+/m.test(content)) {
        const parts = content.split(/^## Memory \d+\s*$/m);
        const blocks = [];

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;

            let date = timestamp;
            let text = part;

            // Extract old timestamp: _Extracted: ..._
            const tsMatch = part.match(/^_Extracted:\s*(.+?)_\s*\n/);
            if (tsMatch) {
                date = tsMatch[1].trim();
                text = part.slice(tsMatch[0].length).trim();
            }

            // Extract bullets or wrap plain text as a single bullet
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const bullets = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
            if (bullets.length === 0 && text.trim()) {
                bullets.push(text.trim());
            }

            if (bullets.length > 0) {
                blocks.push({ chat: 'unknown', date, bullets });
            }
        }

        return serializeMemories(blocks);
    }

    // Completely flat text — wrap as a single block
    const lines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    if (bullets.length === 0) {
        bullets.push(content.trim());
    }
    return serializeMemories([{ chat: 'unknown', date: timestamp, bullets }]);
}

// Diagnostics state (session-only, not persisted)
let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];

/**
 * Toggle NanoGPT settings panel visibility and load models if needed.
 * @param {string} source Current extraction source value.
 */
function toggleNanoGptSettings(source) {
    const isNanoGpt = source === EXTRACTION_SOURCE.NANOGPT;
    $('#charMemory_nanogptSettings').toggle(isNanoGpt);
    if (isNanoGpt) {
        populateNanoGptModels();
    }
}

/**
 * Filter NanoGPT models based on active filter toggles.
 * When multiple filters are active, their intersection is applied.
 * @param {object[]} models Full model list.
 * @returns {object[]} Filtered model list.
 */
function getFilteredNanoGptModels(models) {
    const s = extension_settings[MODULE_NAME];
    const hasAnyFilter = s.nanogptFilterSubscription || s.nanogptFilterOpenSource || s.nanogptFilterRoleplay || s.nanogptFilterReasoning;
    if (!hasAnyFilter) return models;

    return models.filter(m => {
        if (s.nanogptFilterSubscription && m.subscription !== true) return false;
        if (s.nanogptFilterOpenSource && m.isOpenSource !== true) return false;
        if (s.nanogptFilterRoleplay && m.category !== 'Roleplay/storytelling models') return false;
        if (s.nanogptFilterReasoning && !m.capabilities.includes('reasoning')) return false;
        return true;
    });
}

/**
 * Populate the NanoGPT model dropdown.
 * @param {boolean} forceRebuild If true, rebuild dropdown using cached data (skip the "already populated" check).
 */
async function populateNanoGptModels(forceRebuild = false) {
    const $select = $('#charMemory_nanogptModel');
    // Skip if already populated (beyond the default option), unless forced
    if (!forceRebuild && $select.find('option').length > 1 && !$select.data('needsRefresh')) return;

    try {
        const models = await fetchNanoGptModels();
        const filtered = getFilteredNanoGptModels(models);

        // Remember current selection before rebuilding
        const currentVal = $select.val() || extension_settings[MODULE_NAME].nanogptModel;

        $select.empty().append('<option value="">-- Select model --</option>');

        // Group by provider
        const byProvider = {};
        for (const m of filtered) {
            if (!byProvider[m.provider]) byProvider[m.provider] = [];
            byProvider[m.provider].push(m);
        }

        for (const [provider, providerModels] of Object.entries(byProvider)) {
            const $group = $(`<optgroup label="${escapeHtml(provider)}">`);
            for (const m of providerModels) {
                const subTag = m.subscription ? ' [Sub]' : '';
                $group.append(`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${m.cost})${subTag}</option>`);
            }
            $select.append($group);
        }

        // Preserve selected model if still in filtered list; otherwise reset
        if (currentVal && filtered.some(m => m.id === currentVal)) {
            $select.val(currentVal);
            updateNanoGptModelInfo(models, currentVal);
        } else {
            $select.val('');
            extension_settings[MODULE_NAME].nanogptModel = '';
            saveSettingsDebounced();
            $('#charMemory_nanogptModelInfo').text('');
        }

        $select.data('needsRefresh', false);
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to fetch NanoGPT models:', err);
        toastr.error('Failed to load NanoGPT models. Check console.', 'CharMemory');
    }
}

/**
 * Update the model info text below the dropdown.
 * @param {{id: string, name: string, cost: string, provider: string, maxInputTokens: number, maxOutputTokens: number}[]} models
 * @param {string} modelId
 */
function updateNanoGptModelInfo(models, modelId) {
    const info = models.find(m => m.id === modelId);
    if (info) {
        const parts = [`Provider: ${info.provider}`, `Cost: ${info.cost}`];
        if (info.maxInputTokens) parts.push(`Input: ${info.maxInputTokens.toLocaleString()} tokens`);
        if (info.maxOutputTokens) parts.push(`Output: ${info.maxOutputTokens.toLocaleString()} tokens`);
        parts.push(info.subscription ? 'Included in subscription' : 'Pay-per-use');
        $('#charMemory_nanogptModelInfo').text(parts.join(' | '));
    } else {
        $('#charMemory_nanogptModelInfo').text('');
    }
}

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

    // NanoGPT settings
    $('#charMemory_nanogptApiKey').val(extension_settings[MODULE_NAME].nanogptApiKey);
    $('#charMemory_nanogptSystemPrompt').val(extension_settings[MODULE_NAME].nanogptSystemPrompt);
    $('#charMemory_nanogptFilterSub').prop('checked', extension_settings[MODULE_NAME].nanogptFilterSubscription);
    $('#charMemory_nanogptFilterOS').prop('checked', extension_settings[MODULE_NAME].nanogptFilterOpenSource);
    $('#charMemory_nanogptFilterRP').prop('checked', extension_settings[MODULE_NAME].nanogptFilterRoleplay);
    $('#charMemory_nanogptFilterReasoning').prop('checked', extension_settings[MODULE_NAME].nanogptFilterReasoning);
    toggleNanoGptSettings(extension_settings[MODULE_NAME].source);

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

    // Stats bar: file name
    const charName = getCharacterName();
    if (charName) {
        const fileName = getMemoryFileName();
        $('#charMemory_statFile').text(fileName).attr('title', fileName);
    } else {
        $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
    }

    // Stats bar: memory count (total bullets, async)
    const attachment = findMemoryAttachment();
    if (attachment) {
        getFileAttachment(attachment.url).then(content => {
            const blocks = parseMemories(content || '');
            const count = countMemories(blocks);
            $('#charMemory_statCount').text(`${count} memor${count === 1 ? 'y' : 'ies'}`);
        }).catch(() => {
            $('#charMemory_statCount').text('? memories');
        });
    } else {
        $('#charMemory_statCount').text('0 memories');
    }
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
 * @param {number|null} endIndex Optional end message index (inclusive). Defaults to last message.
 * @returns {string} Formatted messages string.
 */
function collectRecentMessages(endIndex = null) {
    ensureMetadata();
    const context = getContext();
    const meta = chat_metadata[MODULE_NAME];
    const chat = context.chat;

    if (!chat || chat.length === 0) return '';

    const startIndex = Math.max(0, (meta.lastExtractedIndex || 0) + 1);
    const maxMessages = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const end = endIndex !== null ? endIndex + 1 : chat.length;

    logActivity(`collectRecentMessages: lastExtractedIndex=${meta.lastExtractedIndex}, startIndex=${startIndex}, end=${end}, chatLength=${chat.length}`);

    // Get messages from startIndex to end, limited by maxMessages
    const sliceStart = Math.max(startIndex, end - maxMessages);
    const slice = chat.slice(sliceStart, end);

    const lines = [];
    for (const msg of slice) {
        if (msg.is_system) continue;
        lines.push(`${msg.name}: ${msg.mes}`);
    }

    logActivity(`Collected ${lines.length} messages (indices ${sliceStart}-${end - 1})`);
    return lines.join('\n\n');
}

// ============ NanoGPT API Helpers ============

let cachedNanoGptModels = null;

/**
 * Fetch available text models from NanoGPT, with subscription status.
 * @returns {Promise<{id: string, name: string, cost: string, provider: string, subscription: boolean, maxInputTokens: number, maxOutputTokens: number}[]>}
 */
async function fetchNanoGptModels() {
    if (cachedNanoGptModels) return cachedNanoGptModels;

    // Fetch full model list and subscription model list in parallel
    const [modelsResponse, subResponse] = await Promise.all([
        fetch('https://nano-gpt.com/api/models'),
        fetch('https://nano-gpt.com/api/subscription/v1/models').catch(() => null),
    ]);

    if (!modelsResponse.ok) {
        throw new Error(`Failed to fetch NanoGPT models: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }

    const data = await modelsResponse.json();
    const textModels = data?.models?.text;
    if (!textModels || typeof textModels !== 'object') {
        throw new Error('Unexpected NanoGPT models response format');
    }

    // Build set of subscription model IDs
    const subscriptionIds = new Set();
    if (subResponse && subResponse.ok) {
        try {
            const subData = await subResponse.json();
            const subModels = subData?.data || [];
            for (const m of subModels) {
                if (m.id) subscriptionIds.add(m.id);
            }
        } catch { /* ignore parse error */ }
    }

    const models = [];
    for (const [id, info] of Object.entries(textModels)) {
        if (!info.visible) continue;
        models.push({
            id,
            name: info.name || id,
            cost: info.inputCost != null ? `$${info.inputCost}/${info.outputCost}` : 'N/A',
            provider: info.provider || 'unknown',
            maxInputTokens: info.maxInputTokens || 0,
            maxOutputTokens: info.maxOutputTokens || 0,
            subscription: subscriptionIds.has(id),
            isOpenSource: !!info.isOpenSource,
            category: info.category || '',
            capabilities: Array.isArray(info.capabilities) ? info.capabilities : [],
            costEstimate: info.costEstimate || 0,
        });
    }

    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    cachedNanoGptModels = models;
    return models;
}

/**
 * Generate a response using NanoGPT's OpenAI-compatible API.
 * @param {{role: string, content: string}[]} messages Chat messages.
 * @param {number} maxTokens Max tokens for response.
 * @returns {Promise<string>} The assistant's response content.
 */
async function generateNanoGptResponse(messages, maxTokens) {
    const apiKey = extension_settings[MODULE_NAME].nanogptApiKey;
    const model = extension_settings[MODULE_NAME].nanogptModel;

    if (!apiKey) {
        throw new Error('NanoGPT API key is not set. Configure it in Character Memory settings.');
    }
    if (!model) {
        throw new Error('NanoGPT model is not selected. Choose a model in Character Memory settings.');
    }

    const response = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.3,
        }),
    });

    if (!response.ok) {
        let errorMsg = `NanoGPT API error: ${response.status}`;
        try {
            const errorBody = await response.json();
            errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
        } catch { /* ignore parse error */ }
        throw new Error(errorMsg);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

/**
 * Test the NanoGPT API connection with a minimal request.
 */
async function testNanoGptConnection() {
    const apiKey = extension_settings[MODULE_NAME].nanogptApiKey;
    if (!apiKey) {
        toastr.error('Enter an API key first.', 'CharMemory');
        return;
    }

    const $btn = $('#charMemory_nanogptTest');
    $btn.prop('disabled', true);

    try {
        const response = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4.1-nano',
                messages: [{ role: 'user', content: 'Say OK' }],
                max_tokens: 3,
            }),
        });

        if (!response.ok) {
            let errorMsg = `HTTP ${response.status}`;
            try {
                const errorBody = await response.json();
                errorMsg = errorBody.error?.message || errorMsg;
            } catch { /* ignore */ }
            toastr.error(errorMsg, 'CharMemory');
            return;
        }

        logActivity('NanoGPT connection test successful', 'success');
        toastr.success('Connection successful!', 'CharMemory');
    } catch (err) {
        logActivity(`NanoGPT connection test failed: ${err.message}`, 'error');
        toastr.error(err.message || 'Connection failed', 'CharMemory');
    } finally {
        $btn.prop('disabled', false);
    }
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
 * @param {number|null} endIndex Optional end message index (inclusive). Defaults to last message.
 */
async function extractMemories(force = false, endIndex = null) {
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

    logActivity(`Extraction triggered (${force ? 'manual' : 'auto'}), endIndex=${endIndex ?? 'last'}`);

    const recentMessages = collectRecentMessages(endIndex);
    if (!recentMessages) {
        console.log(LOG_PREFIX, 'No new messages to extract');
        logActivity('No new messages to extract — collectRecentMessages returned empty', 'warning');
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
        const sourceLabel = source === EXTRACTION_SOURCE.WEBLLM ? 'WebLLM' : source === EXTRACTION_SOURCE.NANOGPT ? 'NanoGPT' : 'main LLM';
        toastr.info(`Extracting memories via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

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
            logActivity('LLM returned NO_NEW_MEMORIES — lastExtractedIndex not advanced', 'warning');
            toastr.info('No new memories found.', 'CharMemory');
        } else {
            // Parse existing memory blocks
            const existing = parseMemories(existingMemories);
            const now = new Date();
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const chatId = context.chatId || 'unknown';

            // Parse <memory> blocks from LLM response; fallback: treat entire result as one block
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
                // If no bullets found, treat the whole entry as a single bullet
                const finalBullets = bullets.length > 0 ? bullets : [entry];
                existing.push({ chat: chatId, date: timestamp, bullets: finalBullets });
                newBulletCount += finalBullets.length;
            }

            await writeMemories(serializeMemories(existing));
            console.log(LOG_PREFIX, 'Memories updated successfully');
            logActivity(`Saved ${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'}`, 'success');
            toastr.success(`${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'} extracted and saved!`, 'CharMemory');

            // Only advance lastExtractedIndex when memories were actually found
            ensureMetadata();
            chat_metadata[MODULE_NAME].lastExtractedIndex = endIndex !== null ? endIndex : context.chat.length - 1;
            logActivity(`Advanced lastExtractedIndex to ${chat_metadata[MODULE_NAME].lastExtractedIndex}`);
        }

        // Always reset message counter to prevent re-trigger loops
        ensureMetadata();
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();
        updateStatusDisplay();
        updateAllIndicators();
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        logActivity(`Extraction failed: ${err.message}`, 'error');
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
    const context = getContext();
    const chatId = context.chatId || '(none)';
    const charName = getCharacterName() || '(none)';
    const msgCount = context.chat ? context.chat.length : 0;

    logActivity(`Chat changed: "${charName}" chat=${chatId} (${msgCount} messages)`);

    // Seed messagesSinceExtraction with unextracted message count so
    // automatic extraction triggers correctly after switching chats.
    ensureMetadata();
    const meta = chat_metadata[MODULE_NAME];
    const lastIdx = meta.lastExtractedIndex ?? -1;
    const unextracted = msgCount > 0 ? msgCount - 1 - lastIdx : 0;

    logActivity(`Extraction state: lastExtractedIndex=${lastIdx}, messagesSinceExtraction=${meta.messagesSinceExtraction}, unextracted=${unextracted}`);

    if (unextracted > 0 && meta.messagesSinceExtraction < unextracted) {
        meta.messagesSinceExtraction = unextracted;
        saveMetadataDebounced();
        logActivity(`Seeded messagesSinceExtraction=${unextracted}`);
    }

    updateStatusDisplay();
    updateAllIndicators();
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

/**
 * Check vectorization status for a file URL.
 * @param {string} fileUrl The attachment URL.
 * @returns {Promise<number|false|null>} Number of chunks if vectorized, false if not, null if vectors unavailable.
 */
async function checkVectorizationStatus(fileUrl) {
    try {
        const collectionId = `file_${getStringHash(fileUrl)}`;
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ collectionId }),
        });
        if (!response.ok) return null;
        const hashes = await response.json();
        return hashes.length > 0 ? hashes.length : false;
    } catch {
        return null;
    }
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
        // Async read and update when available
        getFileAttachment(memAttachment.url).then(content => {
            const blocks = parseMemories(content || '');
            const count = countMemories(blocks);
            const countEl = document.getElementById('charMemory_diagMemoryCount');
            if (countEl) countEl.textContent = `${count} (in ${blocks.length} block${blocks.length === 1 ? '' : 's'})`;
        }).catch(() => {});

        // Vectorization status (async)
        checkVectorizationStatus(memAttachment.url).then(result => {
            const vecEl = document.getElementById('charMemory_diagVectorization');
            if (!vecEl) return;
            if (result === null) {
                vecEl.textContent = 'N/A (vectors not enabled)';
            } else if (result === false) {
                vecEl.textContent = 'No';
            } else {
                vecEl.textContent = `Yes (${result} chunk${result === 1 ? '' : 's'})`;
            }
        }).catch(() => {});
    }
    const countDisplay = memAttachment ? '...' : '0';
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Memory count</div>
        <div class="charMemory_diagCardContent" id="charMemory_diagMemoryCount">${countDisplay}</div>
    </div>`;
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Vectorization</div>
        <div class="charMemory_diagCardContent" id="charMemory_diagVectorization">${memAttachment ? '...' : 'N/A'}</div>
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
    const blocks = parseMemories(content);

    if (blocks.length === 0) {
        callGenericPopup('No memories yet.', POPUP_TYPE.TEXT);
        return;
    }

    let html = '<div class="charMemory_manager">';
    for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        const chatLabel = b.chat.length > 16 ? b.chat.slice(0, 16) + '...' : b.chat;
        html += `<div class="charMemory_card" data-block="${bi}">
            <div class="charMemory_cardHeader">
                <span class="charMemory_cardTitle">${escapeHtml(chatLabel)}</span>
                <span class="charMemory_cardTimestamp">${escapeHtml(b.date)}</span>
                <span class="charMemory_cardActions">
                    <button class="charMemory_deleteBlockBtn menu_button menu_button_icon" data-block="${bi}" title="Delete all memories from this chat"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            <div class="charMemory_cardBullets">`;
        for (let bui = 0; bui < b.bullets.length; bui++) {
            html += `<div class="charMemory_bulletRow" data-block="${bi}" data-bullet="${bui}">
                <span class="charMemory_bulletText">- ${escapeHtml(b.bullets[bui])}</span>
                <span class="charMemory_bulletActions">
                    <button class="charMemory_editBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="charMemory_deleteBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>`;
        }
        html += '</div></div>';
    }
    html += '</div>';

    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Wire up event handlers using delegation
    $(document).off('click.charMemoryManager').on('click.charMemoryManager', '.charMemory_editBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        await editMemory(blockIdx, bulletIdx);
    });

    $(document).off('click.charMemoryDelete').on('click.charMemoryDelete', '.charMemory_deleteBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        await deleteMemory(blockIdx, bulletIdx);
    });

    $(document).off('click.charMemoryDeleteBlock').on('click.charMemoryDeleteBlock', '.charMemory_deleteBlockBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        await deleteBlock(blockIdx);
    });

    // Clean up when popup closes
    popup.finally(() => {
        $(document).off('click.charMemoryManager');
        $(document).off('click.charMemoryDelete');
        $(document).off('click.charMemoryDeleteBlock');
    });
}

function reindexManager() {
    $('.charMemory_manager .charMemory_card').each(function (ci) {
        $(this).attr('data-block', ci);
        $(this).find('.charMemory_deleteBlockBtn').attr('data-block', ci);
        $(this).find('.charMemory_bulletRow').each(function (ri) {
            $(this).attr('data-block', ci).attr('data-bullet', ri);
            $(this).find('.charMemory_editBtn, .charMemory_deleteBtn').attr('data-block', ci).attr('data-bullet', ri);
        });
    });
}

async function editMemory(blockIndex, bulletIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const edited = await callGenericPopup('Edit memory:', POPUP_TYPE.INPUT, block.bullets[bulletIndex], { rows: 3 });

    if (edited === null || edited === false) return; // cancelled

    const newText = String(edited).trim();
    block.bullets[bulletIndex] = newText;
    await writeMemories(serializeMemories(blocks));
    toastr.success('Memory updated.', 'CharMemory');

    // Update DOM in place
    const $row = $(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    $row.find('.charMemory_bulletText').text('- ' + newText);
}

async function deleteMemory(blockIndex, bulletIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const confirm = await callGenericPopup(`Delete this memory?\n\n- ${block.bullets[bulletIndex]}`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    block.bullets.splice(bulletIndex, 1);

    // Remove block entirely if no bullets remain
    if (block.bullets.length === 0) {
        blocks.splice(blockIndex, 1);
    }

    await writeMemories(serializeMemories(blocks));
    toastr.success('Memory deleted.', 'CharMemory');

    // Update DOM in place
    const $row = $(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    const $card = $row.closest('.charMemory_card');
    $row.remove();

    if ($card.find('.charMemory_bulletRow').length === 0) {
        $card.remove();
    }

    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

async function deleteBlock(blockIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];

    const confirm = await callGenericPopup(`Delete all ${block.bullets.length} memories from this chat?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    blocks.splice(blockIndex, 1);
    await writeMemories(serializeMemories(blocks));
    toastr.success('Chat memories deleted.', 'CharMemory');

    // Update DOM in place
    $(`.charMemory_card[data-block="${blockIndex}"]`).remove();

    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

// ============ Consolidation ============

function buildConsolidationPreview(beforeBlocks, afterBlocks, beforeCount, afterCount) {
    const renderSection = (title, blocks, count) => {
        const cards = blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${bullet}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${b.chat}</strong> <span class="charMemory_cardDate">${b.date}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
        return `<h3>${title} (${count} memories)</h3>${cards}`;
    };
    return `<div style="display:flex;gap:1em;">
        <div style="flex:1;overflow-y:auto;max-height:60vh;">${renderSection('Before', beforeBlocks, beforeCount)}</div>
        <div style="flex:1;overflow-y:auto;max-height:60vh;">${renderSection('After', afterBlocks, afterCount)}</div>
    </div>`;
}

async function undoConsolidation() {
    if (!consolidationBackup) {
        toastr.warning('No consolidation to undo.', 'CharMemory');
        return;
    }
    const confirm = await callGenericPopup('Undo the last consolidation and restore previous memories?', POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    await writeMemories(consolidationBackup);
    consolidationBackup = null;
    $('#charMemory_undoConsolidate').prop('disabled', true);
    toastr.success('Consolidation undone. Memories restored.', 'CharMemory');
    updateStatusDisplay();
}

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

    const beforeCount = countMemories(memories);
    let memoriesText = memories.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(bullet => `- ${bullet}`).join('\n')}`,
    ).join('\n\n');

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
        const sourceLabel = source === EXTRACTION_SOURCE.WEBLLM ? 'WebLLM' : source === EXTRACTION_SOURCE.NANOGPT ? 'NanoGPT' : 'main LLM';
        toastr.info(`Consolidating ${beforeCount} memories via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

        let result;
        if (source === EXTRACTION_SOURCE.NANOGPT) {
            const customSysPrompt = extension_settings[MODULE_NAME].nanogptSystemPrompt;
            const systemPrompt = customSysPrompt || 'You are a memory consolidation assistant.';
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
            ];
            result = await generateNanoGptResponse(messages, extension_settings[MODULE_NAME].responseLength * 2);
        } else if (source === EXTRACTION_SOURCE.WEBLLM) {
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

        const consolidationRegex = /<memory>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        const rawEntries = consolidationMatches.length > 0
            ? consolidationMatches.map(m => m[1].trim()).filter(Boolean)
            : [cleanResult.trim()].filter(Boolean);

        const consolidated = rawEntries.map(entry => {
            const bullets = entry.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('- '))
                .map(l => l.slice(2).trim())
                .filter(Boolean);
            return { chat: 'consolidated', date: timestamp, bullets: bullets.length > 0 ? bullets : [entry] };
        });

        const afterCount = countMemories(consolidated);
        const previewHtml = buildConsolidationPreview(memories, consolidated, beforeCount, afterCount);
        const confirmed = await callGenericPopup(previewHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });
        if (!confirmed) {
            toastr.info('Consolidation cancelled.', 'CharMemory');
            return;
        }

        consolidationBackup = content;
        await writeMemories(serializeMemories(consolidated));
        $('#charMemory_undoConsolidate').prop('disabled', false);
        toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
        console.log(LOG_PREFIX, `Consolidation: ${beforeCount} → ${afterCount}`);
        updateStatusDisplay();
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
        const val = String($(this).val());
        extension_settings[MODULE_NAME].source = val;
        saveSettingsDebounced();
        toggleNanoGptSettings(val);
    });

    $('#charMemory_nanogptApiKey').off('input').on('input', function () {
        extension_settings[MODULE_NAME].nanogptApiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_nanogptModel').off('change').on('change', async function () {
        const val = String($(this).val());
        extension_settings[MODULE_NAME].nanogptModel = val;
        saveSettingsDebounced();
        if (cachedNanoGptModels) {
            updateNanoGptModelInfo(cachedNanoGptModels, val);
        }
    });

    $('#charMemory_nanogptSystemPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].nanogptSystemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_nanogptTest').off('click').on('click', () => testNanoGptConnection());

    $('#charMemory_nanogptFilterSub').off('change').on('change', function () {
        extension_settings[MODULE_NAME].nanogptFilterSubscription = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateNanoGptModels(true);
    });

    $('#charMemory_nanogptFilterOS').off('change').on('change', function () {
        extension_settings[MODULE_NAME].nanogptFilterOpenSource = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateNanoGptModels(true);
    });

    $('#charMemory_nanogptFilterRP').off('change').on('change', function () {
        extension_settings[MODULE_NAME].nanogptFilterRoleplay = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateNanoGptModels(true);
    });

    $('#charMemory_nanogptFilterReasoning').off('change').on('change', function () {
        extension_settings[MODULE_NAME].nanogptFilterReasoning = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateNanoGptModels(true);
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

    $('#charMemory_resetTracking').off('click').on('click', function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();
        updateStatusDisplay();
        toastr.success('Extraction state reset. Next extraction will re-read all messages.', 'CharMemory');
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
    $('#charMemory_undoConsolidate').off('click').on('click', () => undoConsolidation());

    $('#charMemory_refreshDiag').off('click').on('click', function () {
        captureDiagnostics();
        toastr.info('Diagnostics refreshed.', 'CharMemory');
    });

    $('#charMemory_clearLog').off('click').on('click', function () {
        activityLog = [];
        updateActivityLogDisplay();
    });
}

// ============ Per-Message Buttons & Indicators ============

/**
 * Update the memory-extracted indicator on a single message element.
 * @param {jQuery} mesElement The .mes element.
 * @param {number} messageIndex The message index in chat.
 */
function updateIndicatorForMessage(mesElement, messageIndex) {
    const $mes = $(mesElement);
    const $nameBlock = $mes.find('.ch_name');
    // Remove any existing indicator
    $nameBlock.find('.charMemory_extractedIndicator').remove();

    ensureMetadata();
    const lastIdx = chat_metadata[MODULE_NAME]?.lastExtractedIndex ?? -1;
    if (messageIndex <= lastIdx && messageIndex >= 0) {
        $nameBlock.append('<span class="charMemory_extractedIndicator" title="Memory extracted"><i class="fa-solid fa-brain fa-xs"></i></span>');
    }
}

/**
 * Update indicators on all rendered messages.
 */
function updateAllIndicators() {
    ensureMetadata();
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;

        const context = getContext();
        const msg = context.chat[mesId];
        // Only show indicator on character messages
        if (!msg || msg.is_user || msg.is_system) return;

        updateIndicatorForMessage(this, mesId);
    });
}

/**
 * Add per-message buttons and indicators when a message is rendered.
 * @param {number} messageIndex The index of the rendered message.
 */
function onMessageRenderedAddButtons(messageIndex) {
    const context = getContext();
    if (context.characterId === undefined) return;

    const msg = context.chat[messageIndex];
    if (!msg || msg.is_system) return;

    const $mes = $(`#chat .mes[mesid="${messageIndex}"]`);
    if (!$mes.length) return;

    const $extraBtns = $mes.find('.extraMesButtons');
    if (!$extraBtns.length) return;

    // Remove existing extension buttons to prevent duplicates
    $extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').remove();

    // Pin as memory — available on all non-system messages (user + character)
    $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${messageIndex}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

    // Extract from here — character messages only
    if (!msg.is_user) {
        $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${messageIndex}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
        updateIndicatorForMessage($mes, messageIndex);
    }
}

/**
 * Click handler for "Extract from here" button.
 */
async function onExtractHereClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    await extractMemories(true, messageIndex);
}

/**
 * Click handler for "Pin as memory" button.
 */
async function onPinMemoryClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;

    const context = getContext();
    const msg = context.chat[messageIndex];
    if (!msg) return;

    // Strip HTML tags from message text
    const plainText = msg.mes.replace(/<[^>]*>/g, '').trim();
    if (!plainText) {
        toastr.warning('Message has no text content.', 'CharMemory');
        return;
    }

    const edited = await callGenericPopup('Edit text to save as a memory:', POPUP_TYPE.INPUT, plainText, { rows: 6 });
    if (edited === null || edited === false) return; // cancelled

    const text = String(edited).trim();
    if (!text) return;

    // Parse lines into bullets
    const bullets = text.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.startsWith('- ') ? l.slice(2).trim() : l)
        .filter(Boolean);

    if (bullets.length === 0) return;

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const chatId = context.chatId || 'unknown';

    const existingContent = await readMemories();
    const blocks = parseMemories(existingContent);
    blocks.push({ chat: chatId, date: timestamp, bullets });
    await writeMemories(serializeMemories(blocks));

    toastr.success(`${bullets.length} memor${bullets.length === 1 ? 'y' : 'ies'} pinned!`, 'CharMemory');
    updateStatusDisplay();
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

    // Per-message buttons and indicators
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    $(document).on('click', '.charMemory_extractHereBtn', onExtractHereClick);
    $(document).on('click', '.charMemory_pinMemoryBtn', onPinMemoryClick);

    // Diagnostics hooks
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, captureDiagnostics);

    console.log(LOG_PREFIX, 'Extension loaded');
});
