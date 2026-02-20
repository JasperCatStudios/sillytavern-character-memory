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
import { getStringHash, getCharaFilename } from '../../../utils.js';
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
import { world_info, loadWorldInfo } from '../../../world-info.js';
import { isWebLlmSupported, generateWebLlmChatPrompt } from '../../shared.js';

const MODULE_NAME = 'charMemory';
const DEFAULT_FILE_NAME = 'char-memories.md';
const LOG_PREFIX = '[CharMemory]';

let inApiCall = false;
let lastExtractionResult = null;
let consolidationBackup = null;
let lastExtractionTime = 0;

const MAX_LOG_ENTRIES = 500;
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
        const isVerbose = entry.message.includes('\n');
        const msgHtml = isVerbose
            ? `<details><summary>${escapeHtml(entry.message.split('\n')[0])}</summary><pre class="charMemory_logVerbose">${escapeHtml(entry.message)}</pre></details>`
            : escapeHtml(entry.message);
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${msgHtml}</div>`;
    }).join('');
    $container.html(html);
}

const defaultExtractionPrompt = `You are a structured narrative memory extraction system optimized for semantic vector retrieval. Your task is to extract ONLY new, long-term significant memories about the specified character from the RECENT CHAT MESSAGES. You are NOT summarizing scenes. You are NOT narrating play-by-play. You are creating semantically dense, retrieval-optimized memory records suitable for vector embedding search (e.g., nomic-embed-text).

Purpose: Extract objective, verifiable facts established by the narrative that are likely to be relevant later. Focus on actions taken, states changed, classifications made, resources used, or conditions imposed. Exclude emotional interpretation unless it directly alters factual status.

---------------------------------------------------------
CORE RULES
---------------------------------------------------------
1. Extract only NEW facts, events, emotional shifts, or relationship changes NOT already covered by the character card or existing memories.
2. Write in third person.
3. Do NOT quote dialogue verbatim.
4. Do NOT use emojis.
5. Wrap EACH individual memory in its own <memory></memory> block.
6. There is no limit to the number of memories that can be extracted as long as the format can be maintained.
7. Write about WHAT HAPPENED, not about the conversation itself. Never write "She told him..." or "He explained..." - instead record the actual outcome or revealed fact.

---------------------------------------------------------
EMBEDDING OPTIMIZATION REQUIREMENTS
---------------------------------------------------------
These memories will be stored in vector embeddings. Therefore:
- Use full character names repeatedly where relevant.
- Avoid ambiguous pronouns.
- Use explicit relationship and consequence language.
- Use strong semantic anchors such as: loyalty shift, authority breakdown, betrayal, protective alliance, social isolation, psychological destabilization, command defiance, faction conflict, emotional withdrawal, escalating hostility, permanent injury, power transfer, status change
- Clearly state long-term consequences using phrases like: "This permanently altered...", "This marked the beginning of...", "This caused...", "This established...", "This weakened...", "This strengthened..."
- Be explicit about who was affected and how.
- Prioritize causal clarity over literary tone.

---------------------------------------------------------
MEMORY TYPES
---------------------------------------------------------
Each memory must include one of the following types:
action - Significant action taken by a character that has lasting impact.
revelation - New information discovered or revealed that changes understanding.
emotion_shift - A meaningful change in emotional state that affects future behavior.
relationship_change - A lasting shift in alliance, loyalty, trust, hostility, or intimacy.

---------------------------------------------------------
BAD EXAMPLE (Do NOT do this)
---------------------------------------------------------
<memory>
Date: Month, Day, Year
Time of Day
Event Type: action
Importance: 2
Summary: She attacked him during an argument.
Characters Involved: She Him
Witnesses: None
Location: Somewhere
Emotional/Relationship Impact: It caused tension.
</memory>

---------------------------------------------------------
GOOD EXAMPLE (Embedding-Optimized)
---------------------------------------------------------
<memory>
Date: Garland Moon 5, 1183
Time: Morning
Event Type: relationship_change
Importance: 4
Summary: Rukia Kuchiki drew her blade against Yua during a confrontation in Seireitei, initiating open hostility and internal faction conflict.
Characters Involved: Rukia Kuchiki Yua Renji Abarai Ichigo Kurosaki
Witnesses: Renji Abarai Ichigo Kurosaki
Location: Seireitei - Division Grounds
Emotional/Relationship Impact: Renji Abarai and Ichigo Kurosaki shifted their loyalty toward protecting Yua over supporting Rukia Kuchiki's judgment. This incident fractured trust in Rukia Kuchiki's stability, weakened Rukia Kuchiki's authority within the group, and marked the beginning of Rukia Kuchiki's social isolation and psychological destabilization.
</memory>

---------------------------------------------------------
FORMAT REQUIREMENTS
---------------------------------------------------------
Each memory must follow this exact structure:

<memory>
Date: Month, Day, Year
Time: Time Of Day
Event Type: [action | revelation | emotion_shift | relationship_change]
Importance: [1-5]
Summary: [Brief, explicit description using full character names. No ambiguous pronouns.]
Characters Involved: [List full character names]
Witnesses: [List full character names or "None"]
Location: [Specific location if known, otherwise "Unspecified"]
Emotional/Relationship Impact: [Explicitly describe long-term consequences using strong causal and relational language. Repeat full names where necessary for clarity and embedding strength.]
</memory>

- Use full character names.
- Do NOT rely on pronouns without clear named reference.
- Be specific about who was affected.
- Importance scale: 1 = Minor but persistent, 3 = Meaningful long-term shift, 5 = Major turning point altering trajectory

===== CHARACTER CARD (baseline knowledge - do NOT extract anything already described here) =====
{{charCard}}
===== END CHARACTER CARD =====

===== EXISTING MEMORIES (reference only - do NOT repeat) =====
{{existingMemories}}
===== END EXISTING MEMORIES =====

===== RECENT CHAT MESSAGES (extract ONLY from this section) =====
{{recentMessages}}
===== END RECENT CHAT MESSAGES =====

CRITICAL: Only extract memories from the RECENT CHAT MESSAGES section above. Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;

const EXTRACTION_SOURCE = {
    MAIN_LLM: 'main_llm',
    WEBLLM: 'webllm',
    PROVIDER: 'provider',
};

const PROVIDER_PRESETS = {
    openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'gpt-4.1-nano',
        helpUrl: 'https://platform.openai.com/api-keys',
    },
    anthropic: {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        authStyle: 'x-api-key',
        modelsEndpoint: 'none',
        requiresApiKey: true,
        extraHeaders: { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        defaultModel: 'claude-sonnet-4-5-20250929',
        helpUrl: 'https://console.anthropic.com/settings/keys',
        isAnthropic: true,
    },
    openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern CharMemory' },
        defaultModel: 'openai/gpt-4.1-nano',
        helpUrl: 'https://openrouter.ai/keys',
    },
    groq: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'llama-3.3-70b-versatile',
        helpUrl: 'https://console.groq.com/keys',
    },
    deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'deepseek-chat',
        helpUrl: 'https://platform.deepseek.com/api_keys',
    },
    mistral: {
        name: 'Mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'mistral-small-latest',
        helpUrl: 'https://console.mistral.ai/api-keys',
    },
    xai: {
        name: 'xAI (Grok)',
        baseUrl: 'https://api.x.ai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'grok-3-mini-fast',
        helpUrl: 'https://console.x.ai',
    },
    nanogpt: {
        name: 'NanoGPT',
        baseUrl: 'https://nano-gpt.com/api/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'custom',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://nano-gpt.com/api',
    },
    ollama: {
        name: 'Ollama (local)',
        baseUrl: 'http://localhost:11434/v1',
        authStyle: 'none',
        modelsEndpoint: 'standard',
        requiresApiKey: false,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://ollama.com',
    },
    nvidia: {
        name: 'NVIDIA',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://build.nvidia.com/',
        useProxy: true,
    },
    pollinations: {
        name: 'Pollinations (free)',
        baseUrl: 'https://text.pollinations.ai/openai',
        authStyle: 'none',
        modelsEndpoint: 'none',
        requiresApiKey: false,
        extraHeaders: {},
        defaultModel: 'openai',
        helpUrl: 'https://pollinations.ai',
    },
    custom: {
        name: 'Custom (OpenAI-compatible)',
        baseUrl: '',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: '',
        allowCustomUrl: true,
    },
};

const defaultSettings = {
    enabled: true,
    interval: 20,
    maxMessagesPerExtraction: 20,
    responseLength: 2000,
    extractionPrompt: defaultExtractionPrompt,
    source: EXTRACTION_SOURCE.PROVIDER,
    fileName: DEFAULT_FILE_NAME,
    perChat: false,
    selectedProvider: 'openrouter',
    providers: {},
    nanogptApiKey: '',
    nanogptModel: '',
    nanogptSystemPrompt: '',
    nanogptFilterSubscription: false,
    nanogptFilterOpenSource: false,
    nanogptFilterRoleplay: false,
    nanogptFilterReasoning: false,
    minCooldownMinutes: 10,
    verboseLogging: false,
    batchState: {},
};

