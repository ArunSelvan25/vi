/**
 * Single source of truth for every entity. Forms, tables, filters, CSV export
 * and validation are all generated from these definitions, so adding a field
 * is a one-line change here plus a column in the sheet.
 *
 * field: { key, label, type, options|optionsFrom, required, table, form, width, help }
 *   type        text | textarea | number | money | date | select | ref | email | tel | url | readonly
 *   optionsFrom name of a store collection for ref fields
 *   table       show in the list view
 *   form        show in the create/edit form (default true)
 */

export const STATUS_COLORS = {
  Active: 'ok', Occupied: 'ok', Paid: 'ok', Resolved: 'ok', Closed: 'muted', Completed: 'ok',
  Vacant: 'info', Upcoming: 'info', Draft: 'muted', Reserved: 'info', Prospect: 'info',
  Unpaid: 'warn', Partial: 'warn', 'In Progress': 'warn', 'On Hold': 'warn', 'Under Maintenance': 'warn',
  Overdue: 'danger', Terminated: 'danger', Expired: 'danger', Urgent: 'danger', High: 'danger',
  Void: 'muted', Inactive: 'muted', Past: 'muted', Sold: 'muted',
  Low: 'muted', Medium: 'info', Held: 'info', Refunded: 'ok', 'Partially Refunded': 'warn',
  Forfeited: 'muted', Transferred: 'muted', Pending: 'warn'
};

/** Utility meters that can be read and billed in bulk. */
export const METER_CATEGORIES = ['Electricity', 'Water', 'Gas'];

/** A GSTIN: 2-digit state code, PAN, entity number, Z, checksum. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Charge types available on an invoice line. */
export const ITEM_CATEGORIES = [
  'Rent', 'Electricity', 'Water', 'Gas', 'Internet', 'Parking', 'Maintenance',
  'Cleaning', 'Security', 'Property Tax', 'Late Fee', 'Deposit', 'Other'
];

