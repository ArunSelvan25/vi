/**
 * Faithful in-memory mock of the Apps Script Web App, plus a static server for
 * the app itself. Lets us exercise the real front-end end-to-end.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
                '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml',
                '.ico':'image/x-icon', '.woff2':'font/woff2' };

// ── seed data ───────────────────────────────────────────────────────────────
const db = {
  Properties: [
    { id:'PRP-00001', name:'Sunrise Residency', type:'Apartment', address_line1:'12 MG Road', city:'Bengaluru', state:'KA', postal_code:'560001', country:'India', owner_name:'V Iyer', purchase_date:'2019-04-10', purchase_price:12000000, current_value:18500000, status:'Active', notes:'' },
    { id:'PRP-00002', name:'Palm Court Villas', type:'Villa', address_line1:'8 Beach Rd', city:'Chennai', state:'TN', postal_code:'600041', country:'India', owner_name:'V Iyer', purchase_date:'2021-08-01', purchase_price:22000000, current_value:26000000, status:'Active', notes:'' }
  ],
  Units: [
    { id:'UNT-00001', property_id:'PRP-00001', unit_number:'A-101', floor:'1', bedrooms:2, bathrooms:2, area_sqft:1100, furnishing:'Semi-furnished', rent_amount:28000, deposit_amount:150000, status:'Occupied', amenities:'Lift, Parking', notes:'' },
    { id:'UNT-00002', property_id:'PRP-00001', unit_number:'A-102', floor:'1', bedrooms:3, bathrooms:2, area_sqft:1450, furnishing:'Fully furnished', rent_amount:42000, deposit_amount:250000, status:'Vacant', amenities:'Lift, Parking, Gym', notes:'' },
    { id:'UNT-00003', property_id:'PRP-00002', unit_number:'V-1', floor:'G', bedrooms:4, bathrooms:4, area_sqft:2800, furnishing:'Unfurnished', rent_amount:75000, deposit_amount:450000, status:'Occupied', amenities:'Garden, Pool', notes:'' }
  ],
  Tenants: [
    { id:'TNT-00001', full_name:'Anita Rao', email:'anita@example.com', phone:'+91 98800 11111', id_type:'Aadhaar', id_number:'XXXX1234', occupation:'Designer', emergency_name:'R Rao', emergency_phone:'+91 98800 22222', status:'Active', notes:'' },
    { id:'TNT-00002', full_name:'Karthik Menon', email:'', phone:'+91 99400 33333', id_type:'PAN', id_number:'ABCDE1234F', occupation:'Engineer', emergency_name:'S Menon', emergency_phone:'+91 99400 44444', status:'Active', notes:'' }
  ],
  Leases: [
    { id:'LSE-00001', property_id:'PRP-00001', unit_id:'UNT-00001', tenant_id:'TNT-00001', start_date:'2025-04-01', end_date:'2026-03-31', rent_amount:28000, deposit_amount:150000, deposit_status:'Held', frequency:'Monthly', billing_day:1, late_fee:500, grace_days:5, escalation_pct:5, status:'Active', notes:'' },
    { id:'LSE-00002', property_id:'PRP-00002', unit_id:'UNT-00003', tenant_id:'TNT-00002', start_date:'2025-06-01', end_date:'2026-10-15', rent_amount:75000, deposit_amount:450000, deposit_status:'Held', frequency:'Monthly', billing_day:1, late_fee:1000, grace_days:5, escalation_pct:0, status:'Active', notes:'' }
  ],
  Invoices: [
    { id:'INV-00001', lease_id:'LSE-00001', tenant_id:'TNT-00001', unit_id:'UNT-00001', property_id:'PRP-00001', type:'Rent', period_start:'2026-07-01', period_end:'2026-07-31', issue_date:'2026-07-01', due_date:'2026-07-06', amount:28000, tax:0, total:28000, amount_paid:28000, balance:0, status:'Paid', notes:'' },
    { id:'INV-00002', lease_id:'LSE-00001', tenant_id:'TNT-00001', unit_id:'UNT-00001', property_id:'PRP-00001', type:'Rent', period_start:'2026-08-01', period_end:'2026-08-31', issue_date:'2026-08-01', due_date:'2026-08-06', amount:28000, tax:0, total:28000, amount_paid:0, balance:28000, status:'Overdue', notes:'' },
    { id:'INV-00003', lease_id:'LSE-00002', tenant_id:'TNT-00002', unit_id:'UNT-00003', property_id:'PRP-00002', type:'Rent', period_start:'2026-09-01', period_end:'2026-09-30', issue_date:'2026-09-01', due_date:'2026-09-06', amount:75000, tax:0, total:75000, amount_paid:25000, balance:50000, status:'Partial', notes:'' }
  ],
  InvoiceItems: [
    { id:'ITM-00001', invoice_id:'INV-00001', description:'Rent · July', category:'Rent', quantity:1, unit_amount:28000, amount:28000, notes:'' },
    { id:'ITM-00002', invoice_id:'INV-00002', description:'Rent · August', category:'Rent', quantity:1, unit_amount:28000, amount:28000, notes:'' },
    { id:'ITM-00003', invoice_id:'INV-00003', description:'Rent · September', category:'Rent', quantity:1, unit_amount:70000, amount:70000, notes:'' },
    { id:'ITM-00004', invoice_id:'INV-00003', description:'EB bill · 400 units', category:'Electricity', quantity:400, unit_amount:8.5, amount:3400, notes:'' },
    { id:'ITM-00005', invoice_id:'INV-00003', description:'Water charges', category:'Water', quantity:1, unit_amount:1600, amount:1600, notes:'' }
  ],
  Payments: [
    { id:'PAY-00001', invoice_id:'INV-00001', lease_id:'LSE-00001', tenant_id:'TNT-00001', property_id:'PRP-00001', payment_date:'2026-07-03', amount:28000, method:'UPI', reference:'UPI-8891', received_by:'Admin', notes:'' },
    { id:'PAY-00002', invoice_id:'INV-00003', lease_id:'LSE-00002', tenant_id:'TNT-00002', property_id:'PRP-00002', payment_date:'2026-09-04', amount:25000, method:'Bank Transfer', reference:'NEFT-2231', received_by:'Admin', notes:'' }
  ],
  Maintenance: [
    { id:'MNT-00001', property_id:'PRP-00001', unit_id:'UNT-00001', tenant_id:'TNT-00001', title:'Kitchen tap leaking', description:'Dripping constantly', category:'Plumbing', priority:'High', status:'Open', reported_date:'2026-09-02', scheduled_date:'', completed_date:'', vendor_name:'', vendor_phone:'', cost:'', notes:'' },
    { id:'MNT-00002', property_id:'PRP-00002', unit_id:'UNT-00003', tenant_id:'TNT-00002', title:'Pool pump service', description:'Annual service', category:'Other', priority:'Low', status:'Resolved', reported_date:'2026-08-10', scheduled_date:'2026-08-14', completed_date:'2026-08-14', vendor_name:'AquaCare', vendor_phone:'+91 90000 11111', cost:6500, notes:'' }
  ],
  Expenses: [
    { id:'EXP-00001', property_id:'PRP-00001', unit_id:'', date:'2026-08-15', category:'Property Tax', vendor:'BBMP', description:'Annual property tax', amount:32000, payment_method:'Bank Transfer', reference:'TX-9911', receipt_url:'' },
    { id:'EXP-00002', property_id:'PRP-00002', unit_id:'UNT-00003', date:'2026-09-01', category:'Repairs', vendor:'AquaCare', description:'Pool pump', amount:6500, payment_method:'UPI', reference:'', receipt_url:'' }
  ],
  Documents: [
    { id:'DOC-00001', entity_type:'Lease', entity_id:'LSE-00001', title:'Rental agreement — A-101', category:'Lease Agreement', url:'https://drive.google.com/file/d/x', issue_date:'2025-04-01', expiry_date:'2026-03-31', notes:'' },
    { id:'DOC-00002', entity_type:'Property', entity_id:'PRP-00001', title:'Fire safety certificate', category:'NOC', url:'https://drive.google.com/file/d/y', issue_date:'2025-10-01', expiry_date:'2026-10-01', notes:'' }
  ],
  Users: [{ id:'USR-00001', name:'Admin', phone:'+91 90000 12345', email:'admin@example.com',
            role:'admin', active:'TRUE', last_login:'2026-09-08' }],
  Settings: { org_name:'VI Lifestyle Properties', currency:'INR', currency_symbol:'₹', locale:'en-IN',
              invoice_prefix:'INV', default_late_fee:'0', default_grace_days:'5', reminder_days_before:'3',
              reminder_enabled:'false', lease_expiry_alert_days:'45', session_hours:'12' },
  ActivityLog: [{ id:'LOG-00001', timestamp:'2026-09-08T10:00:00', actor:'admin@example.com', action:'create', entity:'Leases', entity_id:'LSE-00002', details:'' }]
};

const stats = () => {
  const units = db.Units, occ = units.filter(u=>u.status==='Occupied').length;
  const num = (a,f,t)=>a.filter(t||(()=>true)).reduce((s,r)=>s+Number(r[f]||0),0);
  return {
    properties: db.Properties.length, units: units.length, occupied_units: occ, vacant_units: units.length-occ,
    occupancy_rate: Math.round(occ/units.length*1000)/10,
    active_leases: db.Leases.filter(l=>l.status==='Active').length,
    tenants: db.Tenants.filter(t=>t.status==='Active').length,
    monthly_rent_roll: num(db.Leases,'rent_amount',l=>l.status==='Active'),
    outstanding: num(db.Invoices,'balance',i=>['Unpaid','Partial','Overdue'].includes(i.status)),
    overdue: num(db.Invoices,'balance',i=>i.status==='Overdue'),
    overdue_count: db.Invoices.filter(i=>i.status==='Overdue').length,
    collected_this_month: num(db.Payments,'amount',p=>p.payment_date.startsWith('2026-09')),
    expenses_this_month: num(db.Expenses,'amount',e=>e.date.startsWith('2026-09')),
    open_tickets: db.Maintenance.filter(m=>['Open','In Progress','On Hold'].includes(m.status)).length,
    deposits_held: num(db.Leases,'deposit_amount',l=>l.deposit_status==='Held')
  };
};

const lower = k => k.toLowerCase();
let seq = 100;

/** Mirrors the Web App: a write can carry the state the client would refetch. */
function withSnapshot(payload, res) {
  if (res.ok && payload && payload.withSnapshot) res.data.snapshot = bootstrapData();
  return res;
}