function getProviderSettings(providerKey) {
    const s = extension_settings[MODULE_NAME];
    if (!s.providers) s.providers = {};
    if (!s.providers[providerKey]) {
        const preset = PROVIDER_PRESETS[providerKey];
        s.providers[providerKey] = {
            apiKey: '',
            model: preset?.defaultModel || '',
            systemPrompt: '',
            customBaseUrl: '',
        };
    }
    return s.providers[providerKey];
}

// ============ Individual Memory File Helpers ============

function generateMemoryFileName(charName) {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
    const safeName = charName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `memory-${safeName}-${timestamp}.md`;
}

function findAllMemoryFiles() {
    const attachments = getDataBankAttachmentsForSource('character');
    const charName = getCharacterName();
    if (!charName) return [];
    const safeName = charName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = `memory-${safeName}-`;
    return attachments.filter(a => a.name.startsWith(prefix) && a.name.endsWith('.md'));
}

async function writeMemoryFile(content, charName) {
    const fileName = generateMemoryFileName(charName);
    const fullContent = `<memory>\n${content.trim()}\n</memory>`;
    const file = new File([fullContent], fileName, { type: 'text/markdown' });
    await uploadFileAttachmentToServer(file, 'character');
    return fileName;
}

async function readAllMemories() {
    const files = findAllMemoryFiles();
    if (files.length === 0) return '';
    const contents = await Promise.all(
        files.map(async (file) => {
            try {
                const content = await getFileAttachment(file.url);
                return content || '';
            } catch {
                return '';
            }
        })
    );
    return contents.filter(Boolean).join('\n\n');
}

function countMemoryFiles() {
    return findAllMemoryFiles().length;
}

// ============ Legacy Memory Functions ============

function parseMemories(content) {
    if (!content || !content.trim()) return [];
    const blocks = [];
    const regex = /<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const attrs = match[1];
        const body = match[2];
        const chatMatch = attrs.match(/chat="([^"]*)"/);
        const dateMatch = attrs.match(/date="([^"]*)"/);
        const chat = chatMatch ? chatMatch[1] : 'unknown';
        const date = dateMatch ? dateMatch[1] : '';
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

function countMemories(blocks) {
    return blocks.reduce((sum, b) => sum + b.bullets.length, 0);
}

function serializeMemories(blocks) {
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${b.chat}" date="${b.date}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}

function mergeMemoryBlocks(blocks) {
    const merged = [];
    const seen = new Map();
    for (const block of blocks) {
        const key = block.chat;
        if (seen.has(key)) {
            seen.get(key).bullets.push(...block.bullets);
        } else {
            const copy = { chat: block.chat, date: block.date, bullets: [...block.bullets] };
            seen.set(key, copy);
            merged.push(copy);
        }
    }
    return merged;
}

function migrateMemoriesIfNeeded(content) {
    if (!content || !content.trim()) return content;
    if (/<memory\b[^>]*>/i.test(content)) return content;
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (/^## Memory \d+/m.test(content)) {
        const parts = content.split(/^## Memory \d+\s*$/m);
        const blocks = [];
        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;
            let date = timestamp;
            let text = part;
            const tsMatch = part.match(/^_Extracted:\s*(.+?)_\s*\n/);
            if (tsMatch) {
                date = tsMatch[1].trim();
                text = part.slice(tsMatch[0].length).trim();
            }
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
    const lines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    if (bullets.length === 0) {
        bullets.push(content.trim());
    }
    return serializeMemories([{ chat: 'unknown', date: timestamp, bullets }]);
}

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

function findMemoryAttachment() {
    const attachments = getDataBankAttachmentsForSource('character');
    return attachments.find(a => a.name === getMemoryFileName()) || null;
}

async function readMemories() {
    const attachment = findMemoryAttachment();
    if (!attachment) return '';
    try {
        let content = await getFileAttachment(attachment.url);
        content = content || '';
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

async function writeMemories(content) {
    const existing = findMemoryAttachment();
    if (existing) {
        await deleteAttachment(existing, 'character', () => {}, false);
    }
    const file = new File([content], getMemoryFileName(), { type: 'text/plain' });
    await uploadFileAttachmentToServer(file, 'character');
}

// ============ Provider API Helpers ============

let cachedNanoGptModels = null;
const modelCache = {};

async function fetchNanoGptModels() {
    if (cachedNanoGptModels) return cachedNanoGptModels;
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
    const subscriptionIds = new Set();
    if (subResponse && subResponse.ok) {
        try {
            const subData = await subResponse.json();
            const subModels = subData?.data || [];
            for (const m of subModels) {
                if (m.id) subscriptionIds.add(m.id);
            }
        } catch { }
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

function buildProviderHeaders(preset, apiKey) {
    const headers = { 'Content-Type': 'application/json', ...preset.extraHeaders };
    if (preset.authStyle === 'bearer' && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (preset.authStyle === 'x-api-key' && apiKey) {
        headers['x-api-key'] = apiKey;
    }
    return headers;
}

function resolveBaseUrl(preset, providerSettings) {
    if (preset.allowCustomUrl && providerSettings.customBaseUrl) {
        return providerSettings.customBaseUrl.replace(/\/+$/, '');
    }
    return preset.baseUrl;
}

async function generateOpenAICompatibleResponse(baseUrl, apiKey, model, messages, maxTokens, preset) {
    const verbose = extension_settings[MODULE_NAME].verboseLogging;
    if (preset.useProxy) {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: `Authorization: Bearer ${apiKey}`,
                model,
                messages,
                max_tokens: maxTokens,
                temperature: 0.3,
                stream: false,
            }),
        });
        if (!response.ok) {
            const presetName = preset.name || 'API';
            let errorMsg = `${presetName} error: ${response.status}`;
            try {
                const errorBody = await response.json();
                errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
            } catch { }
            if (verbose) logActivity(`Generate (proxy) HTTP ${response.status} — ST server error`, 'error');
            throw new Error(errorMsg);
        }
        const data = await response.json();
        const msg = data.choices?.[0]?.message;
        if (verbose) {
            if (data.error) {
                logActivity(`Generate (proxy) HTTP ${response.status} — upstream error: ${JSON.stringify(data.error)}`, 'error');
            } else {
                const usage = data.usage;
                const tokens = usage ? `${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion` : 'no usage data';
                const hasReasoning = msg?.reasoning_content ? ` [reasoning: ${msg.reasoning_content.length} chars]` : '';
                logActivity(`Generate (proxy) HTTP ${response.status}, model=${data.model || model}, finish=${data.choices?.[0]?.finish_reason || '?'}, ${tokens}${hasReasoning}`);
            }
        }
        if (data.error) {
            const errorMsg = data.error.message || JSON.stringify(data.error);
            throw new Error(`${preset.name || 'API'} error (via proxy): ${errorMsg}`);
        }
        return msg?.content || msg?.reasoning_content || '';
    }
    const headers = buildProviderHeaders(preset, apiKey);
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.3,
        }),
    });
    if (!response.ok) {
        const presetName = preset.name || 'API';
        let errorMsg = `${presetName} error: ${response.status}`;
        try {
            const errorBody = await response.json();
            errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
        } catch { }
        if (verbose) logActivity(`Generate (direct) HTTP ${response.status} — ${errorMsg}`, 'error');
        throw new Error(errorMsg);
    }
    const data = await response.json();
    const msg = data.choices?.[0]?.message;
    if (verbose) {
        const usage = data.usage;
        const tokens = usage ? `${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion` : 'no usage data';
        const hasReasoning = msg?.reasoning_content ? ` [reasoning: ${msg.reasoning_content.length} chars]` : '';
        logActivity(`Generate (direct) HTTP ${response.status}, model=${data.model || model}, finish=${data.choices?.[0]?.finish_reason || '?'}, ${tokens}${hasReasoning}`);
    }
    return msg?.content || msg?.reasoning_content || '';
}

async function generateAnthropicResponse(baseUrl, apiKey, model, messages, maxTokens, preset) {
    const headers = buildProviderHeaders(preset, apiKey);
    let system = '';
    const anthropicMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n' : '') + msg.content;
        } else {
            anthropicMessages.push({ role: msg.role, content: msg.content });
        }
    }
    if (anthropicMessages.length === 0 || anthropicMessages[0].role !== 'user') {
        anthropicMessages.unshift({ role: 'user', content: 'Please proceed.' });
    }
    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
    };
    if (system) body.system = system;
    const verbose = extension_settings[MODULE_NAME].verboseLogging;
    const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        let errorMsg = `Anthropic error: ${response.status}`;
        try {
            const errorBody = await response.json();
            errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
        } catch { }
        if (verbose) logActivity(`Generate (Anthropic) HTTP ${response.status} — ${errorMsg}`, 'error');
        throw new Error(errorMsg);
    }
    const data = await response.json();
    if (verbose) {
        const usage = data.usage;
        const tokens = usage ? `${usage.input_tokens} in + ${usage.output_tokens} out` : 'no usage data';
        logActivity(`Generate (Anthropic) HTTP ${response.status}, model=${data.model || model}, stop=${data.stop_reason || '?'}, ${tokens}`);
    }
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

