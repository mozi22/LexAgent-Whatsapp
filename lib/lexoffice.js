require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const contacts  = require('./lexoffice/contacts');
const invoices  = require('./lexoffice/invoices');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pending multi-step operations, keyed by WhatsApp JID
const pending = new Map();

// ── Intent detection ──────────────────────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `You are an intent + entity extractor for a WhatsApp bot connected to Lexoffice.

Return a single JSON object — no markdown, no code fences, no explanation.

Supported intents:
  contact_find    — user wants details of a specific contact
  contact_exists  — user wants to check if a contact exists
  contact_create  — user wants to create / add a new contact
  invoice_search  — user wants to search or list invoices
  invoice_create  — user wants to create a new invoice
  unknown         — anything else

JSON schema (all keys required, use null when not present):
{
  "intent": "<intent>",
  "contactName": "<company or person name | null>",
  "invoiceStatus": "<open|overdue|paid|draft|all | null>"
}

Examples:
"give me details of campai"
{"intent":"contact_find","contactName":"campai","invoiceStatus":null}

"is Müller GmbH in my contacts?"
{"intent":"contact_exists","contactName":"Müller GmbH","invoiceStatus":null}

"add a new contact"
{"intent":"contact_create","contactName":null,"invoiceStatus":null}

"which invoices are open?"
{"intent":"invoice_search","contactName":null,"invoiceStatus":"open"}

"show open invoices of campai"
{"intent":"invoice_search","contactName":"campai","invoiceStatus":"open"}

"create a new draft invoice for campai"
{"intent":"invoice_create","contactName":"campai","invoiceStatus":null}

"create invoice"
{"intent":"invoice_create","contactName":null,"invoiceStatus":null}

"hello"
{"intent":"unknown","contactName":null,"invoiceStatus":null}`;

async function detectIntent(text) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 128,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const raw = response.content[0]?.text ?? '';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.log('[intent] no JSON found in:', raw);
      return { intent: null, entities: {} };
    }
    const parsed = JSON.parse(match[0]);
    const intent = parsed.intent === 'unknown' ? null : parsed.intent;
    console.log('[intent]', JSON.stringify(text), '→', intent, JSON.stringify(parsed));
    return { intent, entities: parsed };
  } catch {
    console.log('[intent] parse failed, raw was:', raw);
    return { intent: null, entities: {} };
  }
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
- quantity: infer 1 when user implies a single unit ("a service", "a line item costing X", "one item")
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

  const raw = response.content[0]?.text ?? '';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { contactName: null, shippingDate: null, lineItems: [] };
    const parsed = JSON.parse(match[0]);
    console.log('[invoice extract]', JSON.stringify(parsed));
    return {
      contactName:  parsed.contactName  ?? null,
      shippingDate: parsed.shippingDate ?? null,
      lineItems:    Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
    };
  } catch {
    console.log('[invoice extract] parse failed, raw was:', raw);
    return { contactName: null, shippingDate: null, lineItems: [] };
  }
}

// ── Invoice modification extraction ──────────────────────────────────────────

function buildModificationExtractPrompt(data) {
  const today = new Date().toISOString().slice(0, 10);
  const itemsSummary = data.lineItems.map((item, i) =>
    `  Item ${i + 1}: name="${item.name}", qty=${item.quantity}, price=${item.unitPrice}, tax=${item.taxRate}%`
  ).join('\n');

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
- action "confirm": user is happy as-is (e.g. "yes", "ok", "confirm", "looks good", "no changes", "create it", "done")
- action "add_item": user explicitly wants to add a new line item
- action "modify": user wants to change one or more fields
- lineItemUpdates: only include entries when a line item field should change; set unchanged fields to null
- itemIndex: use null when user doesn't specify which item (treat as first/only item)
- contactName: new name to look up only when the contact should change
- shippingDate: new service date only when it should change`;
}

async function extractModifications(text, data) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: buildModificationExtractPrompt(data),
    messages: [{ role: 'user', content: text }],
  });

  const raw = response.content[0]?.text ?? '';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { action: 'unknown' };
    const parsed = JSON.parse(match[0]);
    console.log('[modification extract]', JSON.stringify(parsed));
    return parsed;
  } catch {
    console.log('[modification extract] parse failed, raw was:', raw);
    return { action: 'unknown' };
  }
}

