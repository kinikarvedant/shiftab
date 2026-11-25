# Extending p0rtal

p0rtal is a template: a new feature is a module folder plus (optionally) a new synced
collection. Sync, offline storage, real-time updates, permissions and audit come for free.

## Map of the code

| Path | What it is |
|---|---|
| `shared/schema.ts` | Zod schemas + `COLLECTIONS` registry (Dexie indexes, windowing). Types: `Doc<'orders'>`, `OrderDoc`, … |
| `shared/permissions.ts` | Permission catalogue, `SENSITIVE` set, `can()`, rank rules, default groups |
| `shared/money.ts` | Integer-cents maths: `orderTotals`, `formatMoney`, `parseMoney`, `minorDigits`, `formatBp` |
| `shared/time.ts` | `businessDay`, `weekStart`, `addDays`, `dateRange`, `zonedTime`, `localDate`, `localTime` |
| `shared/report.ts` | `buildReport(dataset, from, to)` → daily ledger + per-employee payroll; `reportCsv` |
| `server/sync.ts` | `RULES`: server-side authorisation per collection |
| `server/*.ts` | Dedicated APIs (auth, staff, finance) |
| `src/lib/db.ts` | Dexie: `table('orders')`, `getMeta/setMeta` |
| `src/lib/sync.ts` | `write(collection, doc, signer?)`, `remove(collection, id, signer?)`, `useSyncState()` |
| `src/lib/session.ts` | `useApp()`, `useCan()`, `getApp()`, `vaultSave/vaultLoad`, `refreshState()` |
| `src/lib/api.ts` | `api(method, path, body?)` for online-only endpoints; `ApiError` (`status 0` = offline), `errorText` |
| `src/lib/format.ts` | `useFmt()` → `money()`, `time()`, `date()`, `dateTime()`, `day('YYYY-MM-DD')`, `today()`, `settings`, `currency`, `tz`; `hoursText`, `elapsedText`, `uuid`, `useNow` |
| `src/lib/router.ts` | `useRoute()`, `go('module/param')` (hash routes) |
| `src/lib/display.ts` | per-device theme/scale: `prefs`, `setPref`, `SCALES`, `WALL_SCALES` |
| `src/lib/photo.ts` | `photoFromFile(file)` → 256px JPEG data URL |
| `src/ui/index.tsx` | `Dialog`, `Avatar`, `Empty`, `PinPad`, `toast`, `ask`, `confirmBox` |
| `src/ui/approve.tsx` | `withApproval(perm, why)` → signer of someone allowed: PIN for everyday permissions, the approver's password for `ELEVATED` ones (void, discount, price, refund, timesheets) |
| `shared/theme.ts` | Brand → tokens: `themeTokens(brand, mode)`, `PRESETS`, `auditTokens` (contrast report) |
| `src/styles.css` | Design tokens + component classes (see below) |
| `src/modules/index.ts` | Module registry (nav, permissions, lazy loading) |

## Data rules

- **Read** local data reactively: `useLiveQuery(() => table('reservations').toArray(), [])`
  from `dexie-react-hooks`. Everything renders from IndexedDB, so it works offline.
- **Write** with `write('collection', { id, ...fields })` — the full document (all schema
  fields; `updatedAt`/`updatedBy` are optional and ignored). It saves locally at once and
  syncs. New ids: `uuid()`. Delete with `remove('collection', id)`.
- The server re-checks every write (`server/sync.ts` `RULES`); a rejected write is rolled back
  locally and the user gets a toast. Check permissions in the UI too, with `useCan()`.
- `users`, `groups`, pay rates, devices, passwords, PINs and 2FA are **API-only** (online):
  use `api(...)`, catch `ApiError` with `status === 0` and tell the user to reconnect.
- Money is **integer minor units** everywhere. Parse input with `parseMoney(text, currency)`,
  display with `fmt.money(minor)`.
- Dates in reports are business days `'YYYY-MM-DD'` in the venue timezone (`fmt.today()`,
  `businessDay(ts, fmt.tz, settings.dayStartHour)`).
- Terminals only keep recent data (`settings.historyDays` for orders, 14 days of shifts).
  Older history comes from the server (`/api/finance/dataset`, `/api/attendance`).

## Online APIs (password sessions only)