async function generateProviderResponse(messages, maxTokens) {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) throw new Error(`Unknown provider: ${providerKey}`);
    const providerSettings = getProviderSettings(providerKey);
    const apiKey = providerSettings.apiKey;
    const model = providerSettings.model;
    const baseUrl = resolveBaseUrl(preset, providerSettings);
    if (preset.requiresApiKey && !apiKey) {
        throw new Error(`${preset.name} API key is not set. Configure it in Character Memory settings.`);
    }
    if (!model) {
        throw new Error(`${preset.name} model is not selected. Choose a model in Character Memory settings.`);
    }
    if (preset.allowCustomUrl && !baseUrl) {
        throw new Error('Custom base URL is not set. Configure it in Character Memory settings.');
    }
    if (preset.isAnthropic) {
        return generateAnthropicResponse(baseUrl, apiKey, model, messages, maxTokens, preset);
    }
    return generateOpenAICompatibleResponse(baseUrl, apiKey, model, messages, maxTokens, preset);
}

function getSourceLabel() {
    const source = extension_settings[MODULE_NAME].source;
    if (source === EXTRACTION_SOURCE.WEBLLM) return 'WebLLM';
    if (source === EXTRACTION_SOURCE.PROVIDER) {
        const key = extension_settings[MODULE_NAME].selectedProvider;
        return PROVIDER_PRESETS[key]?.name || key;
    }
    return 'main LLM';
}

async function callLLM(userPrompt, maxTokens, defaultSystemPrompt = 'You are a memory extraction assistant.') {
    const source = extension_settings[MODULE_NAME].source;
    if (source === EXTRACTION_SOURCE.PROVIDER) {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        const systemPrompt = providerSettings.systemPrompt || defaultSystemPrompt;
        return generateProviderResponse(
            [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            maxTokens,
        );
    }
    if (source === EXTRACTION_SOURCE.WEBLLM) {
        if (!isWebLlmSupported()) throw new Error('WebLLM is not available in this browser.');
        return generateWebLlmChatPrompt(
            [{ role: 'system', content: defaultSystemPrompt }, { role: 'user', content: userPrompt }],
            { max_tokens: maxTokens },
        );
    }
    return generateQuietPrompt({ quietPrompt: userPrompt, skipWIAN: true, responseLength: maxTokens });
}

async function fetchProviderModels(providerKey, forceRefresh = false) {
    if (modelCache[providerKey] && !forceRefresh) return modelCache[providerKey];
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return [];
    if (preset.modelsEndpoint === 'none') return [];
    if (preset.modelsEndpoint === 'custom') {
        const models = await fetchNanoGptModels();
        return models.map(m => ({ id: m.id, name: m.name, _raw: m }));
    }
    const verbose = extension_settings[MODULE_NAME].verboseLogging;
    const providerSettings = getProviderSettings(providerKey);
    const baseUrl = resolveBaseUrl(preset, providerSettings);
    if (!baseUrl) return [];
    if (preset.useProxy) {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: `Authorization: Bearer ${providerSettings.apiKey}`,
            }),
        });
        if (!response.ok) {
            if (verbose) logActivity(`Models (proxy) HTTP ${response.status} — ST server error`, 'error');
            throw new Error(`Failed to fetch models from ${preset.name}: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            const errorMsg = data.error.message || JSON.stringify(data.error);
            if (verbose) logActivity(`Models (proxy) HTTP ${response.status} — upstream error: ${JSON.stringify(data.error)}`, 'error');
            throw new Error(`Failed to fetch models from ${preset.name}: ${errorMsg}`);
        }
        const rawModels = data?.data || [];
        const models = rawModels.map(m => ({ id: m.id, name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
        if (verbose) logActivity(`Models (proxy) HTTP ${response.status}, ${models.length} models loaded from ${preset.name}`);
        modelCache[providerKey] = models;
        return models;
    }
    const headers = buildProviderHeaders(preset, providerSettings.apiKey);
    delete headers['Content-Type'];
    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
        if (verbose) logActivity(`Models (direct) HTTP ${response.status} from ${baseUrl}/models`, 'error');
        throw new Error(`Failed to fetch models from ${preset.name}: ${response.status}`);
    }
    const data = await response.json();
    const rawModels = data?.data || [];
    const models = rawModels.map(m => ({ id: m.id, name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
    if (verbose) logActivity(`Models (direct) HTTP ${response.status}, ${models.length} models loaded from ${preset.name}`);
    modelCache[providerKey] = models;
    return models;
}

function clearModelCache(providerKey) {
    delete modelCache[providerKey];
    if (providerKey === 'nanogpt') {
        cachedNanoGptModels = null;
    }
}

async function testProviderConnection() {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    const $status = $('#charMemory_providerTestStatus');
    if (!preset) {
        $status.text('Unknown provider selected.').css('color', '#e74c3c').show();
        return;
    }
    const providerSettings = getProviderSettings(providerKey);
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        $status.text('Enter an API key first.').css('color', '#e74c3c').show();
        return;
    }
    const $btn = $('#charMemory_providerTest');
    $btn.prop('disabled', true).val('Testing...');
    $status.text('Testing model...').css('color', '').show();
    try {
        const baseUrl = resolveBaseUrl(preset, providerSettings);
        const testModel = providerSettings.model || preset.defaultModel;
        if (!testModel) {
            $status.text('Select a model first, then test.').css('color', '#e67e22').show();
            return;
        }
        const testMessages = [{ role: 'user', content: 'Respond with exactly: CHARMMEMORY_TEST_OK' }];
        const t0 = performance.now();
        let response;
        if (preset.isAnthropic) {
            response = await generateAnthropicResponse(baseUrl, providerSettings.apiKey, testModel, testMessages, 20, preset);
        } else {
            response = await generateOpenAICompatibleResponse(baseUrl, providerSettings.apiKey, testModel, testMessages, 20, preset);
        }
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const reply = (response || '').trim();
        const passed = reply.includes('CHARMMEMORY_TEST_OK');
        logActivity(`${preset.name} model test: model=${testModel}, reply="${reply}", ${elapsed}s`, passed ? 'success' : 'warn');
        const modelShort = testModel.length > 30 ? testModel.slice(0, 30) + '…' : testModel;
        if (passed) {
            $status.text(`\u2714 ${modelShort} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
        } else {
            $status.html(`\u26A0 ${escapeHtml(modelShort)} responded but didn't follow the test instruction (${elapsed}s). Reply: "<b>${escapeHtml(reply.slice(0, 80))}</b>". It may still work for extraction.`).css('color', '#e67e22').show();
        }
    } catch (err) {
        logActivity(`${preset.name} model test failed: ${err.message}`, 'error');
        $status.text(`\u2718 ${err.message || 'Test failed'}`).css('color', '#e74c3c').show();
    } finally {
        $btn.prop('disabled', false).val('Test Model');
    }
}

const WEBLLM_MAX_PROMPT_CHARS = 6000;

function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '\n[...truncated]';
}

function buildExtractionPrompt(existingMemories, recentMessages) {
    const charName = getCharacterName() || '{{char}}';
    let prompt = extension_settings[MODULE_NAME].extractionPrompt;
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    let memories = existingMemories || '(none yet)';
    let messages = recentMessages;
    const charCard = getCharacterCardText() || '(not available)';
    if (isWebLlm) {
        const templateLength = prompt.replace(/\{\{charName\}\}/g, charName)
            .replace(/\{\{charCard\}\}/g, '')
            .replace(/\{\{existingMemories\}\}/g, '')
            .replace(/\{\{recentMessages\}\}/g, '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        const memoriesBudget = Math.floor(available / 3);
        const messagesBudget = available - memoriesBudget;
        memories = truncateText(memories, memoriesBudget);
        messages = truncateText(messages, messagesBudget);
    }
    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{charCard\}\}/g, charCard);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, memories);
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, messages);
    prompt = substituteParamsExtended(prompt);
    return prompt;
}

function getCharacterName() {
    const context = getContext();
    if (context.characterId === undefined) return null;
    return context.name2 || characters[this_chid]?.name || 'Character';
}

function getCharacterCardText() {
    const character = characters[this_chid];
    if (!character) return '';
    const parts = [];
    const desc = character.data?.description || character.description || '';
    const pers = character.data?.personality || character.personality || '';
    if (desc.trim()) parts.push(desc.trim());
    if (pers.trim()) parts.push(pers.trim());
    return parts.join('\n\n');
}

function ensureMetadata() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            lastExtractedIndex: -1,
            messagesSinceExtraction: 0,
        };
    }
}

