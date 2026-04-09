import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import type { AxiosError } from 'axios';
import type { SendProgress } from '../types';
import { detectIntent } from './intent';
import {
  findContact,
  contactExists,
  createContact,
  formatContactDetails,
  resolveName,
} from './contacts';
import {
  searchInvoices,
  createInvoice,
  formatInvoiceList,
  formatInvoiceSummary,
  formatCreatedInvoice,
  normaliseStatus,
} from './invoices';
import type {
  LexofficeContact,
  IntentEntities,
  PendingOperation,
  PendingContactCreate,
  PendingInvoiceCreate,
  InvoiceWizardData,
  InvoiceWizardStep,
  InvoiceInternalTransition,
  CompletedLineItem,
  PendingLineItem,
  TaxRate,
  ExtractedInvoiceDetails,
  ExtractedModification,
} from './types';

// ── Claude client for extraction prompts ──────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Per-JID pending operation state ──────────────────────────────────────────

// Keyed by sender JID — each user has their own isolated wizard state.
// Number A's pending operations are completely separate from Number B's.
const pending = new Map<string, PendingOperation>();

// ── API key helper ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.LEXOFFICE_API_KEY;
  if (!key) throw new Error('LEXOFFICE_API_KEY is not configured in .env');
  return key;
}

// ── Error formatting ──────────────────────────────────────────────────────────

function formatApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<unknown>;
    const status = axiosErr.response?.status;
    const data = axiosErr.response?.data;
    const detail = data
      ? typeof data === 'string'
        ? data
        : JSON.stringify(data)
      : axiosErr.message;
    if (status === 401) return '❌ Lexoffice API key is invalid or expired.';
    if (status === 406) return `❌ Lexoffice rejected the invoice (406): ${detail}`;
    if (status === 422) return `❌ Lexoffice rejected the request (422): ${detail}`;
    if (status === 429) return '⏳ Lexoffice rate limit reached — please try again in a moment.';
    if (status) return `❌ Lexoffice error ${status}: ${detail}`;
    return `❌ Lexoffice error: ${axiosErr.message}`;
  }
  if (err instanceof Error) return `❌ Error: ${err.message}`;
  return '❌ An unexpected error occurred.';
}

// ── Invoice detail extraction ─────────────────────────────────────────────────

function buildInvoiceExtractPrompt(): string {
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

async function extractInvoiceDetails(text: string): Promise<ExtractedInvoiceDetails> {
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
    if (!match) return { contactName: null, shippingDate: null, lineItems: [] };
    const parsed = JSON.parse(match[0]) as ExtractedInvoiceDetails;
    console.log('[invoice extract]', JSON.stringify(parsed));
    return {
      contactName: parsed.contactName ?? null,
      shippingDate: parsed.shippingDate ?? null,
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
    };
  } catch {
    console.log('[invoice extract] JSON parse failed. Raw response:', raw);
    return { contactName: null, shippingDate: null, lineItems: [] };
  }
}

// ── Invoice modification extraction ──────────────────────────────────────────

