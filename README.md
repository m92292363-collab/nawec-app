# NAWEC — My Power & Water (Customer PWA + Staff Portal)

Full-stack customer self-service app for NAWEC. Vanilla JS PWA + Neon Postgres + Netlify Functions.

## Features
**Customer app (`index.html`)** — installable PWA, works offline for the shell
- Register / log in with meter number + 4-digit PIN
- Buy cash power → payment → 20-digit STS-format token on a receipt screen (copy button)
- Outage alerts feed + report an outage (with optional GPS location)
- Bills & payment history (postpaid)
- Submit meter readings

**Staff portal (`admin.html`)** — dark ops dashboard
- KPIs: sales today, sales 7 days, customers, open reports
- Horizontal bar charts: sales by day, reports by area
- Publish/resolve alerts, triage outage reports (with map links), view readings and all sales

## Deploy (same flow as School OS)
1. **Neon**: create a project → run `schema.sql` in the SQL editor → copy the connection string.
2. **GitHub**: push this folder to a new repo. ⚠️ Confirm you're pushing to the right repo/remote before deploying.
3. **Netlify**: New site from Git → build command empty, publish dir `.`, functions auto-detected via `netlify.toml`.
4. **Environment variables** (Site settings → Environment):
   - `DATABASE_URL` — Neon connection string
   - `AUTH_SECRET` — long random string (e.g. `openssl rand -hex 32`)
   - `ADMIN_PASSWORD` — staff portal password (pilot only — move to individual staff accounts before full rollout)
5. Open the site → register with any meter number → buy a demo token.

## Production integration points (the NAWEC pitch)
Only **two functions** in `netlify/functions/api.js` change for go-live:
- `processPayment()` → wire to QMoney / Africell Money / Wave collection API
- `vendToken()` → wire to NAWEC's STS vending backend (real tokens + exact kWh)

Also for production:
- Validate meter numbers against NAWEC's customer database in `register`
- Confirm the tariff in `TARIFF` (currently D12.00/kWh placeholder)
- Replace shared admin password with per-staff accounts + roles
- Add rate limiting on `login` (PIN brute-force protection) — Netlify edge or a simple attempts table

## Files
```
index.html                  Customer PWA (single file)
admin.html                  Staff portal (single file)
netlify/functions/api.js    All API endpoints (single function)
schema.sql                  Neon Postgres schema
manifest.json, sw.js        PWA install + offline shell
icon-192.png, icon-512.png  App icons
netlify.toml, package.json  Deploy config
```