export const entities = {
  properties: {
    table: 'Properties',
    title: 'Properties',
    singular: 'Property',
    icon: 'building',
    labelKey: 'name',
    search: ['name', 'city', 'address_line1', 'owner_name'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'name', label: 'Property name', type: 'text', required: true, table: true },
      { key: 'type', label: 'Type', type: 'select', table: true,
        options: ['Apartment', 'Independent House', 'Villa', 'Commercial', 'Office', 'Retail', 'Warehouse', 'Land', 'PG / Hostel'] },
      { key: 'address_line1', label: 'Address line 1', type: 'text', required: true },
      { key: 'address_line2', label: 'Address line 2', type: 'text' },
      { key: 'city', label: 'City', type: 'text', table: true },
      { key: 'state', label: 'State', type: 'text' },
      { key: 'postal_code', label: 'Postal code', type: 'text' },
      { key: 'country', label: 'Country', type: 'text' },
      { key: 'owner_name', label: 'Owner', type: 'text', table: true },
      { key: 'purchase_date', label: 'Purchase date', type: 'date' },
      { key: 'purchase_price', label: 'Purchase price', type: 'money' },
      { key: 'current_value', label: 'Current value', type: 'money', table: true },
      { key: 'status', label: 'Status', type: 'select', table: true, options: ['Active', 'Inactive', 'Sold'] },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  units: {
    table: 'Units',
    title: 'Units',
    singular: 'Unit',
    icon: 'grid',
    labelKey: 'unit_number',
    search: ['unit_number', 'amenities'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', required: true, table: true },
      { key: 'unit_number', label: 'Unit number', type: 'text', required: true, table: true },
      { key: 'floor', label: 'Floor', type: 'text' },
      { key: 'bedrooms', label: 'Bedrooms', type: 'number', table: true },
      { key: 'bathrooms', label: 'Bathrooms', type: 'number' },
      { key: 'area_sqft', label: 'Area (sq ft)', type: 'number' },
      { key: 'furnishing', label: 'Furnishing', type: 'select',
        options: ['Unfurnished', 'Semi-furnished', 'Fully furnished'] },
      { key: 'rent_amount', label: 'Market rent', type: 'money', table: true },
      { key: 'deposit_amount', label: 'Deposit', type: 'money' },
      { key: 'status', label: 'Status', type: 'select', table: true,
        options: ['Vacant', 'Occupied', 'Reserved', 'Under Maintenance'],
        help: 'Kept in sync automatically from active leases.' },
      { key: 'amenities', label: 'Amenities', type: 'text', help: 'Comma separated' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  tenants: {
    table: 'Tenants',
    title: 'Tenants',
    singular: 'Tenant',
    icon: 'users',
    labelKey: 'full_name',
    search: ['full_name', 'phone', 'email', 'id_number'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'full_name', label: 'Full name', type: 'text', required: true, table: true },
      { key: 'phone', label: 'Phone', type: 'tel', required: true, table: true },
      { key: 'email', label: 'Email (optional)', type: 'email', table: true,
        help: 'Only needed if you want this tenant to receive rent reminders by email' },
      { key: 'alt_phone', label: 'Alternate phone', type: 'tel' },
      { key: 'id_type', label: 'ID type', type: 'select',
        options: ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'Other'] },
      { key: 'id_number', label: 'ID number', type: 'text' },
      { key: 'occupation', label: 'Occupation / employer', type: 'text' },
      { key: 'emergency_name', label: 'Emergency contact', type: 'text' },
      { key: 'emergency_phone', label: 'Emergency phone', type: 'tel' },
      { key: 'status', label: 'Status', type: 'select', table: true, options: ['Active', 'Prospect', 'Past'] },
      { key: 'gstin', label: 'GSTIN (business tenants)', type: 'text', pattern: 'gstin',
        help: 'Printed on their tax invoices. Leave blank for individuals.' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  leases: {
    table: 'Leases',
    title: 'Leases',
    singular: 'Lease',
    icon: 'file',
    labelKey: 'id',
    search: ['id'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', required: true, table: true },
      { key: 'unit_id', label: 'Unit', type: 'ref', optionsFrom: 'units', required: true, table: true,
        short: true, dependsOn: 'property_id',
        help: 'A unit can only be on one live lease at a time.' },
      { key: 'tenant_id', label: 'Tenant', type: 'ref', optionsFrom: 'tenants', required: true, table: true },
      { key: 'start_date', label: 'Start date', type: 'date', required: true, table: true },
      { key: 'end_date', label: 'End date', type: 'date', table: true },
      // The backend bills rent_amount × months per period, so this must be the
      // monthly figure: labelled "per period", a quarterly rent typed in here
      // was billed three times over.
      { key: 'rent_amount', label: 'Monthly rent', type: 'money', required: true, table: true,
        help: 'Enter the rent for one month. Quarterly, half-yearly and yearly leases bill 3×, 6× or 12× this.' },
      { key: 'deposit_amount', label: 'Security deposit', type: 'money' },
      { key: 'deposit_status', label: 'Deposit status', type: 'select',
        options: ['Pending', 'Held', 'Partially Refunded', 'Refunded', 'Forfeited', 'Transferred'],
        help: 'Pending until the deposit invoice is paid, then Held. Choose Held for a deposit collected '
            + 'outside the app. At move-out use "Settle deposit", which records deductions and the refund.' },
      { key: 'frequency', label: 'Billing frequency', type: 'select',
        options: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'] },
      // billing_day is kept as a column so existing values survive, but stays
      // off the form: rent periods follow the lease start date and nothing
      // reads it. An input that does nothing is worse than no input.
      { key: 'billing_day', label: 'Billing day of month', type: 'number', form: false },
      { key: 'late_fee', label: 'Late fee', type: 'money',
        help: 'Added once as a line item when an invoice on this lease goes overdue. Leave blank for none.' },
      { key: 'grace_days', label: 'Grace days', type: 'number',
        help: 'Days after each period starts before the rent is due. Rent is billed '
            + 'from the lease start date — a lease starting on the 5th bills on the 5th.' },
      { key: 'escalation_pct', label: 'Annual escalation %', type: 'number',
        help: 'Rent increases by this % on each lease anniversary' },
      { key: 'gst_rate', label: 'GST on rent %', type: 'number',
        help: 'Usually 18 for commercial property and 0 for a home. Added to every rent invoice and late fee.' },
      { key: 'status', label: 'Status', type: 'select', table: true,
        options: ['Active', 'Upcoming', 'Expired', 'Terminated'],
        help: 'Set from the dates automatically. Choose Terminated to end a lease early.' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  invoices: {
    table: 'Invoices',
    title: 'Invoices',
    singular: 'Invoice',
    icon: 'receipt',
    labelKey: 'id',
    search: ['id', 'notes'],
    fields: [
      { key: 'id', label: 'Invoice', type: 'readonly', table: true, width: 110 },
      { key: 'tenant_id', label: 'Tenant', type: 'ref', optionsFrom: 'tenants', required: true, table: true },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', table: true },
      { key: 'unit_id', label: 'Unit', type: 'ref', optionsFrom: 'units', table: true, short: true },
      { key: 'lease_id', label: 'Lease', type: 'ref', optionsFrom: 'leases' },
      { key: 'type', label: 'Type', type: 'select', table: true,
        options: ['Rent', 'Deposit', 'Deposit Deduction', 'Electricity', 'Water', 'Gas', 'Mixed',
                  'Late Fee', 'Maintenance', 'Other'] },
      { key: 'period_start', label: 'Period start', type: 'date' },
      { key: 'period_end', label: 'Period end', type: 'date' },
      { key: 'issue_date', label: 'Issue date', type: 'date' },
      { key: 'due_date', label: 'Due date', type: 'date', required: true, table: true },
      { key: 'amount', label: 'Amount', type: 'money', form: false, table: true },
      { key: 'tax', label: 'Tax', type: 'money' },
      { key: 'total', label: 'Total', type: 'money', form: false },
      { key: 'amount_paid', label: 'Paid', type: 'money', form: false, table: true },
      { key: 'balance', label: 'Balance', type: 'money', form: false, table: true },
      { key: 'status', label: 'Status', type: 'select', table: true,
        options: ['Draft', 'Unpaid', 'Partial', 'Paid', 'Overdue', 'Void'] },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  payments: {
    table: 'Payments',
    title: 'Payments',
    singular: 'Payment',
    icon: 'card',
    labelKey: 'id',
    search: ['id', 'reference', 'method'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'payment_date', label: 'Date', type: 'date', required: true, table: true },
      { key: 'tenant_id', label: 'Tenant', type: 'ref', optionsFrom: 'tenants', table: true },
      { key: 'invoice_id', label: 'Invoice', type: 'ref', optionsFrom: 'invoices', table: true },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', table: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true, table: true },
      { key: 'method', label: 'Method', type: 'select', table: true,
        options: ['Cash', 'Bank Transfer', 'UPI', 'Card', 'Cheque', 'Deposit Adjustment', 'Other'] },
      { key: 'reference', label: 'Reference / txn no.', type: 'text', table: true },
      { key: 'received_by', label: 'Received by', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  maintenance: {
    table: 'Maintenance',
    title: 'Maintenance',
    singular: 'Ticket',
    icon: 'wrench',
    labelKey: 'title',
    search: ['title', 'description', 'vendor_name', 'category'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'title', label: 'Title', type: 'text', required: true, table: true },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', required: true, table: true },
      { key: 'unit_id', label: 'Unit', type: 'ref', optionsFrom: 'units', table: true, short: true,
        dependsOn: 'property_id' },
      { key: 'tenant_id', label: 'Reported by (tenant)', type: 'ref', optionsFrom: 'tenants' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'category', label: 'Category', type: 'select',
        options: ['Plumbing', 'Electrical', 'Appliance', 'Carpentry', 'Painting', 'Pest Control',
                  'Cleaning', 'Structural', 'Security', 'Other'] },
      { key: 'priority', label: 'Priority', type: 'select', table: true,
        options: ['Low', 'Medium', 'High', 'Urgent'] },
      { key: 'status', label: 'Status', type: 'select', table: true,
        options: ['Open', 'In Progress', 'On Hold', 'Resolved', 'Closed'] },
      { key: 'reported_date', label: 'Reported', type: 'date', table: true },
      { key: 'scheduled_date', label: 'Scheduled', type: 'date' },
      { key: 'completed_date', label: 'Completed', type: 'date' },
      { key: 'vendor_name', label: 'Vendor', type: 'text' },
      { key: 'vendor_phone', label: 'Vendor phone', type: 'tel' },
      { key: 'cost', label: 'Cost', type: 'money', table: true },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  },

  expenses: {
    table: 'Expenses',
    title: 'Expenses',
    singular: 'Expense',
    icon: 'wallet',
    labelKey: 'description',
    search: ['description', 'vendor', 'category', 'reference'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'date', label: 'Date', type: 'date', required: true, table: true },
      { key: 'property_id', label: 'Property', type: 'ref', optionsFrom: 'properties', required: true, table: true },
      { key: 'unit_id', label: 'Unit', type: 'ref', optionsFrom: 'units', dependsOn: 'property_id' },
      { key: 'category', label: 'Category', type: 'select', table: true,
        options: ['Repairs', 'Utilities', 'Property Tax', 'Insurance', 'Management Fee', 'Mortgage',
                  'Cleaning', 'Security', 'Legal', 'Deposit Refund', 'Other'] },
      { key: 'description', label: 'Description', type: 'text', table: true },
      { key: 'vendor', label: 'Vendor', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', required: true, table: true },
      { key: 'payment_method', label: 'Paid via', type: 'select',
        options: ['Cash', 'Bank Transfer', 'UPI', 'Card', 'Cheque', 'Other'] },
      { key: 'reference', label: 'Reference', type: 'text' },
      { key: 'receipt_url', label: 'Receipt link', type: 'url', help: 'Google Drive link works well' }
    ]
  },

  documents: {
    table: 'Documents',
    title: 'Documents',
    singular: 'Document',
    icon: 'folder',
    labelKey: 'title',
    search: ['title', 'category', 'notes'],
    fields: [
      { key: 'id', label: 'ID', type: 'readonly', table: true, width: 100 },
      { key: 'title', label: 'Title', type: 'text', required: true, table: true },
      { key: 'entity_type', label: 'Linked to', type: 'select', table: true,
        options: ['Property', 'Unit', 'Tenant', 'Lease', 'Other'] },
      { key: 'entity_id', label: 'Linked record ID', type: 'text', table: true },
      { key: 'category', label: 'Category', type: 'select', table: true,
        options: ['Lease Agreement', 'ID Proof', 'Insurance', 'Tax Receipt', 'Utility Bill',
                  'Inspection', 'NOC', 'Other'] },
      { key: 'url', label: 'File link', type: 'url', required: true, table: true,
        help: 'Share a Google Drive / Dropbox link' },
      { key: 'issue_date', label: 'Issued', type: 'date' },
      { key: 'expiry_date', label: 'Expires', type: 'date', table: true,
        help: 'Documents expiring within 60 days appear on the dashboard' },
      { key: 'notes', label: 'Notes', type: 'textarea' }
    ]
  }
};

// Meter readings are entered and billed in bulk from the Meter readings screen;
// the definition drives that screen's history table and its CSV export.
entities.meterReadings = {
  table: 'MeterReadings',
  title: 'Meter readings',
  singular: 'Reading',
  icon: 'bolt',
  labelKey: 'id',
  search: ['id', 'category'],
  fields: [
    { key: 'reading_date', label: 'Date', type: 'date', table: true },
    { key: 'unit_id', label: 'Unit', type: 'ref', optionsFrom: 'units', table: true },
    { key: 'category', label: 'Meter', type: 'select', table: true, options: METER_CATEGORIES },
    { key: 'previous_reading', label: 'Previous', type: 'number', table: true },
    { key: 'current_reading', label: 'Current', type: 'number', table: true },
    { key: 'consumption', label: 'Units used', type: 'number', table: true },
    { key: 'rate', label: 'Rate', type: 'money', table: true },
    { key: 'amount', label: 'Amount', type: 'money', table: true },
    { key: 'invoice_id', label: 'Invoice', type: 'ref', optionsFrom: 'invoices', table: true }
  ]
};

/** Fields shown in the create/edit form. */
export function formFields(entity) {
  return entities[entity].fields.filter(f => f.form !== false && f.type !== 'readonly');
}

/** Fields shown as table columns. */
export function tableFields(entity) {
  return entities[entity].fields.filter(f => f.table);
}

export function fieldByKey(entity, key) {
  return entities[entity].fields.find(f => f.key === key);
}