function collectRecentMessages({ endIndex = null, chatArray = null, lastExtractedIdx = null } = {}) {
    const context = getContext();
    const chat = chatArray || context.chat;
    const lastExtracted = lastExtractedIdx !== null ? lastExtractedIdx : (function () {
        ensureMetadata();
        return chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;
    })();
    if (!chat || chat.length === 0) return { text: '', startIndex: -1, endIndex: -1 };
    const startIndex = Math.max(0, lastExtracted + 1);
    const maxMessages = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const end = endIndex !== null ? endIndex + 1 : chat.length;
    if (startIndex >= end) return { text: '', startIndex: -1, endIndex: -1 };
    logActivity(`collectRecentMessages: lastExtracted=${lastExtracted}, startIndex=${startIndex}, end=${end}, chatLength=${chat.length}`);
    const sliceEnd = Math.min(startIndex + maxMessages, end);
    const slice = chat.slice(startIndex, sliceEnd);
    const lines = [];
    for (const msg of slice) {
        if (!msg.mes) continue;
        if (msg.is_system && !msg.is_user && !msg.name) continue;
        let text = msg.mes;
        text = text.replace(/```[\s\S]*?```/g, '');
        text = text.replace(/<details[\s\S]*?<\/details>/gi, '');
        text = text.replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)*/g, '');
        text = text.replace(/<[^>]*>/g, '');
        text = text.replace(/\n{3,}/g, '\n\n').trim();
        if (!text) continue;
        lines.push(`${msg.name}: ${text}`);
    }
    logActivity(`Collected ${lines.length} messages (indices ${startIndex}-${sliceEnd - 1})`);
    return { text: lines.join('\n\n'), startIndex, endIndex: sliceEnd - 1 };
}

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
    if (!Array.isArray(chats)) return [];
    return chats;
}

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
        console.error(LOG_PREFIX, 'Failed to fetch chat:', fileName, response.status);
        return null;
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
        metadata: data[0]?.chat_metadata || {},
        messages: data.slice(1),
    };
}

// ============ Main Extraction Function ============

