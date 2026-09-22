/**
 * Dev server: the app's static files, plus the REAL backend.
 *
 * `/api` runs supabase/functions/api/backend.js itself, on a throwaway
 * Postgres database (see pg-harness.mjs; `npm run db:test` starts one). This
 * used to be a hand-written imitation of the API, and it drifted: it always
 * claimed the database was set up (so the broken first-run wizard passed every
 * browser test), accepted any payment without touching the invoice, and never
 * applied a single business rule. Every browser test now exercises the rules
 * users actually get.
 *
 * The sample data is written straight into the tables, as if it were already
 * there, and dated relative to today so the tests do not expire. It is kept
 * consistent with the rules — statuses, balances and late fees already where
 * the backend would put them — so opening the app changes nothing by itself.
 *
 * Sign in with phone 9000012345 / password password123.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { makeSandbox, closeAll } from './pg-harness.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
                '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml',
                '.ico':'image/x-icon', '.woff2':'font/woff2' };

// The browser under test runs in this machine's time zone, so the backend does
// too — otherwise "today" differs between them around midnight.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const box = await makeSandbox({ timeZone: TZ });

// ── dates relative to today ─────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
/** Day `day` of the month `offset` months from this one (clamped to its length). */
const monthDay = (offset, day) => {
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0).getDate();
  return iso(new Date(now.getFullYear(), now.getMonth() + offset, Math.min(day, last)));
};
const monthEnd = (offset) => iso(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0));
const inDays = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };


const seed = {
  Properties: [
    { id:'PRP-00001', name:'Sunrise Residency', type:'Apartment', address_line1:'12 MG Road', city:'Bengaluru', state:'KA', postal_code:'560001', country:'India', owner_name:'V Iyer', purchase_date:'2019-04-10', purchase_price:12000000, current_value:18500000, status:'Active' },
    { id:'PRP-00002', name:'Palm Court Villas', type:'Villa', address_line1:'8 Beach Rd', city:'Chennai', state:'TN', postal_code:'600041', country:'India', owner_name:'V Iyer', purchase_date:'2021-08-01', purchase_price:22000000, current_value:26000000, status:'Active' }
  ],
  Units: [
    { id:'UNT-00001', property_id:'PRP-00001', unit_number:'A-101', floor:'1', bedrooms:2, bathrooms:2, area_sqft:1100, furnishing:'Semi-furnished', rent_amount:28000, deposit_amount:150000, status:'Occupied', amenities:'Lift, Parking' },
    { id:'UNT-00002', property_id:'PRP-00001', unit_number:'A-102', floor:'1', bedrooms:3, bathrooms:2, area_sqft:1450, furnishing:'Fully furnished', rent_amount:42000, deposit_amount:250000, status:'Vacant', amenities:'Lift, Parking, Gym' },
    { id:'UNT-00003', property_id:'PRP-00002', unit_number:'V-1', floor:'G', bedrooms:4, bathrooms:4, area_sqft:2800, furnishing:'Unfurnished', rent_amount:75000, deposit_amount:450000, status:'Occupied', amenities:'Garden, Pool' }
  ],
  Tenants: [
    { id:'TNT-00001', full_name:'Anita Rao', email:'anita@example.com', phone:'+91 98800 11111', id_type:'Aadhaar', id_number:'XXXX1234', occupation:'Designer', emergency_name:'R Rao', emergency_phone:'+91 98800 22222', status:'Active' },
    { id:'TNT-00002', full_name:'Karthik Menon', email:'', phone:'+91 99400 33333', id_type:'PAN', id_number:'ABCDE1234F', occupation:'Engineer', emergency_name:'S Menon', emergency_phone:'+91 99400 44444', status:'Active' },
    // shares A-101 with Anita Rao, who is billed
    { id:'TNT-00003', full_name:'Priya Shah', email:'', phone:'+91 98450 55555', id_type:'Aadhaar', id_number:'XXXX5678', occupation:'Analyst', emergency_name:'M Shah', emergency_phone:'+91 98450 66666', status:'Active' }
  ],
  // deposits collected before the app existed, so marked Held by hand
  Leases: [
    { id:'LSE-00001', property_id:'PRP-00001', unit_id:'UNT-00001', tenant_id:'TNT-00001', start_date:monthDay(-11, 1), end_date:monthEnd(6), rent_amount:28000, deposit_amount:150000, deposit_status:'Held', frequency:'Monthly', late_fee:500, grace_days:5, escalation_pct:5, status:'Active' },
    { id:'LSE-00002', property_id:'PRP-00002', unit_id:'UNT-00003', tenant_id:'TNT-00002', start_date:monthDay(-3, 1), end_date:inDays(30), rent_amount:75000, deposit_amount:450000, deposit_status:'Held', frequency:'Monthly', late_fee:1000, grace_days:5, escalation_pct:0, status:'Active' }
  ],
  LeaseTenants: [
    { id:'LTN-00001', lease_id:'LSE-00001', tenant_id:'TNT-00003', role:'Co-tenant', relationship:'Friend', move_in_date:monthDay(-11, 1) }
  ],
  Invoices: [
    { id:'INV-00001', lease_id:'LSE-00001', tenant_id:'TNT-00001', unit_id:'UNT-00001', property_id:'PRP-00001', type:'Rent', period_start:monthDay(-2, 1), period_end:monthEnd(-2), issue_date:monthDay(-2, 1), due_date:monthDay(-2, 6), amount:28000, tax:0, total:28000, amount_paid:28000, balance:0, status:'Paid' },
    { id:'INV-00002', lease_id:'LSE-00001', tenant_id:'TNT-00001', unit_id:'UNT-00001', property_id:'PRP-00001', type:'Rent', period_start:monthDay(-1, 1), period_end:monthEnd(-1), issue_date:monthDay(-1, 1), due_date:monthDay(-1, 6), amount:28500, tax:0, total:28500, amount_paid:0, balance:28500, status:'Overdue' },
    { id:'INV-00003', lease_id:'LSE-00002', tenant_id:'TNT-00002', unit_id:'UNT-00003', property_id:'PRP-00002', type:'Rent', period_start:monthDay(0, 1), period_end:monthEnd(0), issue_date:monthDay(0, 1), due_date:inDays(10), amount:75000, tax:0, total:75000, amount_paid:25000, balance:50000, status:'Partial' }
  ],
  InvoiceItems: [
    { id:'ITM-00001', invoice_id:'INV-00001', description:'Rent · last-but-one month', category:'Rent', quantity:1, unit_amount:28000, amount:28000 },
    { id:'ITM-00002', invoice_id:'INV-00002', description:'Rent · last month', category:'Rent', quantity:1, unit_amount:28000, amount:28000 },
    { id:'ITM-00006', invoice_id:'INV-00002', description:'Late fee · payment overdue', category:'Late Fee', quantity:1, unit_amount:500, amount:500 },
    { id:'ITM-00003', invoice_id:'INV-00003', description:'Rent · September', category:'Rent', quantity:1, unit_amount:70000, amount:70000 },
    { id:'ITM-00004', invoice_id:'INV-00003', description:'EB bill · 400 units', category:'Electricity', quantity:400, unit_amount:8.5, amount:3400 },
    { id:'ITM-00005', invoice_id:'INV-00003', description:'Water charges', category:'Water', quantity:1, unit_amount:1600, amount:1600 }
  ],
  Payments: [
    { id:'PAY-00001', invoice_id:'INV-00001', lease_id:'LSE-00001', tenant_id:'TNT-00001', property_id:'PRP-00001', payment_date:monthDay(-2, 3), amount:28000, method:'UPI', reference:'UPI-8891', received_by:'Admin' },
    { id:'PAY-00002', invoice_id:'INV-00003', lease_id:'LSE-00002', tenant_id:'TNT-00002', property_id:'PRP-00002', payment_date:monthDay(0, 1), amount:25000, method:'Bank Transfer', reference:'NEFT-2231', received_by:'Admin' }
  ],
  Maintenance: [
    { id:'MNT-00001', property_id:'PRP-00001', unit_id:'UNT-00001', tenant_id:'TNT-00001', title:'Kitchen tap leaking', description:'Dripping constantly', category:'Plumbing', priority:'High', status:'Open', reported_date:monthDay(0, 1), cost:'' },
    { id:'MNT-00002', property_id:'PRP-00002', unit_id:'UNT-00003', tenant_id:'TNT-00002', title:'Pool pump service', description:'Annual service', category:'Other', priority:'Low', status:'Resolved', reported_date:monthDay(-1, 10), scheduled_date:monthDay(-1, 14), completed_date:monthDay(0, 1), vendor_name:'AquaCare', vendor_phone:'+91 90000 11111', cost:6500 }
  ],
  Expenses: [
    { id:'EXP-00001', property_id:'PRP-00001', unit_id:'', date:monthDay(-1, 15), category:'Property Tax', vendor:'BBMP', description:'Annual property tax', amount:32000, payment_method:'Bank Transfer', reference:'TX-9911' },
    // booked from the resolved pool-pump ticket, as the backend does
    { id:'EXP-00002', property_id:'PRP-00002', unit_id:'UNT-00003', date:monthDay(0, 1), category:'Other', vendor:'AquaCare', description:'Pool pump service · AquaCare', amount:6500, reference:'MNT-00002' }
  ],
  Documents: [
    { id:'DOC-00001', entity_type:'Lease', entity_id:'LSE-00001', title:'Rental agreement — A-101', category:'Lease Agreement', url:'https://drive.google.com/file/d/x', issue_date:monthDay(-11, 1), expiry_date:monthEnd(6) },
    { id:'DOC-00002', entity_type:'Property', entity_id:'PRP-00001', title:'Fire safety certificate', category:'NOC', url:'https://drive.google.com/file/d/y', issue_date:monthDay(-11, 1), expiry_date:inDays(16) }
  ]
};

// the sample data, then its administrator, as the setup wizard would create one
const stamp = iso(now) + 'T09:00:00';
const tables = {};
for (const [table, rows] of Object.entries(seed)) {
  tables[table] = rows.map(row => ({ created_at: stamp, updated_at: stamp, ...row }));
}
await box.seed(tables);
const setup = await box.handle('setup', { adminPhone: '+91 90000 12345', adminPassword: 'password123',
                                          adminName: 'Admin', adminEmail: 'admin@example.com' }, '');
if (!setup.ok) throw new Error('dev server setup failed: ' + setup.error);

// drop the throwaway database when the tests stop the server
const stop = () => closeAll().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// ── HTTP ────────────────────────────────────────────────────────────────────
function handler(req, res) {
  if (req.url.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      let out;
      try { out = await box.handle(parsed.action, parsed.payload || {}, parsed.token || ''); }
      catch (e) { out = { ok: false, error: 'dev server: ' + e.message }; }
      res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
}

// Port 0 lets the OS pick a free port, so a stale server can never collide.
// The chosen port is printed as `PORT=<n>` for the test harness to read.
const PORT = Number(process.env.PORT ?? 8099);
const server = http.createServer(handler);
server.listen(PORT, () => console.log('PORT=' + server.address().port));
