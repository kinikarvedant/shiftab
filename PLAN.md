# Shiftab — Build Plan

How Shiftab is put together. Decisions are final unless a later section
says otherwise; trade-offs are listed at the end.

## 1. Stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node ≥ 22.18** | Runs TypeScript natively (type stripping), ships `node:sqlite`, `node:crypto`, `node:test` — no build step or native addons on the server. |
| Server | **Fastify 5** + `@fastify/static` | Mature, fast, body-size limits, structured logging. |
| Database | **SQLite** (`node:sqlite`, WAL mode) | One file, zero ops, trivially backed up; fine for one venue per deployment. Postgres is the upgrade path for multi-venue. |
| Validation | **Zod**, shared by client and server | One schema per collection, strict (unknown keys rejected). |
| Client | **React 19 + Vite + TypeScript** | Largest ecosystem → best base for a template. |
| Offline store | **Dexie (IndexedDB)** + `useLiveQuery` | UI reads straight from the local DB, so it is reactive and offline by construction. |
| Offline app | **vite-plugin-pwa** (Workbox) | Precaches the app shell, fonts and icons; installable. |
| Icons | `lucide-react` | Consistent, tree-shaken, bundled (works offline). |
| Styling | Plain CSS with design tokens (custom properties), fluid `clamp()` scale, container queries | No framework lock-in; native platform features. |
| Font | Chosen by the UI research (`docs/research/ui-ux.md`), self-hosted via Fontsource | Offline, no third-party requests (CSP stays `'self'`). |

## 2. Repository layout

```
shared/            code used by both client and server
  permissions.ts   permission catalogue, sensitive set, default groups, can()
  schema.ts        Zod schemas + collection registry (the extension point)
  money.ts         integer-cents order maths
  time.ts          business-day / week maths (timezone + DST correct)
  report.ts        daily ledger + weekly payroll builder
  presets.ts       restaurant / café / bar starter templates
server/
  index.ts         bootstrap, security headers, static files, SSE, route wiring
  db.ts            SQLite schema, document store, audit log
  security.ts      scrypt, tokens, AES-GCM field encryption, TOTP, PIN keys, rate limiter
  auth.ts          setup wizard, login/logout, session state, TOTP, device enrolment
  sync.ts          push/pull + per-collection authorisation
  staff.ts         users, groups, PINs, passwords (rank rules)
  finance.ts       pay rates, report dataset, backups
src/
  main.tsx, app.tsx, styles.css
  lib/             db (Dexie), api, sync engine, session (PIN/password/vault), crypto, format
  ui/              shared components (Button, Dialog, PinPad, Avatar, Money, Field, Toast…)
  screens/         Setup, Lock (staff tiles + PIN), Login (password)
  modules/         one folder per feature + index.ts registry
    floor/ order/ kitchen/ reservations/ timeclock/ staff/ reports/ settings/ audit/
test/              node:test checks for money, reports, permissions, security, API authz
docs/              research notes, deployment, extending the template
```

## 3. Data model

Every synced record is a **document** in a **collection**:
`{ id: uuid, ...fields, updatedAt, updatedBy }`. The server adds a monotonically increasing
`seq` and a `deleted` tombstone flag.

| Collection | Key fields | Read | Write |
|---|---|---|---|
| `settings` (id `business`) | name, currency, locale, timezone, taxRateBp, taxInclusive, serviceChargeBp, dayStartHour, weekStartsOn, overtime, paymentMethods, lockAfterSec, require2faForFinance | everyone | `settings.manage` |
| `groups` | name, rank, permissions[], color | everyone | **API only** (rank rules) |
| `users` | name, groupId, active, color, *server-managed:* pinSalt, pinCheck, hasPassword, email, hasTotp | everyone | **API only** |
| `photos` (id = userId) | dataUrl (≤ 256 px JPEG) | everyone | self, or `staff.manage` |
| `categories`, `items` | name, sort, color / price, categoryId, active | everyone | `menu.manage` |
| `areas`, `tables` | name, sort / name, areaId, seats | everyone | `floor.manage` |
| `reservations` | name, phone, partySize, start, durationMin, tableId, status, notes | everyone | `reservations.manage` |
| `orders` | number, type, tableId, guests, status (open/paid/void), discount, note, openedBy, closedAt, *server-managed:* totals | windowed | see §5.3 |
| `orderItems` | orderId, itemId, name, unitPrice, qty, note, status (new/sent/ready), voidReason | windowed | see §5.3 |
| `payments` | orderId, method, amount, tip, tendered | windowed | `payments.take` / delete: `payments.refund` |
| `shifts` | userId, clockIn, clockOut, breakMin, note | windowed | self punch, or `timeclock.manage` (+rank) |

