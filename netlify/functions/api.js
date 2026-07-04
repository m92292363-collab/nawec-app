// =============================================================
// NAWEC Customer App — API (single Netlify function)
// Env vars required (Netlify → Site settings → Environment):
//   DATABASE_URL   = Neon connection string
//   AUTH_SECRET    = long random string (session token signing)
//   ADMIN_PASSWORD = staff portal password
//     NOTE: shared password is for the pilot only. For real NAWEC
//     deployment move to individual staff accounts + roles.
// =============================================================

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';

// -------- Tariff config (adjust to current NAWEC tariff) --------
const TARIFF = {
  gmd_per_kwh: 12.0,   // domestic prepaid rate — CONFIRM WITH NAWEC
  service_fee: 0.0,    // flat fee per vend, if any
};

// ---------------- helpers ----------------
const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth, X-Admin-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(body),
});

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function signSession(customerId) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  const payload = `${customerId}.${exp}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(`${id}.${exp}`).digest('hex');
  if (sig !== expected) return null;
  if (Date.now() > Number(exp)) return null;
  return Number(id);
}

// ---------------- pluggable integration layer ----------------
// These two functions are the ONLY places that change when NAWEC
// grants access to their vending backend and a payment aggregator.

async function processPayment({ provider, amount, phone }) {
  // TODO (production): call QMoney / Africell Money / Wave collection API,
  // return { ok, ref } after confirmed payment or USSD push approval.
  const ref = 'DEMO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  return { ok: true, ref };
}

async function vendToken({ meterNumber, amount }) {
  // TODO (production): call NAWEC STS vending API with meter + amount,
  // return the real 20-digit token and exact kWh from their engine.
  let digits = '';
  while (digits.length < 20) digits += crypto.randomInt(0, 10);
  const token = digits.match(/.{5}/g).join('-'); // 5-5-5-5 like printed receipts
  const units = Math.max(0, (amount - TARIFF.service_fee) / TARIFF.gmd_per_kwh);
  return { token, units: Math.round(units * 100) / 100, demo: true };
}

// ---------------- handler ----------------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const action = body.action;
  const authId = verifySession(event.headers['x-auth'] || event.headers['X-Auth']);
  const isAdmin = (event.headers['x-admin-key'] || event.headers['X-Admin-Key']) === process.env.ADMIN_PASSWORD;

  try {
    switch (action) {

      // ================= AUTH =================
      case 'register': {
        const { name, phone, meter, pin } = body;
        if (!name || !phone || !meter || !/^\d{4}$/.test(String(pin)))
          return json(400, { error: 'Name, phone, meter number and a 4-digit PIN are required.' });
        // NOTE (production): validate meter number against NAWEC customer DB here.
        const salt = crypto.randomBytes(16).toString('hex');
        const pin_hash = hashPin(pin, salt);
        try {
          const rows = await sql`
            INSERT INTO customers (name, phone, meter_number, pin_hash, pin_salt)
            VALUES (${name.trim()}, ${phone.trim()}, ${meter.trim()}, ${pin_hash}, ${salt})
            RETURNING id, name, phone, meter_number, meter_type`;
          const c = rows[0];
          return json(200, { session: signSession(c.id), customer: c });
        } catch (e) {
          if (String(e).includes('unique')) return json(409, { error: 'This meter number is already registered. Log in instead.' });
          throw e;
        }
      }

      case 'login': {
        const { meter, pin } = body;
        const rows = await sql`SELECT * FROM customers WHERE meter_number = ${String(meter || '').trim()}`;
        if (!rows.length) return json(401, { error: 'Meter number not found.' });
        const c = rows[0];
        if (hashPin(pin, c.pin_salt) !== c.pin_hash) return json(401, { error: 'Wrong PIN.' });
        return json(200, {
          session: signSession(c.id),
          customer: { id: c.id, name: c.name, phone: c.phone, meter_number: c.meter_number, meter_type: c.meter_type },
        });
      }

      case 'me': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const rows = await sql`SELECT id, name, phone, meter_number, meter_type FROM customers WHERE id = ${authId}`;
        return json(200, { customer: rows[0] || null });
      }

      // ================= CASH POWER =================
      case 'purchase': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const amount = Number(body.amount);
        if (!(amount >= 25 && amount <= 50000)) return json(400, { error: 'Amount must be between D25 and D50,000.' });
        const provider = ['qmoney', 'africell', 'wave', 'demo'].includes(body.provider) ? body.provider : 'demo';

        const cust = (await sql`SELECT * FROM customers WHERE id = ${authId}`)[0];
        const pay = await processPayment({ provider, amount, phone: cust.phone });
        if (!pay.ok) return json(402, { error: 'Payment was not completed.' });

        const vend = await vendToken({ meterNumber: cust.meter_number, amount });
        const rows = await sql`
          INSERT INTO purchases (customer_id, amount_gmd, units_kwh, token, provider, payment_ref, status)
          VALUES (${authId}, ${amount}, ${vend.units}, ${vend.token}, ${provider}, ${pay.ref}, 'completed')
          RETURNING *`;
        return json(200, { purchase: rows[0], demo: vend.demo === true });
      }

      case 'purchases': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const rows = await sql`
          SELECT * FROM purchases WHERE customer_id = ${authId}
          ORDER BY created_at DESC LIMIT 50`;
        return json(200, { purchases: rows });
      }

      // ================= OUTAGES =================
      case 'alerts': { // public
        const rows = await sql`
          SELECT * FROM outage_alerts WHERE status <> 'resolved'
          ORDER BY created_at DESC LIMIT 30`;
        return json(200, { alerts: rows });
      }

      case 'report_outage': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const { service, area, description, lat, lng } = body;
        if (!area) return json(400, { error: 'Please tell us the area.' });
        const rows = await sql`
          INSERT INTO outage_reports (customer_id, service, area, description, lat, lng)
          VALUES (${authId}, ${service === 'water' ? 'water' : 'electricity'}, ${area.trim()},
                  ${description || ''}, ${lat || null}, ${lng || null})
          RETURNING *`;
        return json(200, { report: rows[0] });
      }

      case 'my_reports': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const rows = await sql`
          SELECT * FROM outage_reports WHERE customer_id = ${authId}
          ORDER BY created_at DESC LIMIT 20`;
        return json(200, { reports: rows });
      }

      // ================= BILLS =================
      case 'bills': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const rows = await sql`
          SELECT * FROM bills WHERE customer_id = ${authId}
          ORDER BY period DESC LIMIT 24`;
        return json(200, { bills: rows });
      }

      // ================= METER READINGS =================
      case 'submit_reading': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const reading = Number(body.reading);
        if (!(reading >= 0)) return json(400, { error: 'Enter a valid meter reading.' });
        const rows = await sql`
          INSERT INTO meter_readings (customer_id, reading_kwh, note)
          VALUES (${authId}, ${reading}, ${body.note || ''})
          RETURNING *`;
        return json(200, { reading: rows[0] });
      }

      case 'my_readings': {
        if (!authId) return json(401, { error: 'Not logged in' });
        const rows = await sql`
          SELECT * FROM meter_readings WHERE customer_id = ${authId}
          ORDER BY created_at DESC LIMIT 20`;
        return json(200, { readings: rows });
      }

      // ================= ADMIN =================
      case 'admin_login':
        return json(isAdmin ? 200 : 401, isAdmin ? { ok: true } : { error: 'Wrong password' });

      case 'admin_stats': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const [customers, salesToday, sales7, reportsOpen, byDay, byArea] = await Promise.all([
          sql`SELECT COUNT(*)::int AS n FROM customers`,
          sql`SELECT COALESCE(SUM(amount_gmd),0)::float AS s, COUNT(*)::int AS n FROM purchases WHERE created_at::date = now()::date`,
          sql`SELECT COALESCE(SUM(amount_gmd),0)::float AS s, COUNT(*)::int AS n FROM purchases WHERE created_at > now() - interval '7 days'`,
          sql`SELECT COUNT(*)::int AS n FROM outage_reports WHERE status = 'open'`,
          sql`SELECT to_char(created_at::date,'DD Mon') AS d, SUM(amount_gmd)::float AS s
              FROM purchases WHERE created_at > now() - interval '7 days'
              GROUP BY created_at::date ORDER BY created_at::date`,
          sql`SELECT area, COUNT(*)::int AS n FROM outage_reports
              WHERE created_at > now() - interval '30 days'
              GROUP BY area ORDER BY n DESC LIMIT 8`,
        ]);
        return json(200, {
          customers: customers[0].n,
          sales_today: salesToday[0], sales_7d: sales7[0],
          reports_open: reportsOpen[0].n,
          sales_by_day: byDay, reports_by_area: byArea,
        });
      }

      case 'admin_alert_create': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const { title, area, description, service, status, starts_at, ends_at } = body;
        if (!title || !area) return json(400, { error: 'Title and area are required.' });
        const rows = await sql`
          INSERT INTO outage_alerts (title, area, description, service, status, starts_at, ends_at)
          VALUES (${title}, ${area}, ${description || ''}, ${service === 'water' ? 'water' : 'electricity'},
                  ${['planned','active','resolved'].includes(status) ? status : 'active'},
                  ${starts_at || null}, ${ends_at || null})
          RETURNING *`;
        return json(200, { alert: rows[0] });
      }

      case 'admin_alert_update': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`
          UPDATE outage_alerts SET status = ${body.status} WHERE id = ${Number(body.id)} RETURNING *`;
        return json(200, { alert: rows[0] });
      }

      case 'admin_alerts': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`SELECT * FROM outage_alerts ORDER BY created_at DESC LIMIT 100`;
        return json(200, { alerts: rows });
      }

      case 'admin_reports': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`
          SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, c.meter_number
          FROM outage_reports r JOIN customers c ON c.id = r.customer_id
          ORDER BY r.created_at DESC LIMIT 200`;
        return json(200, { reports: rows });
      }

      case 'admin_report_update': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`
          UPDATE outage_reports SET status = ${body.status} WHERE id = ${Number(body.id)} RETURNING *`;
        return json(200, { report: rows[0] });
      }

      case 'admin_readings': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`
          SELECT m.*, c.name AS customer_name, c.meter_number
          FROM meter_readings m JOIN customers c ON c.id = m.customer_id
          ORDER BY m.created_at DESC LIMIT 200`;
        return json(200, { readings: rows });
      }

      case 'admin_sales': {
        if (!isAdmin) return json(401, { error: 'Unauthorized' });
        const rows = await sql`
          SELECT p.*, c.name AS customer_name, c.meter_number
          FROM purchases p JOIN customers c ON c.id = p.customer_id
          ORDER BY p.created_at DESC LIMIT 200`;
        return json(200, { sales: rows });
      }

      default:
        return json(400, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error. Please try again.' });
  }
};