| Method & path | Permission | Body / query → result |
|---|---|---|
| `POST /api/staff` | staff.manage | `{name, groupId, color, pin?}` → `{id}` |
| `PATCH /api/staff/:id` | staff.manage (or self: name/color) | `{name?, groupId?, color?, active?}` |
| `POST /api/staff/:id/pin` | staff.manage or self | `{pin}` (4–8 digits) |
| `POST /api/staff/:id/login` | staff.manage | `{email, password}` (gives back-office access) |
| `DELETE /api/staff/:id/login` | staff.manage | removes password + 2FA |
| `POST /api/groups` · `PATCH /api/groups/:id` · `DELETE /api/groups/:id` | staff.manage | `{name, rank, permissions[], color}` |
| `GET /api/finance/rates` | finance.view | `[{id, userId, rateCents, effectiveFrom}]` |
| `POST /api/finance/rates` · `DELETE /api/finance/rates/:id` | finance.manage | `{userId, rateCents, effectiveFrom: 'YYYY-MM-DD'}` |
| `GET /api/finance/dataset?from&to` | finance.view | `Dataset` for `buildReport` (≤ 62 days) |
| `GET /api/attendance?from&to` | any session (timeclock.manage = everyone, else self) | `{shifts}` (≤ 92 days) |
| `GET /api/audit?before=<id>` | audit.view | 100 newest rows `{id, ts, actor, device, action, target, detail(JSON string)}` |
| `GET /api/devices` · `DELETE /api/devices/:id` · `POST /api/devices/enrol` | devices.manage | `{name}` |
| `POST /api/auth/password` | self | `{current, next}` |
| `POST /api/auth/totp/setup` → `{secret, uri}` · `/enable {code}` · `/disable {code}` | self | |
| `GET /api/admin/backup` | settings.manage | downloads a SQLite snapshot |

Rank rules: you can only manage users/groups ranked strictly below you, and only grant
permissions you hold. Show those controls disabled rather than letting the server refuse.

## UI rules

- Page skeleton: `<div className="page"><div className="page-head"><div><h1>…</h1><p>…</p></div>{actions}</div>…</div>`.
- Classes: `btn` (+ `primary`, `success`, `danger`, `danger solid`, `outline`, `ghost`, `sm`, `lg`, `xl`, `icon`, `block`),
  `chip` (`aria-pressed`), `seg` (segmented buttons, `aria-pressed`), `field` (label wrapper with `<span>` caption,
  `hint`, `error`), `form-grid`, `switch` (checkbox), `card` (`pad-lg`), `card-head`, `kpi` (`.label`, `.value`),
  `pill` (`success|warning|danger|info|accent`), `banner` (`warning|danger`), `table-wrap` + `table.data`
  (`td.num`), `empty`, `row` (`between|end|nowrap`), `stack` (`sm|lg`), `grid-auto`, `grid-2`, `action-grid`,
  `muted`, `small`, `xs`, `strong`, `money`/`num` (tabular figures), `code`, `ellipsis`, `sr-only`, `no-print`.
- Tokens only (`var(--surface)`, `var(--accent)`, `var(--space-4)`, `var(--fs-lg)`, `var(--radius-md)` …) — never raw
  colours or px font sizes. Colours are brandable per venue and re-derived for dark/light, so a hex value in a
  module will clash with someone's brand. Headings use `var(--font-heading)` automatically.
  Everything is rem so it scales from phones to TVs.
- Touch targets ≥ `var(--tap)`; never colour alone (icon + text); `aria-label` on icon buttons;
  icons from `lucide-react` with `aria-hidden="true"` when decorative.
- Motion: `var(--dur-fast|base|slow)` with `var(--ease-out)` for things arriving, `var(--ease-in)` for things leaving;
  keep it under 300 ms and don't animate actions staff repeat all shift. Screen changes animate on their own. Put hover-only
  effects inside `@media (hover: hover)`, and give scrolling lists `overscroll-behavior: contain`.
- Module-specific CSS goes in a file inside the module folder, imported by the module.
- Dialogs: `<Dialog open onClose title footer>`; prompts: `await ask({...})`, `await confirmBox({...})`.

## Add a module (checklist)

1. `src/modules/<id>/<Name>.tsx` with `export default function Name({ params }: ModuleProps)`.
2. Register it in `src/modules/index.ts` (`anyOf` permissions, icon, label).
3. New data? Add a schema + entry to `COLLECTIONS` in `shared/schema.ts`, bump `LOCAL_DB_VERSION`,
   and add an authorisation rule to `RULES` in `server/sync.ts`. New permission? Add it to
   `PERMISSIONS` (and `SENSITIVE` if it touches money or people).
4. Add a check to `test/` for any rule that guards money or access.
