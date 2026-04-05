const { createClient } = require('./client');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a Date as ISO 8601 with local timezone offset — required by Lexoffice (rejects bare 'Z'). */
function toIsoOffset(date) {
  const off  = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh   = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm   = String(Math.abs(off) % 60).padStart(2, '0');
  return date.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Search invoices — single API call.
 * @param {string} apiKey
 * @param {{ status?: string|null, contactId?: string|null }} params
 */
async function searchInvoices(apiKey, { status = null, contactId = null } = {}) {
  const http  = createClient(apiKey);
  const query = { voucherType: 'invoice', page: 0, size: 25 };
  if (status)    query.voucherStatus = status;
  if (contactId) query.contactId     = contactId;

  const { data } = await http.get('/voucherlist', { params: query });
  return data;
}

/**
 * Create a draft invoice — single API call.
 * @param {string} apiKey
 * @param {{ contactId: string, lineItems: LineItem[], shippingDate: Date }} params
 *
 * LineItem shape: { description, quantity, unitPrice, taxRate }
 */
async function createInvoice(apiKey, { contactId, lineItems, shippingDate }) {
  const http = createClient(apiKey);

  const allExempt = lineItems.every(i => i.taxRate === 0);

  const body = {
    voucherDate: toIsoOffset(new Date()),
    address: { contactId },
    lineItems: lineItems.map(item => ({
      type: 'custom',
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      quantity: Number(item.quantity),
      unitName: 'Stück',
      unitPrice: {
        currency: 'EUR',
        netAmount: Number(item.unitPrice),
        taxRatePercentage: item.taxRate,
      },
      discountPercentage: 0,
    })),
    totalPrice: { currency: 'EUR' },
    taxConditions: { taxType: allExempt ? 'vatfree' : 'net' },
    shippingConditions: {
      shippingDate: toIsoOffset(shippingDate),
      shippingType: 'service',
    },
    // paymentConditions omitted — must match a label saved in the Lexoffice account
  };

  const { data } = await http.post('/invoices', body);
  return data;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a voucherlist result for WhatsApp.
 */
function formatInvoiceList(result, { statusLabel = null, contactLabel = null } = {}) {
  const vouchers = result.content ?? [];

  if (!vouchers.length) {
    const who  = contactLabel ? ` for *${contactLabel}*` : '';
    const what = statusLabel  ? ` *${statusLabel}*`       : '';
    return `📄 No${what} invoices found${who}.`;
  }

  const who   = contactLabel ? ` for *${contactLabel}*`      : '';
  const what  = statusLabel  ? ` *${statusLabel}*`            : '';
  const total = result.totalElements ?? vouchers.length;
  const note  = total > vouchers.length ? ` (first ${vouchers.length} of ${total})` : '';

  const lines = [`📄 *Invoices${what}${who}* — ${total} total${note}\n`];

  vouchers.forEach((v, i) => {
    const date    = fmtDate(v.voucherDate);
    const due     = v.dueDate         ? ` · due ${fmtDate(v.dueDate)}`         : '';
    const amount  = v.totalAmount != null ? ` · ${v.currency ?? 'EUR'} ${v.totalAmount.toFixed(2)}` : '';
    const status  = v.voucherStatus   ? ` [${v.voucherStatus}]`                : '';
    const contact = v.contactName     ? `_${v.contactName}_`                   : '_(no contact)_';
    lines.push(`${i + 1}. ${v.voucherNumber ?? '—'} · ${contact}${amount} · ${date}${due}${status}`);
  });

  return lines.join('\n');
}

/**
 * Build the confirmation summary shown before creating the invoice.
 * @param {{ contactName: string, lineItems: LineItem[] }} data
 */
function formatInvoiceSummary(data) {
  const lines = ['📋 *Invoice Summary*\n'];
  lines.push(`👤 *Contact:* ${data.contactName}`);
  lines.push(`📅 *Service date:* ${fmtDate(data.shippingDate.toISOString())}\n`);

  let totalNet = 0;
  let totalVat = 0;

  data.lineItems.forEach((item, i) => {
    const net      = item.quantity * item.unitPrice;
    const vat      = net * (item.taxRate / 100);
    const taxLabel = item.taxRate === 0 ? 'exempt' : `${item.taxRate}% VAT`;
    totalNet += net;
    totalVat += vat;

    lines.push(`*Item ${i + 1}:* ${item.name}`);
    if (item.description) lines.push(`  _${item.description}_`);
    lines.push(`  Qty ${item.quantity} × €${item.unitPrice.toFixed(2)} · ${taxLabel}`);
    lines.push(`  Net €${net.toFixed(2)} | VAT €${vat.toFixed(2)}\n`);
  });

  const totalGross = totalNet + totalVat;
  lines.push(`💰 *Totals*`);
  lines.push(`  Net:   €${totalNet.toFixed(2)}`);
  lines.push(`  VAT:   €${totalVat.toFixed(2)}`);
  lines.push(`  *Gross: €${totalGross.toFixed(2)}*`);

  return lines.join('\n');
}

/**
 * Format the success message after an invoice is created.
 */
function formatCreatedInvoice(invoice) {
  return [
    '✅ *Draft invoice created successfully*',
    invoice.voucherNumber ? `🔢 Number: ${invoice.voucherNumber}` : '',
    `💶 Gross: EUR ${(invoice.totalPrice?.totalGrossAmount ?? 0).toFixed(2)}`,
    `📅 Date: ${fmtDate(invoice.voucherDate)}`,
    `🆔 ID: ${invoice.id}`,
  ].filter(Boolean).join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const STATUS_MAP = {
  open: 'open', outstanding: 'open', unpaid: 'open',
  overdue: 'overdue', late: 'overdue',
  paid: 'paid',
  draft: 'draft',
  cancelled: 'voided', voided: 'voided',
  all: null,
};

function normaliseStatus(raw) {
  if (!raw) return null;
  return STATUS_MAP[raw.toLowerCase().trim()] ?? 'open';
}

module.exports = {
  searchInvoices, createInvoice,
  formatInvoiceList, formatInvoiceSummary, formatCreatedInvoice,
  normaliseStatus,
};
