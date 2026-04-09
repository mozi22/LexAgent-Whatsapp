import Anthropic from '@anthropic-ai/sdk';
import type { IntentResult, IntentEntities, SupportedIntent } from './types';

// Claude Haiku is used intentionally here: intent classification runs on every
// incoming WhatsApp message, so latency and cost matter more than raw reasoning.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

const SUPPORTED_INTENTS = new Set<string>([
  'contact_find',
  'contact_exists',
  'contact_create',
  'invoice_search',
  'invoice_create',
]);

const EMPTY_ENTITIES: IntentEntities = {
  intent: 'unknown',
  contactName: null,
  invoiceStatus: null,
};

/**
 * Use Claude Haiku to extract the intent and entities from a free-form message.
 * Returns `intent: null` for anything that is not a Lexoffice query.
 */
export async function detectIntent(text: string): Promise<IntentResult> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 128,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const firstBlock = response.content[0];
  const raw = firstBlock?.type === 'text' ? firstBlock.text : '';

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.log('[intent] no JSON found in response:', raw);
      return { intent: null, entities: EMPTY_ENTITIES };
    }

    const parsed = JSON.parse(match[0]) as IntentEntities;
    const rawIntent = parsed.intent;
    const intent: SupportedIntent | null = SUPPORTED_INTENTS.has(rawIntent)
      ? (rawIntent as SupportedIntent)
      : null;

    console.log('[intent]', JSON.stringify(text), '→', intent ?? 'unknown');
    return { intent, entities: parsed };
  } catch {
    console.log('[intent] JSON parse failed. Raw response:', raw);
    return { intent: null, entities: EMPTY_ENTITIES };
  }
}