**Server-only tables:** `credentials` (password hash, encrypted TOTP secret, encrypted PIN
key, lockout counters), `sessions`, `devices`, `mutations` (processed ids, for idempotency),
`audit`, `pay_rates` (encrypted).

**Windowed** = terminals only receive open orders plus anything touched in the last
`historyDays` (default 2), and 14 days of shifts (so staff can check their hours offline).
Full history is only reachable through the finance API (`/api/finance/dataset`) and the
attendance API (`/api/attendance`), both password-session only.

Money is always integer minor units; rates are basis points (`1000` = 10 %).

## 4. Sync protocol (offline-first)

1. **Local write.** The UI writes the document to Dexie and appends a mutation
   `{mid, collection, id, op, data, at, actor, sig?}` to the `outbox` in one transaction.
   The UI updates instantly (optimistic).
2. **Push** (`POST /api/sync/push`): outbox entries in order. The server, per mutation:
   dedupes by `mid` → authenticates the actor (§5.2) → validates with the Zod schema →
   authorises with the collection rule → applies with a new `seq` → writes audit entries.
   Returns `ok` or a rejection reason plus the server's current copy, which the client
   restores. Network errors leave the outbox untouched (retry with backoff).
3. **Pull** (`GET /api/sync/pull?since=<seq>`): documents changed after the cursor that the
   caller may read; paged. Local documents with a pending mutation are not overwritten.
4. **Real time:** `GET /api/events` (Server-Sent Events) emits the latest `seq` after every
   commit; clients pull immediately. Also triggered on `online`, after local writes, and
   every 30 s.
5. **Conflicts:** server order wins per document (last write wins). Order lines are separate
   documents, so two devices adding items to the same order never collide.