// ── General helpers ───────────────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.LEXOFFICE_API_KEY;
  if (!key) throw new Error('LEXOFFICE_API_KEY is not configured in .env');
  return key;
}

function apiError(err) {
  const s = err.response?.status;
  const detail = err.response?.data
    ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
    : err.message;
  if (s === 401) return '❌ Lexoffice API key is invalid or expired.';
  if (s === 406) return `❌ Lexoffice rejected the invoice (406): ${detail}`;
  if (s === 422) return `❌ Lexoffice rejected the request (422): ${detail}`;
  if (s === 429) return '⏳ Lexoffice rate limit reached — please try again in a moment.';
  if (s)         return `❌ Lexoffice error ${s}: ${detail}`;
  return `❌ Lexoffice error: ${err.message}`;
}

function resolveContactName(contact) {
  if (contact.company?.name) return contact.company.name;
  if (contact.person) {
    const { salutation, firstName, lastName } = contact.person;
    return [salutation, firstName, lastName].filter(Boolean).join(' ');
  }
  return '(unnamed)';
}

function parseTaxRate(val) {
  const clean = val.toLowerCase().replace('%', '').trim();
  if (['exempt', 'no tax', 'steuerbefreit', 'none'].includes(clean)) return 0;
  const n = parseFloat(clean);
  if ([0, 7, 19].includes(n)) return n;
  return null;
}

function parseShippingDate(str) {
  if (!str) return null;
  const s = str.trim();
  if (/^(today|heute)$/i.test(s)) return new Date();
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let date;
  if (dmy) date = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
  else if (iso) date = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
  return date && !isNaN(date.getTime()) ? date : null;
}

// ── Pending operation: cancellation guard ─────────────────────────────────────

function isCancelCommand(text) {
  return /^(cancel|stop|abort|quit|exit)\b/i.test(text.trim());
}

// ── Contact creation steps ────────────────────────────────────────────────────

async function stepContactCreate(text, jid) {
  const val = text.trim();
  const op  = pending.get(jid);

  if (op.step === 'await_name') {
    op.data.name = val;
    op.step      = 'await_email';
    pending.set(jid, op);
    return `📧 What is the email address for *${val}*? (type *skip* to omit)`;
  }

  if (op.step === 'await_email') {
    op.data.email = /^skip$/i.test(val) ? null : val;
    op.step       = 'await_phone';
    pending.set(jid, op);
    return `📞 What is the phone number? (type *skip* to omit)`;
  }

  if (op.step === 'await_phone') {
    op.data.phone = /^skip$/i.test(val) ? null : val;
    pending.delete(jid);

    const created = await contacts.createContact(getApiKey(), op.data);
    return `✅ *Contact created*\n👤 ${op.data.name}\n🆔 ID: ${created.id}`;
  }
}

// ── Invoice creation: state machine ──────────────────────────────────────────
//
// data shape:
//   contactId          string | null
//   contactName        string | null
//   shippingDate       Date   | null
//   lineItems          CompletedItem[]
//   pendingItem        PartialItem | null   — item currently being collected
//   builtInteractively boolean             — true once we asked any item question
//
// pendingItem field meanings:
//   name        null = not yet provided
//   description undefined = not yet asked  /  null = skipped  /  string = provided
//   quantity    null = not yet provided
//   unitPrice   null = not yet provided
//   taxRate     null = not yet provided

/**
 * Return the next step name given the current data state.
 * May return the internal signals 'finalize_item' or 'start_item' —
 * these are handled by advanceInvoiceStep, never stored as op.step.
 */
function computeNextInvoiceStep(data) {
  if (!data.contactId)    return 'await_contact';
  if (!data.shippingDate) return 'await_shipping_date';

  const p = data.pendingItem;
  if (p !== null) {
    if (p.name == null)          return 'await_item_name';
    if (p.description === undefined) return 'await_item_description';
    if (p.quantity == null)      return 'await_quantity';
    if (p.unitPrice == null)     return 'await_price';
    if (p.taxRate == null)       return 'await_tax';
    return 'finalize_item';
  }

  if (data.lineItems.length === 0) return 'start_item';

  // All items collected — only ask "more items?" when the user built them interactively.
  // Either way, always land on await_additions so the user sees the summary and can
  // add more items or confirm before the invoice is created.
  return data.builtInteractively ? 'await_more_items' : 'await_additions';
}

