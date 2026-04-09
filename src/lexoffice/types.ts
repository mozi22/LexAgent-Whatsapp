// ── Lexoffice REST API response types ────────────────────────────────────────

export interface ContactPerson {
  salutation?: string;
  firstName?: string;
  lastName: string;
}

export interface ContactCompanyPerson {
  salutation?: string;
  firstName?: string;
  lastName: string;
  primary?: boolean;
  emailAddress?: string;
  phoneNumber?: string;
}

export interface ContactCompany {
  name: string;
  taxNumber?: string;
  vatRegistrationId?: string;
  allowTaxFreeInvoices?: boolean;
  contactPersons?: ContactCompanyPerson[];
}

export interface ContactRoleEntry {
  number?: number;
}

export interface ContactRoles {
  customer?: ContactRoleEntry;
  vendor?: ContactRoleEntry;
}

export interface ContactEmailAddresses {
  business?: string[];
  office?: string[];
  private?: string[];
  other?: string[];
}

export interface ContactPhoneNumbers {
  business?: string[];
  office?: string[];
  mobile?: string[];
  private?: string[];
  fax?: string[];
  other?: string[];
}

export interface ContactAddress {
  street?: string;
  zip?: string;
  city?: string;
  countryCode?: string;
}

export interface ContactAddresses {
  billing?: ContactAddress[];
  shipping?: ContactAddress[];
}

export interface LexofficeContact {
  id: string;
  version: number;
  roles: ContactRoles;
  company?: ContactCompany;
  person?: ContactPerson;
  addresses?: ContactAddresses;
  emailAddresses?: ContactEmailAddresses;
  phoneNumbers?: ContactPhoneNumbers;
  note?: string;
}

export interface LexofficeContactsPage {
  content: LexofficeContact[];
  first: boolean;
  last: boolean;
  totalPages: number;
  totalElements: number;
  numberOfElements: number;
  size: number;
  number: number;
}

export interface CreateContactParams {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface CreatedContact {
  id: string;
  resourceUri?: string;
}

export interface VoucherListItem {
  id?: string;
  voucherNumber?: string;
  voucherDate?: string;
  dueDate?: string;
  totalAmount?: number;
  currency?: string;
  voucherStatus?: string;
  contactName?: string;
  openAmount?: number;
}

export interface VoucherListPage {
  content: VoucherListItem[];
  totalElements?: number;
}

export interface CreatedInvoice {
  id: string;
  voucherNumber?: string;
  voucherDate?: string;
  totalPrice?: {
    totalGrossAmount?: number;
    totalNetAmount?: number;
    totalTaxAmount?: number;
  };
}

// ── Invoice wizard internal state ─────────────────────────────────────────────

/** Tax rates accepted by Lexoffice. */
export type TaxRate = 0 | 7 | 19;

/** A fully specified line item ready to be submitted to Lexoffice. */
export interface CompletedLineItem {
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  taxRate: TaxRate;
}

/**
 * A line item currently being collected field by field.
 * `description === undefined` means the question has not been asked yet.
 * `description === null` means the user skipped it.
 */
export interface PendingLineItem {
  name: string | null;
  description: string | null | undefined;
  quantity: number | null;
  unitPrice: number | null;
  taxRate: TaxRate | null;
}

/** All data accumulated during the invoice creation wizard. */
export interface InvoiceWizardData {
  contactId: string | null;
  contactName: string | null;
  shippingDate: Date | null;
  lineItems: CompletedLineItem[];
  pendingItem: PendingLineItem | null;
  /** True once any line item field was collected interactively. */
  builtInteractively: boolean;
}

// ── Pending multi-step operations ─────────────────────────────────────────────

export type ContactCreateStep = 'await_name' | 'await_email' | 'await_phone';

export interface ContactCreateData {
  name?: string;
  email?: string | null;
  phone?: string | null;
}

export interface PendingContactCreate {
  type: 'contact_create';
  step: ContactCreateStep;
  data: ContactCreateData;
}

export type InvoiceWizardStep =
  | 'await_contact'
  | 'await_shipping_date'
  | 'await_item_name'
  | 'await_item_description'
  | 'await_quantity'
  | 'await_price'
  | 'await_tax'
  | 'await_more_items'
  | 'await_additions';

/** Internal-only step signals resolved by advanceInvoiceStep — never stored. */
export type InvoiceInternalTransition = 'finalize_item' | 'start_item';

export interface PendingInvoiceCreate {
  type: 'invoice_create';
  step: InvoiceWizardStep;
  data: InvoiceWizardData;
}

export type PendingOperation = PendingContactCreate | PendingInvoiceCreate;

// ── Intent detection ──────────────────────────────────────────────────────────

export type SupportedIntent =
  | 'contact_find'
  | 'contact_exists'
  | 'contact_create'
  | 'invoice_search'
  | 'invoice_create';

export interface IntentEntities {
  intent: string;
  contactName: string | null;
  invoiceStatus: string | null;
}

export interface IntentResult {
  intent: SupportedIntent | null;
  entities: IntentEntities;
}

// ── Extraction types (Claude responses) ──────────────────────────────────────

export interface ExtractedLineItem {
  name: string | null;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  taxRate: TaxRate | null;
}

export interface ExtractedInvoiceDetails {
  contactName: string | null;
  shippingDate: string | null;
  lineItems: ExtractedLineItem[];
}

export type ModificationAction = 'confirm' | 'add_item' | 'modify' | 'unknown';

export interface LineItemUpdate {
  itemIndex: number | null;
  name: string | null;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  taxRate: TaxRate | null;
}

export interface ExtractedModification {
  action: ModificationAction;
  contactName?: string | null;
  shippingDate?: string | null;
  lineItemUpdates?: LineItemUpdate[];
}