async function extractMemories({
    force = false,
    endIndex = null,
    chatArray = null,
    chatId = null,
    lastExtractedIdx = null,
    onProgress = null,
    abortSignal = null,
    progressLabel = null,
} = {}) {
    const noopResult = { totalMemories: 0, chunksProcessed: 0, lastExtractedIndex: lastExtractedIdx ?? -1 };
    if (inApiCall) {
        console.log(LOG_PREFIX, 'Already in API call, skipping');
        return noopResult;
    }
    if (!extension_settings[MODULE_NAME].enabled && !force) {
        return noopResult;
    }
    const context = getContext();
    const isActiveChat = !chatArray;
    if (isActiveChat && context.characterId === undefined) {
        console.log(LOG_PREFIX, 'No character selected');
        return noopResult;
    }
    if (isActiveChat && streamingProcessor && !streamingProcessor.isFinished) {
        console.log(LOG_PREFIX, 'Streaming in progress, skipping');
        return noopResult;
    }
    let currentLastExtracted;
    if (lastExtractedIdx !== null) {
        currentLastExtracted = lastExtractedIdx;
    } else {
        ensureMetadata();
        currentLastExtracted = chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;
    }
    const chat = chatArray || context.chat;
    const effectiveEnd = endIndex !== null ? endIndex + 1 : chat.length;
    const totalUnprocessed = effectiveEnd - (currentLastExtracted + 1);
    if (totalUnprocessed <= 0) {
        console.log(LOG_PREFIX, 'No new messages to extract');
        logActivity('No new messages to extract — nothing unprocessed', 'warning');
        if (force) {
            toastr.info('No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.', 'CharMemory', { timeOut: 5000 });
        } else {
            toastr.info('No new messages to extract.', 'CharMemory');
        }
        return noopResult;
    }
    const chunkSize = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const totalChunks = Math.ceil(totalUnprocessed / chunkSize);
    logActivity(`Extraction triggered (${force ? 'manual' : 'auto'}), endIndex=${endIndex ?? 'last'}, totalUnprocessed=${totalUnprocessed}, chunks=${totalChunks}`);
    if (force && totalChunks > 3 && !abortSignal) {
        const confirmed = await callGenericPopup(
            `This will process ${totalUnprocessed} messages in ${totalChunks} chunks. This may take a while. Continue?`,
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) {
            logActivity('Large extraction cancelled by user', 'warning');
            return noopResult;
        }
    }
    const savedCharId = context.characterId;
    const savedChatId = context.chatId;
    const effectiveChatId = chatId || context.chatId || 'unknown';
    const source = extension_settings[MODULE_NAME].source;
    const sourceLabel = getSourceLabel();
    let totalMemories = 0;
    let chunksProcessed = 0;
    try {
        inApiCall = true;
        lastExtractionTime = Date.now();
        for (let chunk = 0; chunk < totalChunks; chunk++) {
            if (abortSignal && abortSignal.aborted) {
                logActivity(`Extraction aborted after ${chunksProcessed} chunk(s)`, 'warning');
                toastr.warning(`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
                break;
            }
            const prefix = progressLabel ? `${progressLabel} — ` : '';
            const chunkInfo = totalChunks > 1 ? ` (chunk ${chunk + 1}/${totalChunks})` : '';
            toastr.info(`${prefix}Extracting via ${sourceLabel}${chunkInfo}...`, 'CharMemory', { timeOut: 3000 });
            if (onProgress) {
                onProgress({ chunk: chunk + 1, totalChunks, chunksProcessed, totalMemories });
            }
            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex: endIndex,
                chatArray: chatArray,
                lastExtractedIdx: currentLastExtracted,
            });
            if (!recentMessages) {
                logActivity(`Chunk ${chunk + 1}: no messages returned, stopping`, 'warning');
                break;
            }
            // Read ALL existing memories from individual files
            const existingMemories = await readAllMemories();
            const prompt = buildExtractionPrompt(existingMemories, recentMessages);
            const verbose = extension_settings[MODULE_NAME].verboseLogging;
            if (verbose) {
                logActivity(`Prompt sent to ${sourceLabel} (${prompt.length} chars):\n${prompt}`);
            }
            logActivity(`Sending to ${sourceLabel}... waiting for response`);
            const llmStartTime = Date.now();
            let result;
            try {
                result = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength, 'You are a memory extraction assistant.');
            } catch (llmErr) {
                if (llmErr.message?.includes('WebLLM is not available')) {
                    toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                }
                throw llmErr;
            }
            const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
            logActivity(`Response received from ${sourceLabel} in ${llmElapsed}s (${(result || '').length} chars)`);
            if (verbose && result) {
                logActivity(`Raw LLM response:\n${result}`);
            }
            if (isActiveChat) {
                const newContext = getContext();
                if (newContext.characterId !== savedCharId || newContext.chatId !== savedChatId) {
                    console.log(LOG_PREFIX, 'Context changed during extraction, discarding result');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                }
            }
            let cleanResult = removeReasoningFromString(result);
            cleanResult = cleanResult.trim();
            lastExtractionResult = cleanResult || null;
            if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
                logActivity(`Chunk ${chunk + 1}: LLM returned NO_NEW_MEMORIES — advancing index anyway`);
            } else {
                // Parse <memory> blocks from LLM response
                const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
                const matches = [...cleanResult.matchAll(memoryRegex)];
                const rawEntries = matches.length > 0
                    ? matches.map(m => m[1].trim()).filter(Boolean)
                    : [];
                if (rawEntries.length === 0) {
                    logActivity(`Chunk ${chunk + 1}: No <memory> blocks found in response`, 'warning');
                } else {
                    const charName = getCharacterName();
                    let savedCount = 0;
                    for (const entry of rawEntries) {
                        try {
                            const fileName = await writeMemoryFile(entry, charName);
                            savedCount++;
                            logActivity(`Saved memory file: ${fileName}`, 'success');
                        } catch (err) {
                            console.error(LOG_PREFIX, 'Failed to write memory file:', err);
                            logActivity(`Failed to write memory file: ${err.message}`, 'error');
                        }
                    }
                    totalMemories += savedCount;
                    logActivity(`Chunk ${chunk + 1}: saved ${savedCount} individual memory file(s)`, 'success');
                }
            }
            currentLastExtracted = chunkEndIndex !== -1 ? chunkEndIndex : effectiveEnd - 1;
            if (isActiveChat) {
                ensureMetadata();
                chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
                saveMetadataDebounced();
                logActivity(`Advanced lastExtractedIndex to ${currentLastExtracted}`);
            }
            chunksProcessed++;
        }
        if (isActiveChat) {
            ensureMetadata();
            chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
            saveMetadataDebounced();
        }
        updateStatusDisplay();
        updateAllIndicators();
        if (totalMemories > 0) {
            toastr.success(`${totalMemories} memor${totalMemories === 1 ? 'y' : 'ies'} saved as individual files.`, 'CharMemory');
        } else if (chunksProcessed > 0) {
            toastr.info('No new memories found.', 'CharMemory');
        }
        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        logActivity(`Extraction failed: ${err.message}`, 'error');
        toastr.error('Memory extraction failed. Check console for details.', 'CharMemory');
        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } finally {
        inApiCall = false;
    }
}

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
        const cooldownMs = (extension_settings[MODULE_NAME].minCooldownMinutes || 0) * 60000;
        const elapsed = Date.now() - lastExtractionTime;
        if (cooldownMs > 0 && elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
            logActivity(`Extraction skipped: cooldown active (${remaining}m remaining)`, 'warning');
            return;
        }
        extractMemories({ force: false });
    }
}

async function onChatChanged() {
    const context = getContext();
    const chatId = context.chatId || '(none)';
    const charName = getCharacterName() || '(none)';
    const msgCount = context.chat ? context.chat.length : 0;
    logActivity(`Chat changed: "${charName}" chat=${chatId} (${msgCount} messages)`);
    ensureMetadata();
    const meta = chat_metadata[MODULE_NAME];
    const effectiveLastIdx = meta.lastExtractedIndex ?? -1;
    const unextracted = msgCount > 0 ? msgCount - 1 - effectiveLastIdx : 0;
    logActivity(`Extraction state: lastExtractedIndex=${effectiveLastIdx}, messagesSinceExtraction=${meta.messagesSinceExtraction}, unextracted=${unextracted}`);
    if (unextracted > 0 && meta.messagesSinceExtraction < unextracted) {
        meta.messagesSinceExtraction = unextracted;
        saveMetadataDebounced();
        logActivity(`Seeded messagesSinceExtraction=${unextracted}`);
    }
    updateStatusDisplay();
    updateAllIndicators();
    setTimeout(addButtonsToExistingMessages, 500);
}

// ============ Diagnostics ============

let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];

function onWorldInfoActivated(entries) {
    lastDiagnostics.worldInfoEntries = Array.isArray(entries) ? entries.map(e => ({
        comment: e.comment || e.key?.join(', ') || '(unnamed)',
        keys: Array.isArray(e.key) ? e.key : [],
        content: e.content ? e.content.substring(0, 200) : '',
        uid: e.uid,
    })) : [];
}

function captureDiagnostics() {
    const context = getContext();
    lastDiagnostics.extensionPrompts = {};
    lastDiagnostics.timestamp = new Date().toLocaleTimeString();
    if (context.extensionPrompts) {
        for (const [key, value] of Object.entries(context.extensionPrompts)) {
            if (value && value.value) {
                const maxLen = key === '4_vectors_data_bank' ? 2000 : 300;
                lastDiagnostics.extensionPrompts[key] = {
                    label: key,
                    content: typeof value.value === 'string' ? value.value.substring(0, maxLen) : String(value.value).substring(0, maxLen),
                    position: value.position,
                    depth: value.depth,
                };
            }
        }
    }
    diagnosticsHistory.unshift({ ...lastDiagnostics, worldInfoEntries: [...lastDiagnostics.worldInfoEntries] });
    if (diagnosticsHistory.length > 5) diagnosticsHistory.pop();
    updateDiagnosticsDisplay();
}

async function checkVectorizationStatus(fileUrl) {
    try {
        const vecSettings = extension_settings.vectors;
        if (!vecSettings || !vecSettings.enabled_files) return null;
        const source = vecSettings.source || 'transformers';
        const modelKey = `${source === 'palm' || source === 'vertexai' ? 'google' : source}_model`;
        const model = vecSettings[modelKey] || '';
        const collectionId = `file_${getStringHash(fileUrl)}`;
        const body = { collectionId, source };
        if (model) body.model = model;
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) return null;
        const hashes = await response.json();
        return hashes.length > 0 ? { chunks: hashes.length, source, model } : false;
    } catch {
        return null;
    }
}

async function fetchCharacterLorebooks() {
    const character = characters[this_chid];
    if (!character) return [];
    const bookNames = new Set();
    const primaryWorld = character.data?.extensions?.world;
    if (primaryWorld) bookNames.add(primaryWorld);
    const fileName = getCharaFilename(this_chid);
    const extraCharLore = world_info.charLore?.find(e => e.name === fileName);
    if (extraCharLore?.extraBooks) {
        for (const book of extraCharLore.extraBooks) bookNames.add(book);
    }
    if (bookNames.size === 0) return [];
    const results = [];
    for (const name of bookNames) {
        try {
            const data = await loadWorldInfo(name);
            if (!data?.entries) continue;
            const entries = Object.values(data.entries).map(e => ({
                uid: e.uid,
                keys: Array.isArray(e.key) ? e.key.filter(Boolean) : [],
                content: e.content ? e.content.substring(0, 150) : '',
            }));
            results.push({ name, entries });
        } catch (err) {
            console.error('[CharMemory]', `Failed to load lorebook "${name}":`, err);
        }
    }
    return results;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateDiagnosticsDisplay() {
    const container = $('#charMemory_diagnosticsContent');
    if (!container.length) return;
    let html = '';
    if (lastDiagnostics.timestamp) {
        html += `<div class="charMemory_diagTimestamp">Last capture: ${lastDiagnostics.timestamp}</div>`;
    }
    html += '<div class="charMemory_diagSection"><strong>Memory Files</strong>';
    const memoryCount = countMemoryFiles();
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Individual memory files</div>
        <div class="charMemory_diagCardContent">${memoryCount} file${memoryCount !== 1 ? 's' : ''} in Data Bank</div>
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
    const dbPrompt = lastDiagnostics.extensionPrompts?.['4_vectors_data_bank'];
    html += '<div class="charMemory_diagSection"><strong>Injected Memories — Last Generation</strong>';
    if (dbPrompt && dbPrompt.content) {
        html += '<div id="charMemory_diagInjected"><div class="charMemory_diagEmpty">Processing...</div></div></div>';
        setTimeout(() => {
            const el = document.getElementById('charMemory_diagInjected');
            if (!el) return;
            const memoryMatches = dbPrompt.content.match(/<memory>[\s\S]*?<\/memory>/gi) || [];
            if (memoryMatches.length > 0) {
                let memHtml = `<div class="charMemory_diagCard"><div class="charMemory_diagCardTitle">${memoryMatches.length} memor${memoryMatches.length === 1 ? 'y' : 'ies'} injected</div>`;
                for (const mem of memoryMatches.slice(0, 3)) {
                    const preview = mem.substring(0, 200) + (mem.length > 200 ? '...' : '');
                    memHtml += `<div class="charMemory_diagCardContent">${escapeHtml(preview)}</div>`;
                }
                if (memoryMatches.length > 3) {
                    memHtml += `<div class="charMemory_diagCardContent"><em>...and ${memoryMatches.length - 3} more</em></div>`;
                }
                memHtml += '</div>';
                el.innerHTML = memHtml;
            } else {
                const preview = dbPrompt.content.length > 500 ? dbPrompt.content.substring(0, 500) + '...' : dbPrompt.content;
                el.innerHTML = `<div class="charMemory_diagCard"><div class="charMemory_diagCardTitle">Injected text:</div><div class="charMemory_diagCardContent" style="white-space:pre-wrap;">${escapeHtml(preview)}</div></div>`;
            }
        }, 0);
    } else {
        html += '<div class="charMemory_diagEmpty">No memory chunks injected yet (generate a message first)</div></div>';
    }
    html += '<div class="charMemory_diagSection"><strong>Character Lorebooks</strong>';
    html += '<div id="charMemory_diagLorebooks"><div class="charMemory_diagEmpty">Loading...</div></div></div>';
    fetchCharacterLorebooks().then(books => {
        const el = document.getElementById('charMemory_diagLorebooks');
        if (!el) return;
        if (books.length === 0) {
            el.textContent = 'No lorebooks bound to this character';
            el.classList.add('charMemory_diagEmpty');
            return;
        }
        let booksHtml = '';
        for (const book of books) {
            booksHtml += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(book.name)} (${book.entries.length} entries)</div>`;
            for (const entry of book.entries) {
                const keysStr = entry.keys.length > 0 ? entry.keys.join(', ') : '(no keys)';
                booksHtml += `<div class="charMemory_diagCardKeys">Keys: ${escapeHtml(keysStr)}</div>`;
            }
            booksHtml += '</div>';
        }
        el.innerHTML = booksHtml;
    }).catch(() => {
        const el = document.getElementById('charMemory_diagLorebooks');
        if (el) {
            el.textContent = 'Failed to load lorebooks';
            el.classList.add('charMemory_diagEmpty');
        }
    });
    const wiEntries = lastDiagnostics.worldInfoEntries;
    html += `<div class="charMemory_diagSection"><strong>Activated Entries — Last Generation (${wiEntries.length})</strong>`;
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
        html += '<div class="charMemory_diagEmpty">No entries activated yet (generate a message first)</div>';
    }
    html += '</div>';
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

// ============ Memory Manager ============

async function showMemoryManager() {
    const memoryFiles = findAllMemoryFiles();
    if (memoryFiles.length === 0) {
        callGenericPopup('No memory files yet.', POPUP_TYPE.TEXT);
        return;
    }
    let html = '<div class="charMemory_manager">';
    html += '<p><small>Each memory is stored as an individual file. Delete files directly from the Data Bank or use the buttons below.</small></p>';
    for (const file of memoryFiles) {
        const fileName = file.name;
        html += `<div class="charMemory_card" data-filename="${escapeHtml(fileName)}">
            <div class="charMemory_cardHeader">
                <span class="charMemory_cardTitle">${escapeHtml(fileName)}</span>
                <span class="charMemory_cardActions">
                    <button class="charMemory_viewMemoryBtn menu_button menu_button_icon" data-url="${file.url}" title="View content"><i class="fa-solid fa-eye"></i></button>
                    <button class="charMemory_deleteMemoryFileBtn menu_button menu_button_icon" data-filename="${escapeHtml(fileName)}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            <div class="charMemory_cardContent" id="content-${fileName.replace(/[^a-zA-Z0-9]/g, '_')}">
                <small>Click eye icon to preview</small>
            </div>
        </div>`;
    }
    html += '</div>';
    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    $(document).off('click.charMemoryManager').on('click.charMemoryManager', '.charMemory_viewMemoryBtn', async function (e) {
        e.stopPropagation();
        const url = $(this).data('url');
        const $card = $(this).closest('.charMemory_card');
        const $content = $card.find('.charMemory_cardContent');
        try {
            const content = await getFileAttachment(url);
            const truncated = content.length > 500 ? content.substring(0, 500) + '...' : content;
            $content.html(`<pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(truncated)}</pre>`);
        } catch (err) {
            $content.html('<span style="color:red;">Failed to load content</span>');
        }
    });
    $(document).off('click.charMemoryDeleteFile').on('click.charMemoryDeleteFile', '.charMemory_deleteMemoryFileBtn', async function (e) {
        e.stopPropagation();
        const fileName = $(this).data('filename');
        const confirmed = await callGenericPopup(`Delete memory file "${fileName}"?`, POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        const attachment = findAllMemoryFiles().find(f => f.name === fileName);
        if (attachment) {
            await deleteAttachment(attachment, 'character', () => {}, false);
            $(this).closest('.charMemory_card').remove();
            toastr.success('Memory file deleted.', 'CharMemory');
            updateStatusDisplay();
        }
    });
    popup.finally(() => {
        $(document).off('click.charMemoryManager');
        $(document).off('click.charMemoryDeleteFile');
    });
}

// ============ Slash Commands ============

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'extract-memories',
        callback: async () => {
            await extractMemories({ force: true });
            return '';
        },
        helpString: 'Force memory extraction from recent chat messages.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'list-memories',
        callback: async () => {
            const count = countMemoryFiles();
            toastr.info(`${count} memory file${count !== 1 ? 's' : ''} in Data Bank.`, 'CharMemory');
            return '';
        },
        helpString: 'List count of memory files for current character.',
    }));
}