function buildModificationExtractPrompt(data: InvoiceWizardData): string {
  const today = new Date().toISOString().slice(0, 10);
  const itemsSummary = data.lineItems
    .map(
      (item, i) =>
        `  Item ${i + 1}: name="${item.name}", qty=${item.quantity}, price=${item.unitPrice}, tax=${item.taxRate}%`,
    )
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

async function extractModifications(
  text: string,
  data: InvoiceWizardData,
): Promise<ExtractedModification> {
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
    if (!match) return { action: 'unknown' };
    const parsed = JSON.parse(match[0]) as ExtractedModification;
    console.log('[modification extract]', JSON.stringify(parsed));
    return parsed;
  } catch {
    console.log('[modification extract] JSON parse failed. Raw response:', raw);
    return { action: 'unknown' };
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function isCancelCommand(text: string): boolean {
  return /^(cancel|stop|abort|quit|exit)\b/i.test(text.trim());
}

function parseTaxRate(val: string): TaxRate | null {
  const clean = val.toLowerCase().replace('%', '').trim();
  if (['exempt', 'no tax', 'steuerbefreit', 'none'].includes(clean)) return 0;
  const n = parseFloat(clean);
  if (n === 0 || n === 7 || n === 19) return n as TaxRate;
  return null;
}

function parseShippingDate(str: string | null | undefined): Date | null {
  if (!str) return null;
  const s = str.trim();
  if (/^(today|heute)$/i.test(s)) return new Date();

  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  let date: Date | undefined;
  if (dmy) {
    date = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
  } else if (iso) {
    date = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
  }
  return date && !isNaN(date.getTime()) ? date : null;
}

// ── Invoice wizard: step computation ─────────────────────────────────────────

type InvoiceStepOrTransition = InvoiceWizardStep | InvoiceInternalTransition;

/**
 * Determine the next step given the current wizard data.
 * May return internal transition signals ('finalize_item', 'start_item')
 * which are resolved by advanceInvoiceStep and never stored.
 */
function computeNextInvoiceStep(data: InvoiceWizardData): InvoiceStepOrTransition {
  if (!data.contactId) return 'await_contact';
  if (!data.shippingDate) return 'await_shipping_date';

  const p = data.pendingItem;
  if (p !== null) {
    if (p.name == null) return 'await_item_name';
    if (p.description === undefined) return 'await_item_description';
    if (p.quantity == null) return 'await_quantity';
    if (p.unitPrice == null) return 'await_price';
    if (p.taxRate == null) return 'await_tax';
    return 'finalize_item';
  }

  if (data.lineItems.length === 0) return 'start_item';

  return data.builtInteractively ? 'await_more_items' : 'await_additions';
}

/**
 * Advance the operation to the next real wizard step, resolving any internal
 * transitions (finalize_item, start_item). Mutates op in place.
 */
function advanceInvoiceStep(op: PendingInvoiceCreate): InvoiceWizardStep {
  let next = computeNextInvoiceStep(op.data);

  while (next === 'finalize_item' || next === 'start_item') {
    if (next === 'finalize_item') {
      // pendingItem is guaranteed non-null when we reach finalize_item
      op.data.lineItems.push({ ...(op.data.pendingItem as CompletedLineItem) });
      op.data.pendingItem = null;
    } else {
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

  op.step = next as InvoiceWizardStep;
  return op.step;
}

/** Build the WhatsApp prompt for a given invoice wizard step. */
function invoiceStepPrompt(step: InvoiceWizardStep, data: InvoiceWizardData): string {
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
      return (
        formatInvoiceSummary(data) +
        '\n\n─────────────────\n' +
        'Anything to add or change?\n' +
        'Reply *confirm* to create · *add item* for another line item · *cancel* to abort'
      );
  }
}

// ── Contact creation wizard ───────────────────────────────────────────────────

async function stepContactCreate(
  text: string,
  jid: string,
): Promise<string> {
  const val = text.trim();
  const op = pending.get(jid) as PendingContactCreate;

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
  const created = await createContact(getApiKey(), { name, email: op.data.email, phone: op.data.phone });
  return `✅ *Contact created*\n👤 ${name}\n🆔 ID: ${created.id}`;
}

// ── Invoice creation wizard ───────────────────────────────────────────────────

async function stepInvoiceCreate(
  text: string,
  jid: string,
  sendProgress: SendProgress,
): Promise<string> {
  const val = text.trim();
  const op = pending.get(jid) as PendingInvoiceCreate;
  const apiKey = getApiKey();

  // ── Process the user's answer for the current step ───────────────────────

  switch (op.step) {
    case 'await_contact': {
      await sendProgress(`🔍 Looking up *${val}* in Lexoffice...`);
      const contact = await findContact(apiKey, val);
      if (!contact) {
        return `🔍 No contact found for *"${val}"*. Please try a different name or type *cancel* to stop.`;
      }
      op.data.contactId = contact.id;
      op.data.contactName = resolveName(contact);
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
      if (!op.data.pendingItem) throw new Error('Expected pendingItem to exist at await_item_name');
      op.data.pendingItem.name = val;
      op.data.builtInteractively = true;
      break;
    }

    case 'await_item_description': {
      if (!op.data.pendingItem) throw new Error('Expected pendingItem to exist at await_item_description');
      op.data.pendingItem.description = /^skip$/i.test(val) ? null : val;
      break;
    }

    case 'await_quantity': {
      if (!op.data.pendingItem) throw new Error('Expected pendingItem to exist at await_quantity');
      const qty = parseFloat(val.replace(',', '.'));
      if (isNaN(qty) || qty <= 0) {
        return `⚠️ Please enter a valid positive number for the quantity.`;
      }
      op.data.pendingItem.quantity = qty;
      break;
    }

    case 'await_price': {
      if (!op.data.pendingItem) throw new Error('Expected pendingItem to exist at await_price');
      const price = parseFloat(val.replace(',', '.'));
      if (isNaN(price) || price <= 0) {
        return `⚠️ Please enter a valid positive number for the price.`;
      }
      op.data.pendingItem.unitPrice = price;
      break;
    }

    case 'await_tax': {
      if (!op.data.pendingItem) throw new Error('Expected pendingItem to exist at await_tax');
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
        const invoice = await createInvoice(apiKey, {
          contactId: op.data.contactId!,
          lineItems: op.data.lineItems,
          shippingDate: op.data.shippingDate!,
        });
        pending.delete(jid);
        return formatCreatedInvoice(invoice);
      }

      if (mod.action === 'modify') {
        const errors: string[] = [];

        if (mod.contactName) {
          await sendProgress(`🔍 Looking up *${mod.contactName}* in Lexoffice...`);
          const contact = await findContact(apiKey, mod.contactName);
          if (!contact) {
            errors.push(`❌ No contact found for *"${mod.contactName}"*. Please try a different name.`);
          } else {
            op.data.contactId = contact.id;
            op.data.contactName = resolveName(contact);
          }
        }

        if (mod.shippingDate) {
          const date = parseShippingDate(mod.shippingDate);
          if (date) op.data.shippingDate = date;
        }

        if (Array.isArray(mod.lineItemUpdates)) {
          for (const update of mod.lineItemUpdates) {
            const idx = update.itemIndex ?? 0;
            const item = op.data.lineItems[idx];
            if (!item) continue;
            if (update.name != null) item.name = update.name;
            if (update.description != null) item.description = update.description;
            if (update.quantity != null) item.quantity = update.quantity;
            if (update.unitPrice != null) item.unitPrice = update.unitPrice;
            if (update.taxRate != null) item.taxRate = update.taxRate;
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

async function continuePending(
  text: string,
  jid: string,
  sendProgress: SendProgress,
): Promise<string> {
  if (isCancelCommand(text)) {
    pending.delete(jid);
    return '❎ Operation cancelled.';
  }

  const op = pending.get(jid)!;
  try {
    if (op.type === 'contact_create') return await stepContactCreate(text, jid);
    if (op.type === 'invoice_create') return await stepInvoiceCreate(text, jid, sendProgress);
  } catch (err) {
    pending.delete(jid);
    return formatApiError(err);
  }

  pending.delete(jid);
  return '⚠️ Something went wrong. The operation has been cancelled.';
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleContactFind(
  entities: IntentEntities,
  sendProgress: SendProgress,
): Promise<string> {
  if (!entities.contactName) {
    return `🔍 What is the name of the contact you're looking for?`;
  }
  await sendProgress(`🔍 Looking up *${entities.contactName}* in Lexoffice...`);
  const contact = await findContact(getApiKey(), entities.contactName);
  if (!contact) return `🔍 No contact found for *"${entities.contactName}"* in Lexoffice.`;
  return formatContactDetails(contact);
}

async function handleContactExists(
  entities: IntentEntities,
  sendProgress: SendProgress,
): Promise<string> {
  if (!entities.contactName) return `🔍 Which contact would you like to check?`;
  await sendProgress(`🔍 Checking Lexoffice for *${entities.contactName}*...`);
  const exists = await contactExists(getApiKey(), entities.contactName);
  return exists
    ? `✅ *${entities.contactName}* is in your Lexoffice contacts.`
    : `❌ *${entities.contactName}* was not found in your Lexoffice contacts.`;
}

async function handleContactCreate(
  entities: IntentEntities,
  jid: string,
): Promise<string> {
  if (entities.contactName) {
    const op: PendingContactCreate = {
      type: 'contact_create',
      step: 'await_email',
      data: { name: entities.contactName },
    };
    pending.set(jid, op);
    return `📧 What is the email address for *${entities.contactName}*? (type *skip* to omit)`;
  }
  const op: PendingContactCreate = {
    type: 'contact_create',
    step: 'await_name',
    data: {},
  };
  pending.set(jid, op);
  return `👤 What is the name of the new contact (company or person)?`;
}

async function handleInvoiceSearch(
  entities: IntentEntities,
  sendProgress: SendProgress,
): Promise<string> {
  const apiKey = getApiKey();
  const status = normaliseStatus(entities.invoiceStatus);
  const statusLabel = entities.invoiceStatus ?? null;

  if (entities.contactName) {
    await sendProgress(`🔍 Looking up *${entities.contactName}*...`);
    const contact: LexofficeContact | null = await findContact(apiKey, entities.contactName);
    if (!contact) {
      return `🔍 No contact found for *"${entities.contactName}"*. Cannot filter invoices.`;
    }
    const name = resolveName(contact);
    await sendProgress(`📄 Fetching invoices for *${name}*...`);
    const result = await searchInvoices(apiKey, { status, contactId: contact.id });
    return formatInvoiceList(result, { statusLabel, contactLabel: name });
  }

  await sendProgress(`📄 Fetching${statusLabel ? ` *${statusLabel}*` : ''} invoices...`);
  const result = await searchInvoices(apiKey, { status });
  return formatInvoiceList(result, { statusLabel });
}

async function handleInvoiceCreate(
  text: string,
  jid: string,
  sendProgress: SendProgress,
): Promise<string> {
  const apiKey = getApiKey();

  await sendProgress('🤖 Analysing your request...');
  const extracted = await extractInvoiceDetails(text);

  const data: InvoiceWizardData = {
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
    const isComplete =
      item.name != null &&
      item.quantity != null &&
      item.unitPrice != null &&
      item.taxRate != null;

    if (isComplete) {
      data.lineItems.push({
        name: item.name!,
        description: item.description ?? null,
        quantity: item.quantity!,
        unitPrice: item.unitPrice!,
        taxRate: item.taxRate!,
      });
    } else if (!data.pendingItem) {
      const pendingItem: PendingLineItem = {
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
    const contact = await findContact(apiKey, extracted.contactName);
    if (contact) {
      data.contactId = contact.id;
      data.contactName = resolveName(contact);
    } else {
      const op: PendingInvoiceCreate = {
        type: 'invoice_create',
        step: 'await_contact',
        data,
      };
      pending.set(jid, op);
      return `🔍 No contact found for *"${extracted.contactName}"*.\n\nPlease enter the correct contact name:`;
    }
  }

  const op: PendingInvoiceCreate = {
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
export async function handleMessage(
  text: string,
  jid: string,
  sendProgress: SendProgress = async () => { /* no-op */ },
): Promise<string | null> {
  if (pending.has(jid)) {
    return continuePending(text, jid, sendProgress);
  }

  try {
    const { intent, entities } = await detectIntent(text);

    if (intent === 'contact_find') return handleContactFind(entities, sendProgress);
    if (intent === 'contact_exists') return handleContactExists(entities, sendProgress);
    if (intent === 'contact_create') return handleContactCreate(entities, jid);
    if (intent === 'invoice_search') return handleInvoiceSearch(entities, sendProgress);
    if (intent === 'invoice_create') return handleInvoiceCreate(text, jid, sendProgress);
  } catch (err) {
    pending.delete(jid);
    if (err instanceof Error && err.message.startsWith('LEXOFFICE_API_KEY')) {
      return `⚠️ ${err.message}`;
    }
    return formatApiError(err);
  }

  return null; // Not a Lexoffice query — fall through to keyword replies
}
