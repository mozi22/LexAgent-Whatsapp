const { createClient } = require('./client');

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Search for contacts by name — single API call, returns first match or null.
 */
async function findContact(apiKey, name) {
  const http = createClient(apiKey);
  const { data } = await http.get('/contacts', {
    params: { name, page: 0, size: 5 },
  });
  return data.content?.[0] ?? null;
}

/**
 * Check whether a contact exists by name — single API call.
 */
async function contactExists(apiKey, name) {
  const contact = await findContact(apiKey, name);
  return contact !== null;
}

/**
 * Create a new contact — single API call.
 * Defaults to "customer" role and company type.
 * @param {object} params
 * @param {string} params.name
 * @param {string|null} params.email
 * @param {string|null} params.phone
 */
async function createContact(apiKey, { name, email, phone }) {
  const http = createClient(apiKey);

  const body = {
    roles: { customer: {} },
    company: { name },
  };
  if (email) body.emailAddresses = { business: [email] };
  if (phone) body.phoneNumbers  = { business: [phone] };

  const { data } = await http.post('/contacts', body);
  return data;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a Lexoffice contact object into a WhatsApp message.
 */
function formatContactDetails(contact) {
  const lines = [];

  const name  = resolveName(contact);
  const roles = resolveRoles(contact);
  lines.push(`👤 *${name}*${roles ? ` — ${roles}` : ''}`);

  if (contact.roles?.customer?.number != null) lines.push(`🔢 Customer #: ${contact.roles.customer.number}`);
  if (contact.roles?.vendor?.number   != null) lines.push(`🔢 Vendor #: ${contact.roles.vendor.number}`);

  const emails = [
    ...(contact.emailAddresses?.business ?? []),
    ...(contact.emailAddresses?.office   ?? []),
    ...(contact.emailAddresses?.private  ?? []),
    ...(contact.emailAddresses?.other    ?? []),
  ];
  emails.forEach(e => lines.push(`📧 ${e}`));

  const phones = [
    ...(contact.phoneNumbers?.business ?? []),
    ...(contact.phoneNumbers?.office   ?? []),
    ...(contact.phoneNumbers?.mobile   ?? []),
    ...(contact.phoneNumbers?.private  ?? []),
    ...(contact.phoneNumbers?.fax      ?? []),
    ...(contact.phoneNumbers?.other    ?? []),
  ];
  phones.forEach(p => lines.push(`📞 ${p}`));

  const addr = contact.addresses?.billing?.[0] ?? contact.addresses?.shipping?.[0];
  if (addr) {
    const parts = [addr.street, addr.zip, addr.city, addr.countryCode].filter(Boolean);
    if (parts.length) lines.push(`📍 ${parts.join(', ')}`);
  }

  if (contact.note) lines.push(`📝 ${contact.note}`);

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveName(contact) {
  if (contact.company?.name) return contact.company.name;
  if (contact.person) {
    const { salutation, firstName, lastName } = contact.person;
    return [salutation, firstName, lastName].filter(Boolean).join(' ');
  }
  return '(unnamed)';
}

function resolveRoles(contact) {
  const roles = [];
  if (contact.roles?.customer) roles.push('customer');
  if (contact.roles?.vendor)   roles.push('vendor');
  return roles.join(', ');
}

module.exports = { findContact, contactExists, createContact, formatContactDetails };