/**
 * Advance op to the next real step, resolving any internal transitions.
 * Mutates op.step and op.data. Returns the resulting step name.
 */
function advanceInvoiceStep(op) {
  let next = computeNextInvoiceStep(op.data);

  while (next === 'finalize_item' || next === 'start_item') {
    if (next === 'finalize_item') {
      op.data.lineItems.push({ ...op.data.pendingItem });
      op.data.pendingItem = null;
    } else {
      op.data.pendingItem        = { name: null, description: undefined, quantity: null, unitPrice: null, taxRate: null };
      op.data.builtInteractively = true;
    }
    next = computeNextInvoiceStep(op.data);
  }

  op.step = next;
  return next;
}

/** Build the WhatsApp prompt message for a given invoice wizard step. */
function invoiceStepPrompt(step, data) {
  const itemNum  = data.lineItems.length + 1;
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
      return invoices.formatInvoiceSummary(data)
        + '\n\n─────────────────\n'
        + 'Anything to add or change?\n'
        + 'Reply *confirm* to create · *add item* for another line item · *cancel* to abort';
    default:
      return '⚠️ Something went wrong.';
  }
}

// ── Invoice creation steps ────────────────────────────────────────────────────

async function stepInvoiceCreate(text, jid, sendProgress) {
  const val    = text.trim();
  const op     = pending.get(jid);
  const apiKey = getApiKey();
  const step   = op.step;

  // ── Process the answer for the current step ──────────────────────────────

  if (step === 'await_contact') {
    await sendProgress(`🔍 Looking up *${val}* in Lexoffice...`);
    const contact = await contacts.findContact(apiKey, val);
    if (!contact) {
      return `🔍 No contact found for *"${val}"*. Please try a different name or type *cancel* to stop.`;
    }
    op.data.contactId   = contact.id;
    op.data.contactName = resolveContactName(contact);
  }

  else if (step === 'await_shipping_date') {
    const date = parseShippingDate(val);
    if (!date) return `⚠️ Please enter a valid date — type *today*, *05.04.2026*, or *2026-04-05*.`;
    op.data.shippingDate = date;
  }

  else if (step === 'await_item_name') {
    op.data.pendingItem.name = val;
    op.data.builtInteractively = true;
  }

  else if (step === 'await_item_description') {
    op.data.pendingItem.description = /^skip$/i.test(val) ? null : val;
  }

  else if (step === 'await_quantity') {
    const qty = parseFloat(val.replace(',', '.'));
    if (isNaN(qty) || qty <= 0) return `⚠️ Please enter a valid positive number for the quantity.`;
    op.data.pendingItem.quantity = qty;
  }

  else if (step === 'await_price') {
    const price = parseFloat(val.replace(',', '.'));
    if (isNaN(price) || price <= 0) return `⚠️ Please enter a valid positive number for the price.`;
    op.data.pendingItem.unitPrice = price;
  }

  else if (step === 'await_tax') {
    const taxRate = parseTaxRate(val);
    if (taxRate === null) return `⚠️ Please reply with *0*, *7*, *19*, or *exempt*.`;
    op.data.pendingItem.taxRate = taxRate;
  }

  else if (step === 'await_more_items') {
    if (/^(yes|y|ja|yeah|yep)\b/i.test(val)) {
      op.data.pendingItem        = { name: null, description: undefined, quantity: null, unitPrice: null, taxRate: null };
      op.data.builtInteractively = true;
      op.step = 'await_item_name';
      pending.set(jid, op);
      return invoiceStepPrompt('await_item_name', op.data);
    }
    // "no" — show summary and let user confirm or add more
    op.step = 'await_additions';
    pending.set(jid, op);
    return invoiceStepPrompt('await_additions', op.data);
  }

  else if (step === 'await_additions') {
    await sendProgress('🤖 Processing your request...');
    const mod = await extractModifications(val, op.data);

    if (mod.action === 'add_item') {
      op.data.pendingItem        = { name: null, description: undefined, quantity: null, unitPrice: null, taxRate: null };
      op.data.builtInteractively = true;
      op.step = 'await_item_name';
      pending.set(jid, op);
      return invoiceStepPrompt('await_item_name', op.data);
    }

    if (mod.action === 'confirm') {
      await sendProgress('🔄 Creating draft invoice in Lexoffice...');
      const invoice = await invoices.createInvoice(apiKey, op.data);
      pending.delete(jid);
      return invoices.formatCreatedInvoice(invoice);
    }

    if (mod.action === 'modify') {
      const errors = [];

      // Contact change — requires Lexoffice lookup
      if (mod.contactName) {
        await sendProgress(`🔍 Looking up *${mod.contactName}* in Lexoffice...`);
        const contact = await contacts.findContact(apiKey, mod.contactName);
        if (!contact) {
          errors.push(`❌ No contact found for *"${mod.contactName}"*. Please try a different name.`);
        } else {
          op.data.contactId   = contact.id;
          op.data.contactName = resolveContactName(contact);
        }
      }

      // Service date change
      if (mod.shippingDate) {
        const date = parseShippingDate(mod.shippingDate);
        if (date) op.data.shippingDate = date;
      }

      // Line item field updates
      if (Array.isArray(mod.lineItemUpdates)) {
        for (const update of mod.lineItemUpdates) {
          const idx = update.itemIndex != null ? update.itemIndex : 0;
          const item = op.data.lineItems[idx];
          if (!item) continue;
          if (update.name        != null) item.name        = update.name;
          if (update.description != null) item.description = update.description;
          if (update.quantity    != null) item.quantity    = update.quantity;
          if (update.unitPrice   != null) item.unitPrice   = update.unitPrice;
          if (update.taxRate     != null) item.taxRate     = update.taxRate;
        }
      }

      pending.set(jid, op);
      const errorPrefix = errors.length ? errors.join('\n') + '\n\n' : '';
      return errorPrefix + invoiceStepPrompt('await_additions', op.data);
    }

    // Unrecognised — re-show the prompt
    return invoiceStepPrompt('await_additions', op.data);
  }

  // ── Advance to the next missing field ────────────────────────────────────
  const nextStep = advanceInvoiceStep(op);
  pending.set(jid, op);
  return invoiceStepPrompt(nextStep, op.data);
}

