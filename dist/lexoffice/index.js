"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMessage = handleMessage;
require("dotenv/config");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const axios_1 = __importDefault(require("axios"));
const intent_1 = require("./intent");
const contacts_1 = require("./contacts");
const invoices_1 = require("./invoices");
// ── Claude client for extraction prompts ──────────────────────────────────────
const anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
// ── Per-JID pending operation state ──────────────────────────────────────────
const pending = new Map();
// ── API key helper ────────────────────────────────────────────────────────────
function getApiKey() {
    const key = process.env.LEXOFFICE_API_KEY;
    if (!key)
        throw new Error('LEXOFFICE_API_KEY is not configured in .env');
    return key;
}
// ── Error formatting ──────────────────────────────────────────────────────────
function formatApiError(err) {
    if (axios_1.default.isAxiosError(err)) {
        const axiosErr = err;
        const status = axiosErr.response?.status;
        const data = axiosErr.response?.data;
        const detail = data
            ? typeof data === 'string'
                ? data
                : JSON.stringify(data)
            : axiosErr.message;
        if (status === 401)
            return '❌ Lexoffice API key is invalid or expired.';
        if (status === 406)
            return `❌ Lexoffice rejected the invoice (406): ${detail}`;
        if (status === 422)
            return `❌ Lexoffice rejected the request (422): ${detail}`;
        if (status === 429)
            return '⏳ Lexoffice rate limit reached — please try again in a moment.';
        if (status)
            return `❌ Lexoffice error ${status}: ${detail}`;
        return `❌ Lexoffice error: ${axiosErr.message}`;
    }
    if (err instanceof Error)
        return `❌ Error: ${err.message}`;
    return '❌ An unexpected error occurred.';
}
// ── Invoice detail extraction ─────────────────────────────────────────────────
function buildInvoiceExtractPrompt() {
    const today = new Date().toISOString().slice(0, 10);
    return `Extract invoice creation details from the user message. Return a single JSON object — no markdown, no code fences.

Today's date: ${today}

Schema (all fields required, use null when absent):
{
  "contactName": "<company or person name | null>",
  "shippingDate": "<YYYY-MM-DD | null>",
  "lineItems": [
    {
      "name": "<item title | null>",
      "description": "<longer description text | null>",
      "quantity": <positive number | null>,
      "unitPrice": <net price per unit in EUR | null>,
      "taxRate": <0 | 7 | 19 | null>
    }
  ]
}

Rules:
- lineItems must be an array — empty [] if no items are mentioned
- Include a partial item (with null fields) if any item detail is mentioned
- taxRate: map "no tax", "exempt", "tax-free" → 0; "19%" → 19; "7%" → 7
- quantity: infer 1 when user implies a single unit
- shippingDate: resolve relative expressions using today's date (e.g. "today" → ${today})
- description is the longer explanatory text, not the item title`;
}
async function extractInvoiceDetails(text) {
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: buildInvoiceExtractPrompt(),
        messages: [{ role: 'user', content: text }],
    });
    const firstBlock = response.content[0];
    const raw = firstBlock?.type === 'text' ? firstBlock.text : '';
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match)
            return { contactName: null, shippingDate: null, lineItems: [] };
        const parsed = JSON.parse(match[0]);
        console.log('[invoice extract]', JSON.stringify(parsed));
        return {
            contactName: parsed.contactName ?? null,
            shippingDate: parsed.shippingDate ?? null,
            lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
        };
    }
    catch {
        console.log('[invoice extract] JSON parse failed. Raw response:', raw);
        return { contactName: null, shippingDate: null, lineItems: [] };
    }
}
// ── Invoice modification extraction ──────────────────────────────────────────
function buildModificationExtractPrompt(data) {
    const today = new Date().toISOString().slice(0, 10);
    const itemsSummary = data.lineItems
        .map((item, i) => `  Item ${i + 1}: name="${item.name}", qty=${item.quantity}, price=${item.unitPrice}, tax=${item.taxRate}%`)
        .join('\n');
    return `You are extracting modification instructions for a draft invoice from a WhatsApp message.

Current invoice state:
- Contact: ${data.contactName ?? 'not set'}
- Service date: ${data.shippingDate ? data.shippingDate.toISOString().slice(0, 10) : 'not set'}
- Line items (${data.lineItems.length}):
${itemsSummary || '  (none)'}

Today's date: ${today}

Return a single JSON object — no markdown, no code fences.

Schema:
{
  "action": "confirm" | "add_item" | "modify",
  "contactName": "<new contact name | null>",
  "shippingDate": "<YYYY-MM-DD | null>",
  "lineItemUpdates": [
    {
      "itemIndex": <0-based integer | null defaults to first item>,
      "name": "<new name | null>",
      "description": "<new description | null>",
      "quantity": <new positive number | null>,
      "unitPrice": <new net price in EUR | null>,
      "taxRate": <0 | 7 | 19 | null>
    }
  ]
}

Rules:
- action "confirm": user is happy as-is (e.g. "yes", "ok", "confirm", "looks good", "create it")
- action "add_item": user explicitly wants to add a new line item
- action "modify": user wants to change one or more fields
- lineItemUpdates: only include entries when a line item field should change
- itemIndex: use null when user doesn't specify which item (treat as first/only item)`;
}
async function extractModifications(text, data) {
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: buildModificationExtractPrompt(data),
        messages: [{ role: 'user', content: text }],
    });
    const firstBlock = response.content[0];
    const raw = firstBlock?.type === 'text' ? firstBlock.text : '';
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match)
            return { action: 'unknown' };
        const parsed = JSON.parse(match[0]);
        console.log('[modification extract]', JSON.stringify(parsed));
        return parsed;
    }
    catch {
        console.log('[modification extract] JSON parse failed. Raw response:', raw);
        return { action: 'unknown' };
    }
}
// ── Shared helpers ────────────────────────────────────────────────────────────
function isCancelCommand(text) {
    return /^(cancel|stop|abort|quit|exit)\b/i.test(text.trim());
}
function parseTaxRate(val) {
    const clean = val.toLowerCase().replace('%', '').trim();
    if (['exempt', 'no tax', 'steuerbefreit', 'none'].includes(clean))
        return 0;
    const n = parseFloat(clean);
    if (n === 0 || n === 7 || n === 19)
        return n;
    return null;
}
function parseShippingDate(str) {
    if (!str)
        return null;
    const s = str.trim();
    if (/^(today|heute)$/i.test(s))
        return new Date();
    const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let date;
    if (dmy) {
        date = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
    }
    else if (iso) {
        date = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
    }
    return date && !isNaN(date.getTime()) ? date : null;
}
/**
 * Determine the next step given the current wizard data.
 * May return internal transition signals ('finalize_item', 'start_item')
 * which are resolved by advanceInvoiceStep and never stored.
 */