// ============ UI Setup ============

function toggleProviderSettings(source) {
    const isProvider = source === EXTRACTION_SOURCE.PROVIDER;
    $('#charMemory_providerSettings').toggle(isProvider);
    if (isProvider) {
        updateProviderUI();
    }
}

function populateProviderDropdown() {
    const $select = $('#charMemory_providerSelect');
    $select.empty();
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
        $select.append(`<option value="${escapeHtml(key)}">${escapeHtml(preset.name)}</option>`);
    }
    $select.val(extension_settings[MODULE_NAME].selectedProvider || 'openrouter');
}

function updateProviderUI() {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;
    const providerSettings = getProviderSettings(providerKey);
    $('#charMemory_providerApiKeyRow').toggle(!!preset.requiresApiKey);
    $('#charMemory_providerApiKey').val(providerSettings.apiKey || '');
    if (preset.helpUrl) {
        $('#charMemory_providerHelpLink').attr('href', preset.helpUrl).show();
    } else {
        $('#charMemory_providerHelpLink').hide();
    }
    $('#charMemory_providerBaseUrlRow').toggle(!!preset.allowCustomUrl);
    $('#charMemory_providerBaseUrl').val(providerSettings.customBaseUrl || '');
    const useDropdown = preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom';
    $('#charMemory_providerModelDropdownRow').toggle(useDropdown);
    $('#charMemory_providerModelInputRow').toggle(!useDropdown);
    const isNanoGpt = providerKey === 'nanogpt';
    $('#charMemory_nanogptFilters').toggle(isNanoGpt);
    if (isNanoGpt) {
        $('#charMemory_nanogptFilterSub').prop('checked', !!providerSettings.nanogptFilterSubscription);
        $('#charMemory_nanogptFilterOS').prop('checked', !!providerSettings.nanogptFilterOpenSource);
        $('#charMemory_nanogptFilterRP').prop('checked', !!providerSettings.nanogptFilterRoleplay);
        $('#charMemory_nanogptFilterReasoning').prop('checked', !!providerSettings.nanogptFilterReasoning);
    }
    if (useDropdown) {
        populateProviderModels(providerKey);
    } else {
        $('#charMemory_providerModelInput').val(providerSettings.model || '');
    }
    $('#charMemory_providerSystemPrompt').val(providerSettings.systemPrompt || '');
}

function getFilteredNanoGptModels(models, providerSettings) {
    const s = providerSettings;
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

async function populateProviderModels(providerKey, forceRefresh = false) {
    const $select = $('#charMemory_providerModel');
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;
    if (forceRefresh) {
        clearModelCache(providerKey);
    }
    const providerSettings = getProviderSettings(providerKey);
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        $select.empty().append('<option value="">-- Enter API key, then click Connect --</option>');
        $('#charMemory_providerModelInfo').text('');
        return;
    }
    try {
        if (providerKey === 'nanogpt') {
            const models = await fetchNanoGptModels();
            const filtered = getFilteredNanoGptModels(models, providerSettings);
            const currentVal = $select.val() || providerSettings.model;
            $select.empty().append('<option value="">-- Select model --</option>');
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
            if (currentVal && filtered.some(m => m.id === currentVal)) {
                $select.val(currentVal);
                updateProviderModelInfo(models, currentVal);
            } else {
                $select.val('');
                providerSettings.model = '';
                saveSettingsDebounced();
                $('#charMemory_providerModelInfo').text('');
            }
        } else {
            const models = await fetchProviderModels(providerKey);
            const currentVal = $select.val() || providerSettings.model;
            $select.empty().append('<option value="">-- Select model --</option>');
            for (const m of models) {
                $select.append(`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`);
            }
            if (currentVal && models.some(m => m.id === currentVal)) {
                $select.val(currentVal);
            } else if (providerSettings.model) {
                $select.val('');
            }
            $('#charMemory_providerModelInfo').text('');
        }
    } catch (err) {
        console.error(LOG_PREFIX, `Failed to fetch models for ${preset.name}:`, err);
        throw err;
    }
}

function updateProviderModelInfo(models, modelId) {
    const info = models.find(m => m.id === modelId);
    if (info) {
        const parts = [`Provider: ${info.provider}`, `Cost: ${info.cost}`];
        if (info.maxInputTokens) parts.push(`Input: ${info.maxInputTokens.toLocaleString()} tokens`);
        if (info.maxOutputTokens) parts.push(`Output: ${info.maxOutputTokens.toLocaleString()} tokens`);
        parts.push(info.subscription ? 'Included in subscription' : 'Pay-per-use');
        $('#charMemory_providerModelInfo').text(parts.join(' | '));
    } else {
        $('#charMemory_providerModelInfo').text('');
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
    const savedPrompt = extension_settings[MODULE_NAME].extractionPrompt || '';
    if (savedPrompt.includes('Separate each memory with a line containing only') ||
        savedPrompt.includes('FOCUS ON these categories:') ||
        savedPrompt.includes('markdown bulleted list')) {
        extension_settings[MODULE_NAME].extractionPrompt = defaultExtractionPrompt;
        saveSettingsDebounced();
    }
    if (extension_settings[MODULE_NAME].maxMessagesPerExtraction < 10) {
        extension_settings[MODULE_NAME].maxMessagesPerExtraction = 10;
        saveSettingsDebounced();
    }
    if (extension_settings[MODULE_NAME].fileName === DEFAULT_FILE_NAME) {
        extension_settings[MODULE_NAME].fileName = '';
        saveSettingsDebounced();
    }
    if (extension_settings[MODULE_NAME].source === 'nanogpt') {
        extension_settings[MODULE_NAME].source = EXTRACTION_SOURCE.PROVIDER;
        extension_settings[MODULE_NAME].selectedProvider = 'nanogpt';
        const nanoSettings = getProviderSettings('nanogpt');
        if (extension_settings[MODULE_NAME].nanogptApiKey) {
            nanoSettings.apiKey = extension_settings[MODULE_NAME].nanogptApiKey;
        }
        if (extension_settings[MODULE_NAME].nanogptModel) {
            nanoSettings.model = extension_settings[MODULE_NAME].nanogptModel;
        }
        if (extension_settings[MODULE_NAME].nanogptSystemPrompt) {
            nanoSettings.systemPrompt = extension_settings[MODULE_NAME].nanogptSystemPrompt;
        }
        nanoSettings.nanogptFilterSubscription = !!extension_settings[MODULE_NAME].nanogptFilterSubscription;
        nanoSettings.nanogptFilterOpenSource = !!extension_settings[MODULE_NAME].nanogptFilterOpenSource;
        nanoSettings.nanogptFilterRoleplay = !!extension_settings[MODULE_NAME].nanogptFilterRoleplay;
        nanoSettings.nanogptFilterReasoning = !!extension_settings[MODULE_NAME].nanogptFilterReasoning;
        saveSettingsDebounced();
    }
    $('#charMemory_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#charMemory_perChat').prop('checked', extension_settings[MODULE_NAME].perChat);
    $('#charMemory_interval').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_intervalCounter').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_maxMessages').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_maxMessagesCounter').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_responseLength').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_responseLengthCounter').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_minCooldown').val(extension_settings[MODULE_NAME].minCooldownMinutes);
    $('#charMemory_minCooldownCounter').val(extension_settings[MODULE_NAME].minCooldownMinutes);
    $('#charMemory_extractionPrompt').val(extension_settings[MODULE_NAME].extractionPrompt);
    $('#charMemory_source').val(extension_settings[MODULE_NAME].source);
    $('#charMemory_fileName').val(extension_settings[MODULE_NAME].fileName);
    $('#charMemory_verboseLog').prop('checked', extension_settings[MODULE_NAME].verboseLogging);
    populateProviderDropdown();
    toggleProviderSettings(extension_settings[MODULE_NAME].source);
    updateStatusDisplay();
}