function bootstrapData() {
  return {
    user: db.Users[0], settings: db.Settings, stats: stats(),
    properties: db.Properties, units: db.Units, tenants: db.Tenants, leases: db.Leases,
    invoices: db.Invoices, invoiceItems: db.InvoiceItems,
    payments: db.Payments, maintenance: db.Maintenance,
    expenses: db.Expenses, documents: db.Documents, users: db.Users, activity: db.ActivityLog
  };
}

function handle(action, payload, token) {
  if (action === 'ping') return { ok:true, data:{ service:'mock', version:'1.0.0' } };
  if (action === 'login') {
    const digits = String(payload.phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (digits === '9000012345' && payload.password === 'password123') {
      return { ok:true, data:{ token:'mock-token', user:db.Users[0], settings:db.Settings } };
    }
    return { ok:false, error:'Invalid phone number or password' };
  }
  if (action === 'setup') return { ok:true, data:{ alreadySeeded:true } };
  if (token !== 'mock-token') return { ok:false, error:'AUTH_REQUIRED' };

  switch (action) {
    case 'bootstrap': return { ok:true, data: bootstrapData() };
    case 'create': {
      const row = { ...payload.data, id: (payload.table.slice(0,3).toUpperCase())+'-'+(++seq) };
      (db[payload.table] ||= []).push(row);
      return withSnapshot(payload, { ok:true, data:{ row } });
    }
    case 'update': {
      const arr = db[payload.table] || [];
      const i = arr.findIndex(r => r.id === payload.id);
      if (i < 0) return { ok:false, error:'not found' };
      arr[i] = { ...arr[i], ...payload.data };
      return withSnapshot(payload, { ok:true, data:{ row: arr[i] } });
    }
    case 'remove': {
      db[payload.table] = (db[payload.table]||[]).filter(r => r.id !== payload.id);
      if (payload.table === 'Invoices') {
        db.InvoiceItems = db.InvoiceItems.filter(i => i.invoice_id !== payload.id);
      }
      return withSnapshot(payload, { ok:true, data:{ id: payload.id } });
    }
    case 'recordPayment': {
      const inv = db.Invoices.find(i => i.id === payload.invoice_id);
      const pay = { id:'PAY-'+(++seq), invoice_id:inv.id, lease_id:inv.lease_id, tenant_id:inv.tenant_id,
                    property_id:inv.property_id, payment_date:payload.payment_date, amount:Number(payload.amount),
                    method:payload.method, reference:payload.reference||'', received_by:'Admin', notes:'' };
      db.Payments.push(pay);
      inv.amount_paid = Number(inv.amount_paid||0)+pay.amount;
      inv.balance = Number(inv.total)-inv.amount_paid;
      inv.status = inv.balance<=0 ? 'Paid' : 'Partial';
      return { ok:true, data:{ payment:pay, invoice:inv } };
    }
    case 'saveInvoice': {
      const priced = (payload.items || []).map(raw => {
        const qty = raw.quantity === '' || raw.quantity === undefined ? 1 : Number(raw.quantity);
        const unit = Number(raw.unit_amount || 0);
        return { id: raw.id || 'ITM-' + (++seq), invoice_id: null,
                 description: raw.description, category: raw.category || 'Other',
                 quantity: qty, unit_amount: unit,
                 amount: Math.round(qty * unit * 100) / 100, notes: raw.notes || '' };
      });
      if (!priced.length) return { ok:false, error:'An invoice needs at least one line item' };
      const subtotal = Math.round(priced.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      const tax = Number(payload.data?.tax || 0);
      const cats = [...new Set(priced.map(i => i.category))];

      let inv;
      if (payload.id) {
        inv = db.Invoices.find(i => i.id === payload.id);
        Object.assign(inv, payload.data);
      } else {
        inv = { id: 'INV-' + (++seq), ...payload.data, amount_paid: 0 };
        db.Invoices.push(inv);
      }
      inv.amount = subtotal;
      inv.tax = tax;
      inv.total = Math.round((subtotal + tax) * 100) / 100;
      inv.type = payload.data?.type || (cats.length === 1 ? cats[0] : 'Mixed');
      inv.balance = Math.round((inv.total - Number(inv.amount_paid || 0)) * 100) / 100;
      inv.status = inv.balance <= 0 ? 'Paid' : (Number(inv.amount_paid) > 0 ? 'Partial' : 'Unpaid');

      db.InvoiceItems = db.InvoiceItems.filter(i => i.invoice_id !== inv.id);
      priced.forEach(i => { i.invoice_id = inv.id; db.InvoiceItems.push(i); });
      return { ok:true, data:{ invoice: inv, items: priced } };
    }
    case 'generateInvoices': return withSnapshot(payload, { ok:true, data:{ created:0, invoices:[] } });
    case 'refreshStatuses': return withSnapshot(payload, { ok:true, data:{ changes:0 } });
    case 'sendReminders': return { ok:true, data:{ sent:2, skipped:0 } };
    case 'changePassword': return { ok:true, data:{ changed:true } };
    case 'createUser': return { ok:true, data:{ row:{ id:'USR-'+(++seq), ...payload } } };
    case 'stats': return { ok:true, data: stats() };
    default: return { ok:false, error:'Unknown action: '+action };
  }
}

function handler(req, res) {
  if (req.url.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const out = handle(parsed.action, parsed.payload || {}, parsed.token || '');
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