function computeNextInvoiceStep(data) {
    if (!data.contactId)
        return 'await_contact';
    if (!data.shippingDate)
        return 'await_shipping_date';
    const p = data.pendingItem;
    if (p !== null) {
        if (p.name == null)
            return 'await_item_name';
        if (p.description === undefined)
            return 'await_item_description';
        if (p.quantity == null)
            return 'await_quantity';
        if (p.unitPrice == null)
            return 'await_price';
        if (p.taxRate == null)
            return 'await_tax';
        return 'finalize_item';
    }
    if (data.lineItems.length === 0)
        return 'start_item';
    return data.builtInteractively ? 'await_more_items' : 'await_additions';
}
/**
 * Advance the operation to the next real wizard step, resolving any internal
 * transitions (finalize_item, start_item). Mutates op in place.
 */
function advanceInvoiceStep(op) {
    let next = computeNextInvoiceStep(op.data);
    while (next === 'finalize_item' || next === 'start_item') {
        if (next === 'finalize_item') {
            // pendingItem is guaranteed non-null when we reach finalize_item
            op.data.lineItems.push({ ...op.data.pendingItem });
            op.data.pendingItem = null;
        }
        else {
            op.data.pendingItem = {
                name: null,
                description: undefined,
                quantity: null,
                unitPrice: null,
                taxRate: null,
            };
            op.data.builtInteractively = true;
        }
        next = computeNextInvoiceStep(op.data);
    }
    op.step = next;
    return op.step;
}
/** Build the WhatsApp prompt for a given invoice wizard step. */
function invoiceStepPrompt(step, data) {
    const itemNum = data.lineItems.length + 1;
    const itemName = data.pendingItem?.name ?? '';
    switch (step) {
        case 'await_contact':
            return '🧾 For which contact should I create the invoice?';
        case 'await_shipping_date':
            return '📅 What is the service date?\nType *today* or enter a date (e.g. *05.04.2026*)';
        case 'await_item_name':
            return `📝 What is the *name* (title) for line item ${itemNum}?`;
        case 'await_item_description':
            return `📄 Add a description for *"${itemName}"*? (type *skip* to omit)`;
        case 'await_quantity':
            return `🔢 What is the quantity for *"${itemName}"*?`;
        case 'await_price':
            return `💶 What is the unit price in EUR (net, excluding tax) for *"${itemName}"*?`;
        case 'await_tax':
            return `🏷️ What tax rate applies to *"${itemName}"*?\nReply with *0*, *7*, *19*, or *exempt*`;
        case 'await_more_items':
            return `✅ Line item ${data.lineItems.length} added.\n\n➕ Would you like to add another line item? (*yes* / *no*)`;
        case 'await_additions':
            return ((0, invoices_1.formatInvoiceSummary)(data) +
                '\n\n─────────────────\n' +
                'Anything to add or change?\n' +
                'Reply *confirm* to create · *add item* for another line item · *cancel* to abort');
    }
}
// ── Contact creation wizard ───────────────────────────────────────────────────
async function stepContactCreate(text, jid) {
    const val = text.trim();
    const op = pending.get(jid);
    if (op.step === 'await_name') {
        op.data.name = val;
        op.step = 'await_email';
        pending.set(jid, op);
        return `📧 What is the email address for *${val}*? (type *skip* to omit)`;
    }
    if (op.step === 'await_email') {
        op.data.email = /^skip$/i.test(val) ? null : val;
        op.step = 'await_phone';
        pending.set(jid, op);
        return `📞 What is the phone number? (type *skip* to omit)`;
    }
    // step === 'await_phone'
    op.data.phone = /^skip$/i.test(val) ? null : val;
    pending.delete(jid);
    const name = op.data.name ?? '';
    const created = await (0, contacts_1.createContact)(getApiKey(), { name, email: op.data.email, phone: op.data.phone });
    return `✅ *Contact created*\n👤 ${name}\n🆔 ID: ${created.id}`;
}
// ── Invoice creation wizard ───────────────────────────────────────────────────
async function stepInvoiceCreate(text, jid, sendProgress) {
    const val = text.trim();
    const op = pending.get(jid);
    const apiKey = getApiKey();
    // ── Process the user's answer for the current step ───────────────────────
    switch (op.step) {
        case 'await_contact': {
            await sendProgress(`🔍 Looking up *${val}* in Lexoffice...`);
            const contact = await (0, contacts_1.findContact)(apiKey, val);
            if (!contact) {
                return `🔍 No contact found for *"${val}"*. Please try a different name or type *cancel* to stop.`;
            }
            op.data.contactId = contact.id;
            op.data.contactName = (0, contacts_1.resolveName)(contact);
            break;
        }
        case 'await_shipping_date': {
            const date = parseShippingDate(val);
            if (!date) {
                return `⚠️ Please enter a valid date — type *today*, *05.04.2026*, or *2026-04-05*.`;
            }
            op.data.shippingDate = date;
            break;
        }
        case 'await_item_name': {
            if (!op.data.pendingItem)
                throw new Error('Expected pendingItem to exist at await_item_name');
            op.data.pendingItem.name = val;
            op.data.builtInteractively = true;
            break;
        }
        case 'await_item_description': {
            if (!op.data.pendingItem)
                throw new Error('Expected pendingItem to exist at await_item_description');
            op.data.pendingItem.description = /^skip$/i.test(val) ? null : val;
            break;
        }
        case 'await_quantity': {
            if (!op.data.pendingItem)
                throw new Error('Expected pendingItem to exist at await_quantity');
            const qty = parseFloat(val.replace(',', '.'));
            if (isNaN(qty) || qty <= 0) {
                return `⚠️ Please enter a valid positive number for the quantity.`;
            }
            op.data.pendingItem.quantity = qty;
            break;
        }
        case 'await_price': {
            if (!op.data.pendingItem)
                throw new Error('Expected pendingItem to exist at await_price');
            const price = parseFloat(val.replace(',', '.'));
            if (isNaN(price) || price <= 0) {
                return `⚠️ Please enter a valid positive number for the price.`;
            }
            op.data.pendingItem.unitPrice = price;
            break;
        }
        case 'await_tax': {
            if (!op.data.pendingItem)
                throw new Error('Expected pendingItem to exist at await_tax');
            const taxRate = parseTaxRate(val);
            if (taxRate === null) {
                return `⚠️ Please reply with *0*, *7*, *19*, or *exempt*.`;
            }
            op.data.pendingItem.taxRate = taxRate;
            break;
        }
        case 'await_more_items': {
            if (/^(yes|y|ja|yeah|yep)\b/i.test(val)) {
                op.data.pendingItem = {
                    name: null,
                    description: undefined,
                    quantity: null,
                    unitPrice: null,
                    taxRate: null,
                };
                op.data.builtInteractively = true;
                op.step = 'await_item_name';
                pending.set(jid, op);
                return invoiceStepPrompt('await_item_name', op.data);
            }
            op.step = 'await_additions';
            pending.set(jid, op);
            return invoiceStepPrompt('await_additions', op.data);
        }
        case 'await_additions': {
            await sendProgress('🤖 Processing your request...');
            const mod = await extractModifications(val, op.data);
            if (mod.action === 'add_item') {
                op.data.pendingItem = {
                    name: null,
                    description: undefined,
                    quantity: null,
                    unitPrice: null,
                    taxRate: null,
                };
                op.data.builtInteractively = true;
                op.step = 'await_item_name';
                pending.set(jid, op);
                return invoiceStepPrompt('await_item_name', op.data);
            }
            if (mod.action === 'confirm') {
                await sendProgress('🔄 Creating draft invoice in Lexoffice...');
                const invoice = await (0, invoices_1.createInvoice)(apiKey, {
                    contactId: op.data.contactId,
                    lineItems: op.data.lineItems,
                    shippingDate: op.data.shippingDate,
                });
                pending.delete(jid);
                return (0, invoices_1.formatCreatedInvoice)(invoice);
            }
            if (mod.action === 'modify') {
                const errors = [];
                if (mod.contactName) {
                    await sendProgress(`🔍 Looking up *${mod.contactName}* in Lexoffice...`);
                    const contact = await (0, contacts_1.findContact)(apiKey, mod.contactName);
                    if (!contact) {
                        errors.push(`❌ No contact found for *"${mod.contactName}"*. Please try a different name.`);
                    }
                    else {
                        op.data.contactId = contact.id;
                        op.data.contactName = (0, contacts_1.resolveName)(contact);
                    }
                }
                if (mod.shippingDate) {
                    const date = parseShippingDate(mod.shippingDate);
                    if (date)
                        op.data.shippingDate = date;
                }
                if (Array.isArray(mod.lineItemUpdates)) {
                    for (const update of mod.lineItemUpdates) {
                        const idx = update.itemIndex ?? 0;
                        const item = op.data.lineItems[idx];
                        if (!item)
                            continue;
                        if (update.name != null)
                            item.name = update.name;
                        if (update.description != null)
                            item.description = update.description;
                        if (update.quantity != null)
                            item.quantity = update.quantity;
                        if (update.unitPrice != null)
                            item.unitPrice = update.unitPrice;
                        if (update.taxRate != null)
                            item.taxRate = update.taxRate;
                    }
                }
                pending.set(jid, op);
                const errorPrefix = errors.length ? errors.join('\n') + '\n\n' : '';
                return errorPrefix + invoiceStepPrompt('await_additions', op.data);
            }
            // Unrecognised response — re-show the prompt
            return invoiceStepPrompt('await_additions', op.data);
        }
    }
    // ── Advance to the next missing field ─────────────────────────────────────
    const nextStep = advanceInvoiceStep(op);
    pending.set(jid, op);
    return invoiceStepPrompt(nextStep, op.data);
}
// ── Pending operation dispatcher ──────────────────────────────────────────────
async function continuePending(text, jid, sendProgress) {
    if (isCancelCommand(text)) {
        pending.delete(jid);
        return '❎ Operation cancelled.';
    }
    const op = pending.get(jid);
    try {
        if (op.type === 'contact_create')
            return await stepContactCreate(text, jid);
        if (op.type === 'invoice_create')
            return await stepInvoiceCreate(text, jid, sendProgress);
    }
    catch (err) {
        pending.delete(jid);
        return formatApiError(err);
    }
    pending.delete(jid);
    return '⚠️ Something went wrong. The operation has been cancelled.';
}
// ── Intent handlers ───────────────────────────────────────────────────────────
async function handleContactFind(entities, sendProgress) {
    if (!entities.contactName) {
        return `🔍 What is the name of the contact you're looking for?`;
    }
    await sendProgress(`🔍 Looking up *${entities.contactName}* in Lexoffice...`);
    const contact = await (0, contacts_1.findContact)(getApiKey(), entities.contactName);
    if (!contact)
        return `🔍 No contact found for *"${entities.contactName}"* in Lexoffice.`;
    return (0, contacts_1.formatContactDetails)(contact);
}
async function handleContactExists(entities, sendProgress) {
    if (!entities.contactName)
        return `🔍 Which contact would you like to check?`;
    await sendProgress(`🔍 Checking Lexoffice for *${entities.contactName}*...`);
    const exists = await (0, contacts_1.contactExists)(getApiKey(), entities.contactName);
    return exists
        ? `✅ *${entities.contactName}* is in your Lexoffice contacts.`
        : `❌ *${entities.contactName}* was not found in your Lexoffice contacts.`;
}
async function handleContactCreate(entities, jid) {
    if (entities.contactName) {
        const op = {
            type: 'contact_create',
            step: 'await_email',
            data: { name: entities.contactName },
        };
        pending.set(jid, op);
        return `📧 What is the email address for *${entities.contactName}*? (type *skip* to omit)`;
    }
    const op = {
        type: 'contact_create',
        step: 'await_name',
        data: {},
    };
    pending.set(jid, op);
    return `👤 What is the name of the new contact (company or person)?`;
}
async function handleInvoiceSearch(entities, sendProgress) {
    const apiKey = getApiKey();
    const status = (0, invoices_1.normaliseStatus)(entities.invoiceStatus);
    const statusLabel = entities.invoiceStatus ?? null;
    if (entities.contactName) {
        await sendProgress(`🔍 Looking up *${entities.contactName}*...`);
        const contact = await (0, contacts_1.findContact)(apiKey, entities.contactName);
        if (!contact) {
            return `🔍 No contact found for *"${entities.contactName}"*. Cannot filter invoices.`;
        }
        const name = (0, contacts_1.resolveName)(contact);
        await sendProgress(`📄 Fetching invoices for *${name}*...`);
        const result = await (0, invoices_1.searchInvoices)(apiKey, { status, contactId: contact.id });
        return (0, invoices_1.formatInvoiceList)(result, { statusLabel, contactLabel: name });
    }
    await sendProgress(`📄 Fetching${statusLabel ? ` *${statusLabel}*` : ''} invoices...`);
    const result = await (0, invoices_1.searchInvoices)(apiKey, { status });
    return (0, invoices_1.formatInvoiceList)(result, { statusLabel });
}
async function handleInvoiceCreate(text, jid, sendProgress) {
    const apiKey = getApiKey();
    await sendProgress('🤖 Analysing your request...');
    const extracted = await extractInvoiceDetails(text);
    const data = {
        contactId: null,
        contactName: null,
        shippingDate: parseShippingDate(extracted.shippingDate),
        lineItems: [],
        pendingItem: null,
        builtInteractively: false,
    };
    // Sort extracted items: complete ones go to lineItems, the first incomplete
    // one becomes pendingItem so we can collect its missing fields interactively.
    for (const item of extracted.lineItems) {
        const isComplete = item.name != null &&
            item.quantity != null &&
            item.unitPrice != null &&
            item.taxRate != null;
        if (isComplete) {
            data.lineItems.push({
                name: item.name,
                description: item.description ?? null,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                taxRate: item.taxRate,
            });
        }
        else if (!data.pendingItem) {
            const pendingItem = {
                name: item.name ?? null,
                // undefined = not yet asked; if extraction gave a value, it's already answered
                description: item.description != null ? item.description : undefined,
                quantity: item.quantity ?? null,
                unitPrice: item.unitPrice ?? null,
                taxRate: item.taxRate ?? null,
            };
            data.pendingItem = pendingItem;
        }
    }
    // Resolve contact if one was named in the original message
    if (extracted.contactName) {
        await sendProgress(`🔍 Looking up *${extracted.contactName}* in Lexoffice...`);
        const contact = await (0, contacts_1.findContact)(apiKey, extracted.contactName);
        if (contact) {
            data.contactId = contact.id;
            data.contactName = (0, contacts_1.resolveName)(contact);
        }
        else {
            const op = {
                type: 'invoice_create',
                step: 'await_contact',
                data,
            };
            pending.set(jid, op);
            return `🔍 No contact found for *"${extracted.contactName}"*.\n\nPlease enter the correct contact name:`;
        }
    }
    const op = {
        type: 'invoice_create',
        step: 'await_contact', // placeholder — advanceInvoiceStep overwrites it
        data,
    };
    const firstStep = advanceInvoiceStep(op);
    pending.set(jid, op);
    return invoiceStepPrompt(firstStep, data);
}
// ── Public entry point ────────────────────────────────────────────────────────
/**
 * Handle an incoming WhatsApp message.
 * Returns a reply string for Lexoffice-related messages, or null if the
 * message is not a Lexoffice query (caller falls through to keyword replies).
 */
async function handleMessage(text, jid, sendProgress = async () => { }) {
    if (pending.has(jid)) {
        return continuePending(text, jid, sendProgress);
    }
    try {
        const { intent, entities } = await (0, intent_1.detectIntent)(text);
        if (intent === 'contact_find')
            return handleContactFind(entities, sendProgress);
        if (intent === 'contact_exists')
            return handleContactExists(entities, sendProgress);
        if (intent === 'contact_create')
            return handleContactCreate(entities, jid);
        if (intent === 'invoice_search')
            return handleInvoiceSearch(entities, sendProgress);
        if (intent === 'invoice_create')
            return handleInvoiceCreate(text, jid, sendProgress);
    }
    catch (err) {
        pending.delete(jid);
        if (err instanceof Error && err.message.startsWith('LEXOFFICE_API_KEY')) {
            return `⚠️ ${err.message}`;
        }
        return formatApiError(err);
    }
    return null; // Not a Lexoffice query — fall through to keyword replies
}