6. **Ordering safety:** the outbox is pushed strictly in order; a mutation that cannot be
   sent yet (its author's session has expired) blocks the ones behind it, with a visible
   banner — nothing is ever dropped silently.

## 5. Security model

### 5.1 Credentials
| Credential | Who | Stored as | Used for |
|---|---|---|---|
| Password (≥ 10 chars) | managers/owners | scrypt (N=2¹⁷, r=8, p=1) | back office (password session) |
| TOTP (optional, can be required for finance) | anyone with a password | AES-256-GCM encrypted secret | second factor |
| PIN (4–8 digits) | everyone | server: AES-GCM-encrypted PBKDF2 key; devices: salt + HMAC check value | quick sign-in on enrolled terminals, signing everyday changes |
| Approval key (from the password, PBKDF2 600k) | anyone with a password | server: AES-GCM-encrypted key; devices: salt + check value | signing money/timesheet overrides on terminals, offline too |
| Device token | enrolled terminals | SHA-256 hash; client holds it as an `HttpOnly` cookie | terminal transport auth |
| Session token | password sessions | SHA-256 hash; `HttpOnly; Secure; SameSite=Strict` browser-session cookie | back office; 30 min idle (background sync doesn't count) / 12 h absolute; never resumed on an enrolled terminal |

`APP_SECRET` (env, or generated into `data/.secret` on first run) derives the encryption key
for TOTP secrets, PIN keys and pay rates. It must be backed up with the database.

### 5.2 Authenticating every change
- **PIN-signed** mutation (`kid: "pin"`): `sig = HMAC-SHA256(pinKey, mid|collection|id|op|at|sha256(data))`.
  The PIN key is derived on the terminal from the PIN (PBKDF2-SHA256, 200k iterations) and
  held in memory only while that person is signed in. The server verifies with its stored
  copy. Accepted only over an enrolled-device connection. Grants **PIN-level** permissions
  (sensitive permissions stripped).
- **Approval-key** mutation (`kid: "pwd"`): signed with the key derived from the approver's
  *password*. Grants **strong** level: everything except sensitive permissions. Money and
  timesheet overrides (`ELEVATED`: void, discount, price, refund, timesheet edits) need at least
  this level — a PIN can never unlock them, because PINs are short and a stolen terminal could be
  used to guess them offline.
- **Session** mutation (no signature): accepted only if the request carries a valid password
  session for the same actor. Grants full permissions of the user's group.
- Outcomes are stored per mutation id: a re-sent change gets the same answer, and a rejection
  only returns the server's copy after the actor is authenticated (filtered like a pull).
- Self clock-in/out must be stamped within 2 minutes of the signed action time. Shifts can't
  overlap or exceed 24 h. Punches that reach the server more than 10 minutes late (made offline)
  still count but are flagged `review` until a manager edits them.
- Sale and payment times are the signed action time (never a free client field); sales or
  payments synced more than 6 h late are audited as late.
- **Manager override:** when the signed-in person lacks a permission (void, discount, price,
  refund), someone who has it enters *their* PIN on the same screen; that one change is signed
  by — and audited as — the approver. Sensitive permissions are never reachable this way.

### 5.3 Authorisation rules (server, per collection)
- `orders`: create/edit open → `pos.use`; discount change → `orders.discount`; →void
  → `orders.void`; →paid → `payments.take` *and* server recomputes totals and requires
  payments ≥ total; editing a closed order is rejected; reopening → `payments.refund`.
- `orderItems`: parent order must be open; add/edit → `pos.use`; price ≠ menu price →
  `orders.price`; voiding or editing a sent item → `orders.void` with a reason; deleting is
  allowed only before it is sent to the kitchen; `sent → ready` → `kitchen.view`.
- `users` / `groups` (API): actor rank must be **strictly greater** than the target's old and
  new rank; granted permissions ⊆ actor's permissions; owners can only be edited by
  themselves and can't demote/deactivate themselves → there is always an owner.
- Sensitive permissions: `staff.manage`, `finance.view`, `finance.manage`, `settings.manage`,
  `devices.manage`, `audit.view` — never granted to PIN-level actors.

### 5.4 Transport & browser hardening
- Strict CSP (`default-src 'self'`; `img-src 'self' data: blob:`; `object-src 'none'`;
  `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: camera=(self)`, HSTS in production, `Cache-Control: no-store` on API.
- State-changing requests must carry an `Origin` matching the host (CSRF) and JSON content
  type; body limit 1 MB.
- Rate limiting: 10 credential attempts / 15 min per IP; 5 failures locks an account for
  15 min; generic error messages; dummy hash for unknown users (no enumeration by timing).
- Setup wizard requires a one-time **setup code** printed in the server log (or
  `SETUP_CODE` env), so a fresh cloud deployment can't be claimed by a stranger.

### 5.5 Finance data
- Pay rates are encrypted at rest (AES-256-GCM) and served only by `/api/finance/*` to
  password sessions with `finance.view` (and TOTP if required).
- Terminals never receive pay rates or more than `historyDays` of orders.
- On a manager's device, downloaded finance data lives only in an encrypted **vault**
  (AES-GCM, key = PBKDF2-SHA256(password, per-device salt, 600k iterations), key kept in
  memory only). Offline, the manager unlocks it with their password to view reports
  read-only; there is no stored password verifier — a wrong password simply fails to decrypt.

### 5.6 Threats considered
| Threat | Mitigation |
|---|---|
| Staff opens dev tools on a terminal and edits a request to act as a manager | Every change is HMAC-signed by the acting person's key; overrides need a password-derived key; sensitive permissions need a server session |
| Staff copies a terminal's data and brute-forces a manager's PIN offline | A PIN only grants everyday actions; voids/discounts/refunds/timesheets need the password-derived key |
| A manager forgets to sign out of a shared terminal | Idle lock; logout retried until it reaches the server; sessions never resume on terminals; browser-session cookie |
| Back-dated punches or sales | Punch time checks, 24 h cap, overlap checks, late-sync review flags and late-sale audit entries |
| Stolen terminal | Revoke the device (instant); terminal holds no pay data or history; PIN keys in memory only |
| Stolen manager laptop | Finance cache encrypted with password-derived key; sessions expire; revocable |
| XSS | Strict CSP, React escaping, no `dangerouslySetInnerHTML`, cookies `HttpOnly` |
| CSRF | `SameSite=Strict` + Origin check + JSON-only |
| Credential stuffing / brute force | Rate limit, lockout, scrypt, optional TOTP |
| Privilege escalation via staff editor | Rank + permission-subset rules on the server |
| Replay of captured changes | Mutation ids are single-use; signature covers id and payload |
| Tampered totals | Server recomputes order totals at close from its own copy of the lines |
| DB leak | Passwords scrypt-hashed, secrets/pay rates encrypted with `APP_SECRET` (not in DB) |

## 6. Reports maths

- **Business day** of an instant = its local date in the business timezone, minus one day if
  the local hour is before `dayStartHour` (DST-safe).
- **Revenue** (per business day of `closedAt`): gross = Σ paid order totals; tax; service;
  discounts; **net sales** = gross − tax − service; tips and tender mix from payments.
- **Labour:** minutes = clockOut − clockIn − breakMin (open shifts count to "now" and are
  flagged). Rate = the employee's latest rate with `effectiveFrom ≤ shift day`. Overtime:
  per employee per week, minutes past the threshold (chronologically) are paid at the
  multiplier. Cost rounded per shift.
- **Daily ledger:** net sales, service, labour cost, labour % (labour ÷ (net + service)),
  **profit after labour** = net + service − labour, orders, average ticket, hours.
- **Weekly report:** 7-day ledger + totals + best/worst day + per employee (shifts, hours,
  regular/OT hours, rate, pay due) + missing-rate / open-shift warnings. CSV + print-to-PDF.

## 7. UI system

Brand: `shared/theme.ts` turns the venue's brand (preset or custom colour, background tone,
heading typeface, corners, logo) into a full token set for dark and light themes. Accents are
adjusted in OKLCH until every text pair meets WCAG AA; `test/theme.test.ts` checks every preset
and a set of hostile custom colours. The brand syncs in `settings.brand` and is cached locally so
the first paint is already on-brand.

Driven by `docs/research/ui-ux.md`:
- Tokens (`:root` custom properties) for colour (dark default for terminals + light theme),
  type scale, spacing, radii, elevation, motion.
- **Fluid root size**: `html { font-size: clamp(...) }` so every rem-sized element grows from
  phones to 4K TVs; extra step-ups at ≥ 1920 px and ≥ 2560 px.
- Layout: phone → bottom tab bar, single column; tablet → collapsible rail; desktop/TV →
  sidebar + content with container queries for grids (menu grid, table grid, KDS tickets).
- Touch targets ≥ 48 px; primary POS item buttons larger. Tabular numerals for money/time.
- Status = colour + icon + text. `aria-live` for totals and toasts. `prefers-reduced-motion`.

## 8. Delivery phases

| # | Phase |
|---|---|
| 1 | Requirements and this plan |
| 2 | UI/UX research → token spec |
| 3 | `shared/` + server + tests |
| 4 | Client foundation: Dexie, sync engine, session/PIN/vault, app shell, UI kit, setup/lock/login screens |
| 5 | Reference modules: Floor, Order + payment, Kitchen, Time clock |
| 6 | Feature modules, one folder each: Reservations · Staff + attendance · Reports · Settings + audit |
| 7 | Integration, offline/sync/permission tests in the browser at phone/tablet/desktop/TV sizes |
| 8 | Independent security review + fixes |
| 9 | README, deployment guide (TLS reverse proxy, backups), "extend the template" guide |
| 10 | Brand theming: presets, logo colours, neutrals, heading fonts, corners, AA-checked tokens |

## 9. Testing

- `node --test`: money maths (inclusive/exclusive tax, discount caps, rounding), business
  day across midnight/DST, overtime allocation, report totals vs hand-calculated fixtures,
  `can()` and rank rules, scrypt/TOTP/HMAC/AES helpers, and an API test that boots the server
  on a temp DB and proves a Staff/PIN actor is refused finance, staff and settings writes.
- Browser: setup → enrol → PIN → order → offline edits → reconnect → second tab sees changes.

## 10. Trade-offs (deliberate)

- **Single venue per deployment.** Each business runs its own instance (strong isolation,
  simple). Multi-venue/multi-tenant = Postgres + a tenant column, later.
- **Last-write-wins per document.** Good enough because order lines are separate documents;
  field-level merge can be added if two people edit the same order header at once.
- **Credential and staff/group changes need a live server connection** (they *are*
  security operations). Everything on the floor works offline.
- **PIN sign-ins happen on the terminal**, so failed-PIN lockout is per device. PINs are
  inherently low-entropy: someone with a copy of a terminal's data could guess a *staff* PIN
  offline and act as that staff member for everyday actions (orders, their punches). Overrides and
  back-office access are out of reach. Encourage 6-digit PINs.
- **No card processing.** Shiftab records tenders; integrating a card terminal is a module.
- **Offline password unlock is read-only** (cached reports); writes from it wait for a real
  session.