let cooldownTimerInterval = null;

function updateStatusDisplay() {
    ensureMetadata();
    const charName = getCharacterName();
    if (charName) {
        const count = countMemoryFiles();
        $('#charMemory_statFile').text(`${count} file${count !== 1 ? 's' : ''}`).attr('title', 'Individual memory files in Data Bank');
        $('#charMemory_statCount').text(`${count} memor${count === 1 ? 'y' : 'ies'}`);
    } else {
        $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
        $('#charMemory_statCount').text('0 memories');
    }
    const msgsSince = chat_metadata[MODULE_NAME]?.messagesSinceExtraction || 0;
    const interval = extension_settings[MODULE_NAME]?.interval || 10;
    $('#charMemory_statProgress').text(`${msgsSince}/${interval} msgs`);
    updateCooldownDisplay();
    startCooldownTimer();
}

function updateCooldownDisplay() {
    const cooldownMs = (extension_settings[MODULE_NAME]?.minCooldownMinutes || 0) * 60000;
    if (cooldownMs <= 0 || lastExtractionTime === 0) {
        $('#charMemory_statCooldown').text('Ready');
        return;
    }
    const elapsed = Date.now() - lastExtractionTime;
    if (elapsed >= cooldownMs) {
        $('#charMemory_statCooldown').text('Ready');
    } else {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        $('#charMemory_statCooldown').text(`${remaining}m cooldown`);
    }
}

function startCooldownTimer() {
    if (cooldownTimerInterval) return;
    cooldownTimerInterval = setInterval(() => {
        updateCooldownDisplay();
        const cooldownMs = (extension_settings[MODULE_NAME]?.minCooldownMinutes || 0) * 60000;
        if (cooldownMs <= 0 || lastExtractionTime === 0 || Date.now() - lastExtractionTime >= cooldownMs) {
            clearInterval(cooldownTimerInterval);
            cooldownTimerInterval = null;
        }
    }, 15000);
}

function setupListeners() {
    $('#charMemory_enabled').off('change').on('change', function () {
        extension_settings[MODULE_NAME].enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#charMemory_interval').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].interval = val;
        $('#charMemory_intervalCounter').val(val);
        saveSettingsDebounced();
        updateStatusDisplay();
    });
    $('#charMemory_maxMessages').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].maxMessagesPerExtraction = val;
        $('#charMemory_maxMessagesCounter').val(val);
        saveSettingsDebounced();
    });
    $('#charMemory_minCooldown').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].minCooldownMinutes = val;
        $('#charMemory_minCooldownCounter').val(val);
        saveSettingsDebounced();
    });
    $('#charMemory_responseLength').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].responseLength = val;
        $('#charMemory_responseLengthCounter').val(val);
        saveSettingsDebounced();
    });
    $('#charMemory_source').off('change').on('change', function () {
        const val = String($(this).val());
        extension_settings[MODULE_NAME].source = val;
        saveSettingsDebounced();
        toggleProviderSettings(val);
    });
    $('#charMemory_providerSelect').off('change').on('change', function () {
        extension_settings[MODULE_NAME].selectedProvider = String($(this).val());
        saveSettingsDebounced();
        $('#charMemory_providerTestStatus').hide().text('');
        $('#charMemory_providerConnectStatus').hide().text('');
        updateProviderUI();
    });
    $('#charMemory_providerApiKey').off('input').on('input', function () {
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const providerSettings = getProviderSettings(providerKey);
        providerSettings.apiKey = String($(this).val());
        saveSettingsDebounced();
    });
    $('#charMemory_providerConnect').off('click').on('click', async function () {
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const preset = PROVIDER_PRESETS[providerKey];
        const providerSettings = getProviderSettings(providerKey);
        const $btn = $(this);
        const $status = $('#charMemory_providerConnectStatus');
        if (preset?.requiresApiKey && !providerSettings.apiKey) {
            $status.text('Enter an API key first.').css('color', '#e74c3c').show();
            return;
        }
        $btn.prop('disabled', true).val('Connecting...');
        $status.text('Fetching models...').css('color', '').show();
        try {
            await populateProviderModels(providerKey, true);
            const modelCount = $('#charMemory_providerModel option').length - 1;
            if (modelCount > 0) {
                $status.text(`Connected — ${modelCount} model${modelCount !== 1 ? 's' : ''} available.`).css('color', '#27ae60').show();
            } else {
                $status.text('Connected, but no models returned.').css('color', '#e67e22').show();
            }
        } catch (err) {
            $status.text(`Connection failed: ${err.message}`).css('color', '#e74c3c').show();
        } finally {
            $btn.prop('disabled', false).val('Connect');
        }
    });
    $('#charMemory_providerModel').off('change').on('change', async function () {
        const val = String($(this).val());
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const providerSettings = getProviderSettings(providerKey);
        providerSettings.model = val;
        saveSettingsDebounced();
        if (providerKey === 'nanogpt' && cachedNanoGptModels) {
            updateProviderModelInfo(cachedNanoGptModels, val);
        }
    });
    $('#charMemory_providerModelInput').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.model = String($(this).val());
        saveSettingsDebounced();
    });
    $('#charMemory_providerRefreshModels').off('click').on('click', function () {
        populateProviderModels(extension_settings[MODULE_NAME].selectedProvider, true);
    });
    $('#charMemory_providerBaseUrl').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.customBaseUrl = String($(this).val());
        saveSettingsDebounced();
    });
    $('#charMemory_providerSystemPrompt').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.systemPrompt = String($(this).val());
        saveSettingsDebounced();
    });
    $('#charMemory_providerApiKeyReveal').off('click').on('click', function () {
        const $input = $('#charMemory_providerApiKey');
        const $icon = $(this).find('i');
        const $btn = $(this);
        clearTimeout($btn.data('revealTimer'));
        if ($input.attr('type') === 'password') {
            $input.attr('type', 'text');
            $icon.removeClass('fa-eye').addClass('fa-eye-slash');
            $btn.data('revealTimer', setTimeout(() => {
                $input.attr('type', 'password');
                $icon.removeClass('fa-eye-slash').addClass('fa-eye');
            }, 10000));
        } else {
            $input.attr('type', 'password');
            $icon.removeClass('fa-eye-slash').addClass('fa-eye');
        }
    });
    $('#charMemory_providerTest').off('click').on('click', () => testProviderConnection());
    $('#charMemory_nanogptFilterSub').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterSubscription = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });
    $('#charMemory_nanogptFilterOS').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterOpenSource = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });
    $('#charMemory_nanogptFilterRP').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterRoleplay = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });
    $('#charMemory_nanogptFilterReasoning').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterReasoning = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });
    $('#charMemory_verboseLog').off('change').on('change', function () {
        extension_settings[MODULE_NAME].verboseLogging = !!$(this).prop('checked');
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
        extractMemories({ force: true });
    });
    $('#charMemory_resetTracking').off('click').on('click', function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();
        const charName = getCharacterName();
        if (charName && extension_settings[MODULE_NAME].batchState) {
            const prefix = `${charName}:`;
            for (const key of Object.keys(extension_settings[MODULE_NAME].batchState)) {
                if (key.startsWith(prefix)) {
                    delete extension_settings[MODULE_NAME].batchState[key];
                }
            }
            saveSettingsDebounced();
        }
        updateStatusDisplay();
        toastr.success('Extraction state reset for all chats. Next extraction will re-read all messages.', 'CharMemory');
    });
    $('#charMemory_resetExtraction').off('click').on('click', async function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();
        const charName = getCharacterName();
        if (charName && extension_settings[MODULE_NAME].batchState) {
            const prefix = `${charName}:`;
            for (const key of Object.keys(extension_settings[MODULE_NAME].batchState)) {
                if (key.startsWith(prefix)) {
                    delete extension_settings[MODULE_NAME].batchState[key];
                }
            }
            saveSettingsDebounced();
        }
        const files = findAllMemoryFiles();
        for (const file of files) {
            await deleteAttachment(file, 'character', () => {}, false);
        }
        $('#charMemory_statCount').text('0 memories');
        $('#charMemory_statProgress').text(`0/${extension_settings[MODULE_NAME].interval} msgs`);
        updateStatusDisplay();
        toastr.success('All memory files deleted and extraction state reset.', 'CharMemory');
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
    $('.charMemory_tab').off('click').on('click', function () {
        const tab = $(this).data('tab');
        $('.charMemory_tab').removeClass('active');
        $(this).addClass('active');
        $('.charMemory_tabContent').hide();
        const capName = tab.charAt(0).toUpperCase() + tab.slice(1);
        $(`#charMemory_tab${capName}`).show();
        if (tab === 'batch') loadBatchChatList();
    });
    $('#charMemory_refreshDiag').off('click').on('click', function () {
        captureDiagnostics();
        toastr.info('Diagnostics refreshed.', 'CharMemory');
    });
    $('#charMemory_clearLog').off('click').on('click', function () {
        activityLog = [];
        updateActivityLogDisplay();
    });
    $('#charMemory_saveLog').off('click').on('click', function () {
        if (activityLog.length === 0) {
            toastr.info('Activity log is empty.', 'CharMemory');
            return;
        }
        const lines = activityLog.map(e => `[${e.timestamp}] [${e.type}] ${e.message}`).join('\n');
        const blob = new Blob([lines], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `charMemory-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });
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
    $(document).off('change', '.charMemory_batchChatCheck').on('change', '.charMemory_batchChatCheck', updateBatchButtons);
}

// ============ Per-Message Buttons & Indicators ============

function updateIndicatorForMessage(mesElement, messageIndex) {
    const $mes = $(mesElement);
    const $nameBlock = $mes.find('.ch_name');
    $nameBlock.find('.charMemory_extractedIndicator').remove();
    ensureMetadata();
    const lastIdx = chat_metadata[MODULE_NAME]?.lastExtractedIndex ?? -1;
    if (messageIndex <= lastIdx && messageIndex >= 0) {
        $nameBlock.append('<span class="charMemory_extractedIndicator" title="Memory extracted"><i class="fa-solid fa-brain fa-xs"></i></span>');
    }
}

function updateAllIndicators() {
    ensureMetadata();
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;
        const context = getContext();
        const msg = context.chat[mesId];
        if (!msg || msg.is_user || msg.is_system) return;
        updateIndicatorForMessage(this, mesId);
    });
}

function addButtonsToExistingMessages() {
    const context = getContext();
    if (context.characterId === undefined) return;
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;
        const msg = context.chat[mesId];
        if (!msg || msg.is_system) return;
        const $extraBtns = $(this).find('.extraMesButtons');
        if (!$extraBtns.length) return;
        if ($extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').length) return;
        $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${mesId}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);
        if (!msg.is_user) {
            $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${mesId}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
            updateIndicatorForMessage(this, mesId);
        }
    });
}

function onMessageRenderedAddButtons(messageIndex) {
    const context = getContext();
    if (context.characterId === undefined) return;
    const msg = context.chat[messageIndex];
    if (!msg || msg.is_system) return;
    const $mes = $(`#chat .mes[mesid="${messageIndex}"]`);
    if (!$mes.length) return;
    const $extraBtns = $mes.find('.extraMesButtons');
    if (!$extraBtns.length) return;
    $extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').remove();
    $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${messageIndex}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);
    if (!msg.is_user) {
        $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${messageIndex}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
        updateIndicatorForMessage($mes, messageIndex);
    }
}

async function onExtractHereClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    await extractMemories({ force: true, endIndex: messageIndex });
}

async function onPinMemoryClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    const context = getContext();
    const msg = context.chat[messageIndex];
    if (!msg) return;
    const plainText = msg.mes.replace(/<[^>]*>/g, '').trim();
    if (!plainText) {
        toastr.warning('Message has no text content.', 'CharMemory');
        return;
    }
    const edited = await callGenericPopup('Edit text to save as a memory:', POPUP_TYPE.INPUT, plainText, { rows: 6 });
    if (edited === null || edited === false) return;
    const text = String(edited).trim();
    if (!text) return;
    const charName = getCharacterName();
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const memoryContent = `Date: ${timestamp}
Time: ${now.toLocaleTimeString()}
Event Type: action
Importance: 3
Summary: ${text}
Characters Involved: ${charName}
Witnesses: None
Location: Unspecified
Emotional/Relationship Impact: Pinned memory from conversation.`;
    try {
        const fileName = await writeMemoryFile(memoryContent, charName);
        toastr.success(`Memory saved as ${fileName}`, 'CharMemory');
        updateStatusDisplay();
    } catch (err) {
        toastr.error('Failed to save memory.', 'CharMemory');
    }
}