// ── Pending dispatcher ────────────────────────────────────────────────────────

async function continuePending(text, jid, sendProgress) {
  if (isCancelCommand(text)) {
    pending.delete(jid);
    return '❎ Operation cancelled.';
  }

  const op = pending.get(jid);
  try {
    if (op.type === 'contact_create') return await stepContactCreate(text, jid);
    if (op.type === 'invoice_create') return await stepInvoiceCreate(text, jid, sendProgress);
  } catch (err) {
    pending.delete(jid);
    return apiError(err);
  }

  pending.delete(jid);
  return '⚠️ Something went wrong. The operation has been cancelled.';
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleContactFind(entities, sendProgress) {
  if (!entities.contactName) return `🔍 What is the name of the contact you're looking for?`;
  await sendProgress(`🔍 Looking up *${entities.contactName}* in Lexoffice...`);
  const contact = await contacts.findContact(getApiKey(), entities.contactName);
  if (!contact) return `🔍 No contact found for *"${entities.contactName}"* in Lexoffice.`;
  return contacts.formatContactDetails(contact);
}

async function handleContactExists(entities, sendProgress) {
  if (!entities.contactName) return `🔍 Which contact would you like to check?`;
  await sendProgress(`🔍 Checking Lexoffice for *${entities.contactName}*...`);
  const exists = await contacts.contactExists(getApiKey(), entities.contactName);
  return exists
    ? `✅ *${entities.contactName}* is in your Lexoffice contacts.`
    : `❌ *${entities.contactName}* was not found in your Lexoffice contacts.`;
}

async function handleContactCreate(entities, jid) {
  if (entities.contactName) {
    pending.set(jid, { type: 'contact_create', step: 'await_email', data: { name: entities.contactName } });
    return `📧 What is the email address for *${entities.contactName}*? (type *skip* to omit)`;
  }
  pending.set(jid, { type: 'contact_create', step: 'await_name', data: {} });
  return `👤 What is the name of the new contact (company or person)?`;
}

async function handleInvoiceSearch(entities, sendProgress) {
  const apiKey      = getApiKey();
  const status      = invoices.normaliseStatus(entities.invoiceStatus);
  const statusLabel = entities.invoiceStatus ?? null;

  if (entities.contactName) {
    await sendProgress(`🔍 Looking up *${entities.contactName}*...`);
    const contact = await contacts.findContact(apiKey, entities.contactName);
    if (!contact) return `🔍 No contact found for *"${entities.contactName}"*. Cannot filter invoices.`;
    const name = resolveContactName(contact);
    await sendProgress(`📄 Fetching invoices for *${name}*...`);
    const result = await invoices.searchInvoices(apiKey, { status, contactId: contact.id });
    return invoices.formatInvoiceList(result, { statusLabel, contactLabel: name });
  }

  await sendProgress(`📄 Fetching${statusLabel ? ` *${statusLabel}*` : ''} invoices...`);
  const result = await invoices.searchInvoices(apiKey, { status });
  return invoices.formatInvoiceList(result, { statusLabel });
}

async function handleInvoiceCreate(text, jid, sendProgress) {
  const apiKey = getApiKey();

  // ── Extract all possible invoice details from the original message ────────
  await sendProgress('🤖 Analysing your request...');
  const extracted = await extractInvoiceDetails(text);

  // ── Build initial data state from extraction ──────────────────────────────
  // Complete items go directly into lineItems; the first incomplete item
  // (if any) becomes pendingItem so we can ask for the missing fields.
  const data = {
    contactId:          null,
    contactName:        null,
    shippingDate:       parseShippingDate(extracted.shippingDate),
    lineItems:          [],
    pendingItem:        null,
    builtInteractively: false,
  };

  for (const item of extracted.lineItems) {
    const complete = item.name && item.quantity != null && item.unitPrice != null && item.taxRate != null;
    if (complete) {
      data.lineItems.push({
        name:        item.name,
        description: item.description ?? null,
        quantity:    item.quantity,
        unitPrice:   item.unitPrice,
        taxRate:     item.taxRate,
      });
    } else if (!data.pendingItem) {
      data.pendingItem = {
        name:        item.name        ?? null,
        // undefined = not yet asked; if extraction gave a value, mark it as answered
        description: item.description != null ? item.description : undefined,
        quantity:    item.quantity    ?? null,
        unitPrice:   item.unitPrice   ?? null,
        taxRate:     item.taxRate     ?? null,
      };
    }
  }

  // ── Resolve contact ───────────────────────────────────────────────────────
  const contactName = extracted.contactName;
  if (contactName) {
    await sendProgress(`🔍 Looking up *${contactName}* in Lexoffice...`);
    const contact = await contacts.findContact(apiKey, contactName);
    if (contact) {
      data.contactId   = contact.id;
      data.contactName = resolveContactName(contact);
    } else {
      const op = { type: 'invoice_create', step: 'await_contact', data };
      pending.set(jid, op);
      return `🔍 No contact found for *"${contactName}"*.\n\nPlease enter the correct contact name:`;
    }
  }

  // ── Determine first missing field and start the wizard ───────────────────
  const op = { type: 'invoice_create', step: null, data };
  const firstStep = advanceInvoiceStep(op);
  pending.set(jid, op);
  return invoiceStepPrompt(firstStep, data);
}

// ── Main public entry point ───────────────────────────────────────────────────

async function handleMessage(text, jid, sendProgress = async () => {}) {
  if (pending.has(jid)) {
    return await continuePending(text, jid, sendProgress);
  }

  try {
    const { intent, entities } = await detectIntent(text);
    if (intent === 'contact_find')   return await handleContactFind(entities, sendProgress);
    if (intent === 'contact_exists') return await handleContactExists(entities, sendProgress);
    if (intent === 'contact_create') return await handleContactCreate(entities, jid);
    if (intent === 'invoice_search') return await handleInvoiceSearch(entities, sendProgress);
    if (intent === 'invoice_create') return await handleInvoiceCreate(text, jid, sendProgress);
  } catch (err) {
    pending.delete(jid);
    if (err.message?.startsWith('LEXOFFICE_API_KEY')) return `⚠️ ${err.message}`;
    return apiError(err);
  }

  return null; // Not a lexoffice query — fall through to keyword replies in server.js
}

module.exports = { handleMessage };
