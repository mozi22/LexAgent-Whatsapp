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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Invoice creation steps ────────────────────────────────────────────────────

async function stepInvoiceCreate(text, jid, sendProgress) {
  const val    = text.trim();
  const op     = pending.get(jid);
  const apiKey = getApiKey();

  // ── Resolve contact ──────────────────────────────────────────────────────
  if (op.step === 'await_contact') {
    await sendProgress(`🔍 Looking up *${val}* in Lexoffice...`);
    const contact = await contacts.findContact(apiKey, val);
    if (!contact) {
      return `🔍 No contact found for *"${val}"*. Please try a different name or type *cancel* to stop.`;
    }
    op.data.contactId   = contact.id;
    op.data.contactName = resolveContactName(contact);
    op.step             = 'await_shipping_date';
    pending.set(jid, op);
    return `✅ Found *${op.data.contactName}*.\n\n📅 What is the service date?\nType *today* or enter a date (e.g. *05.04.2026*)`;
  }

  // ── Service date ─────────────────────────────────────────────────────────
  if (op.step === 'await_shipping_date') {
    let date;
    if (/^(today|heute)$/i.test(val)) {
      date = new Date();
    } else {
      const dmy = val.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      const iso = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dmy) {
        date = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
      } else if (iso) {
        date = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
      }
    }
    if (!date || isNaN(date.getTime())) {
      return `⚠️ Please enter a valid date — type *today*, *05.04.2026*, or *2026-04-05*.`;
    }
    op.data.shippingDate = date;
    op.step              = 'await_item_name';
    pending.set(jid, op);
    return `📝 What is the *name* (title) for line item 1?`;
  }

  // ── Line item fields ─────────────────────────────────────────────────────
  if (op.step === 'await_item_name') {
    op.data.currentItem = { name: val };
    op.step             = 'await_item_description';
    pending.set(jid, op);
    return `📄 Add a description for this item? (type *skip* to omit)`;
  }

  if (op.step === 'await_item_description') {
    op.data.currentItem.description = /^skip$/i.test(val) ? null : val;
    op.step = 'await_quantity';
    pending.set(jid, op);
    return `🔢 What is the quantity for this item?`;
  }

  if (op.step === 'await_quantity') {
    const qty = parseFloat(val.replace(',', '.'));
    if (isNaN(qty) || qty <= 0) return `⚠️ Please enter a valid positive number for the quantity.`;
    op.data.currentItem.quantity = qty;
    op.step = 'await_price';
    pending.set(jid, op);
    return `💶 What is the unit price in EUR (net, excluding tax)?`;
  }

  if (op.step === 'await_price') {
    const price = parseFloat(val.replace(',', '.'));
    if (isNaN(price) || price <= 0) return `⚠️ Please enter a valid positive number for the price.`;
    op.data.currentItem.unitPrice = price;
    op.step = 'await_tax';
    pending.set(jid, op);
    return `🏷️ What tax rate applies to this item?\nReply with *0*, *7*, *19*, or *exempt*`;
  }

  if (op.step === 'await_tax') {
    const taxRate = parseTaxRate(val);
    if (taxRate === null) return `⚠️ Please reply with *0*, *7*, *19*, or *exempt*.`;
    op.data.currentItem.taxRate = taxRate;
    op.data.lineItems.push({ ...op.data.currentItem });
    op.data.currentItem = {};
    op.step = 'await_more_items';
    pending.set(jid, op);
    const n = op.data.lineItems.length;
    return `✅ Line item ${n} added.\n\n➕ Would you like to add another line item? (*yes* / *no*)`;
  }

  // ── More items? ──────────────────────────────────────────────────────────
  if (op.step === 'await_more_items') {
    if (/^(yes|y|ja|yeah|yep)\b/i.test(val)) {
      const n = op.data.lineItems.length + 1;
      op.step = 'await_item_name';
      pending.set(jid, op);
      return `📝 What is the *name* (title) for line item ${n}?`;
    }

    // No more items — show full summary and ask for confirmation
    op.step = 'await_confirmation';
    pending.set(jid, op);
    return invoices.formatInvoiceSummary(op.data)
      + '\n\n─────────────────\nReply *confirm* to create the invoice, or *cancel* to abort.';
  }

  // ── Confirmation ─────────────────────────────────────────────────────────
  if (op.step === 'await_confirmation') {
    if (!/^(yes|confirm|ja|ok|y)\b/i.test(val)) {
      pending.delete(jid);
      return '❎ Invoice creation cancelled.';
    }
    await sendProgress('🔄 Creating draft invoice in Lexoffice...');
    const invoice = await invoices.createInvoice(apiKey, op.data);
    pending.delete(jid);
    return invoices.formatCreatedInvoice(invoice);
  }
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

async function handleInvoiceCreate(entities, jid, sendProgress) {
  const apiKey = getApiKey();

  if (entities.contactName) {
    await sendProgress(`🔍 Looking up *${entities.contactName}* in Lexoffice...`);
    const contact = await contacts.findContact(apiKey, entities.contactName);

    if (!contact) {
      // Contact not found — ask the user to re-enter the name
      pending.set(jid, { type: 'invoice_create', step: 'await_contact', data: { lineItems: [], currentItem: {} } });
      return `🔍 No contact found for *"${entities.contactName}"*.\n\nPlease enter the correct contact name:`;
    }

    const contactName = resolveContactName(contact);
    await sendProgress(`✅ Found *${contactName}*. Let's build the invoice.`);

    pending.set(jid, {
      type: 'invoice_create',
      step: 'await_shipping_date',
      data: { contactId: contact.id, contactName, lineItems: [], currentItem: {} },
    });
    return `📅 What is the service date?\nType *today* or enter a date (e.g. *05.04.2026*)`;
  }

  // No contact name provided — ask for it
  pending.set(jid, { type: 'invoice_create', step: 'await_contact', data: { lineItems: [], currentItem: {} } });
  return `🧾 For which contact should I create the invoice?`;
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
    if (intent === 'invoice_create') return await handleInvoiceCreate(entities, jid, sendProgress);
  } catch (err) {
    pending.delete(jid);
    if (err.message?.startsWith('LEXOFFICE_API_KEY')) return `⚠️ ${err.message}`;
    return apiError(err);
  }

  return null; // Not a lexoffice query — fall through to keyword replies in server.js
}

module.exports = { handleMessage };