// ============ Batch Extraction ============

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
        let lastMsg = '';
        if (chat.last_mes) {
            const d = new Date(chat.last_mes);
            if (!isNaN(d.getTime())) lastMsg = d.toLocaleDateString();
        }
        const safeName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return `<div class="charMemory_batchChatItem">
            <label class="checkbox_label">
                <input type="checkbox" class="charMemory_batchChatCheck" data-filename="${safeName}" checked />
                <span class="charMemory_batchChatName" title="${safeName}">${safeLabel}</span>
            </label>
            <span class="charMemory_batchChatMeta">${count} msgs${lastMsg ? ' | ' + lastMsg : ''}</span>
        </div>`;
    }).join('');
    $list.html(html);
    $('#charMemory_batchSelectAll').prop('checked', true);
    updateBatchButtons();
}

function updateBatchButtons() {
    const anyChecked = $('.charMemory_batchChatCheck:checked').length > 0;
    $('#charMemory_batchExtract').prop('disabled', !anyChecked);
}

async function runBatchExtraction() {
    const selected = [];
    $('.charMemory_batchChatCheck:checked').each(function () {
        selected.push(String($(this).data('filename')));
    });
    if (selected.length === 0) return;
    const confirmed = await callGenericPopup(
        `Extract memories from ${selected.length} chat(s)? This may make multiple API calls per chat.`,
        POPUP_TYPE.CONFIRM,
    );
    if (!confirmed) return;
    batchAbortController = new AbortController();
    const $progress = $('#charMemory_batchProgress');
    const $progressText = $progress.find('.charMemory_batchProgressText');
    const $progressFill = $progress.find('.charMemory_batchProgressFill');
    $progress.show();
    $progressFill.css('width', '0%');
    $('#charMemory_batchStop').show();
    $('#charMemory_batchExtract').prop('disabled', true);
    $('#charMemory_batchRefresh').prop('disabled', true);
    let totalMemories = 0;
    const context = getContext();
    const currentChatId = context.chatId;
    logActivity(`Batch extraction started: ${selected.length} chat(s) selected`);
    for (let i = 0; i < selected.length; i++) {
        if (batchAbortController.signal.aborted) break;
        const chatName = selected[i];
        const pct = Math.round((i / selected.length) * 100);
        $progressText.text(`Chat ${i + 1}/${selected.length}: ${chatName}`);
        $progressFill.css('width', `${pct}%`);
        logActivity(`Batch: starting chat "${chatName}" (${i + 1}/${selected.length})`);
        const batchProgressLabel = `Chat ${i + 1}/${selected.length}: ${chatName}`;
        if (chatName === currentChatId) {
            const result = await extractMemories({
                force: true,
                abortSignal: batchAbortController.signal,
                progressLabel: batchProgressLabel,
                onProgress: ({ chunk, totalChunks }) => {
                    $progressText.text(`${batchProgressLabel} (chunk ${chunk}/${totalChunks})`);
                },
            });
            totalMemories += result.totalMemories;
            continue;
        }
        const chatData = await fetchChatMessages(chatName);
        if (!chatData || chatData.messages.length === 0) {
            logActivity(`Batch: chat "${chatName}" has no messages, skipping`, 'warning');
            continue;
        }
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
            progressLabel: batchProgressLabel,
            onProgress: ({ chunk, totalChunks }) => {
                $progressText.text(`${batchProgressLabel} (chunk ${chunk}/${totalChunks})`);
            },
        });
        if (result.lastExtractedIndex !== undefined) {
            extension_settings[MODULE_NAME].batchState[batchStateKey] = {
                lastExtractedIndex: result.lastExtractedIndex,
            };
            saveSettingsDebounced();
        }
        totalMemories += result.totalMemories;
    }
    $progressFill.css('width', '100%');
    const aborted = batchAbortController.signal.aborted;
    $progressText.text(aborted
        ? `Stopped. ${totalMemories} memories extracted before cancellation.`
        : `Done! ${totalMemories} memories extracted from ${selected.length} chat(s).`
    );
    $('#charMemory_batchStop').hide();
    $('#charMemory_batchExtract').prop('disabled', false);
    $('#charMemory_batchRefresh').prop('disabled', false);
    batchAbortController = null;
    logActivity(`Batch extraction ${aborted ? 'stopped' : 'complete'}: ${totalMemories} memories from ${selected.length} chats`, aborted ? 'warning' : 'success');
    updateStatusDisplay();
}

// ============ Init ============

jQuery(async function () {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/sillytavern-character-memory', 'settings');
    $('#extensions_settings2').append(settingsHtml);
    loadSettings();
    setupListeners();
    registerSlashCommands();
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    $(document).on('click', '.charMemory_extractHereBtn', onExtractHereClick);
    $(document).on('click', '.charMemory_pinMemoryBtn', onPinMemoryClick);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, captureDiagnostics);
    console.log(LOG_PREFIX, 'Extension loaded');
});
