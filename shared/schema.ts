// Collection schemas + registry. This is the template's main extension point:
// add a collection here (schema + Dexie indexes), give it a rule in server/sync.ts, done —
// offline storage, sync, real-time updates and audit come for free.
import { z } from 'zod';
import { ALL_PERMISSIONS } from './permissions.ts';
import { DEFAULT_BRAND, PRESET_IDS } from './theme.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const opt = (max: number) => z.string().trim().max(max);
const money = z.int().min(0).max(10_000_000_00); // minor units (cents)
const ts = z.int().min(0); // epoch ms
const ref = z.uuid();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const validLocale = (l: string) => { try { new Intl.NumberFormat(l); return true; } catch { return false; } };
const validCurrency = (c: string) => { try { new Intl.NumberFormat('en', { style: 'currency', currency: c }); return true; } catch { return false; } };

/** Business-wide look: palette preset or custom colour, neutrals, heading typeface, corners, logo. */
export const Brand = z.strictObject({
  preset: z.enum([...PRESET_IDS, 'custom']),
  accent: color.nullable(),
  neutral: z.enum(['cool', 'warm', 'neutral']),
  headingFont: z.enum(['modern', 'classic', 'bold']),
  corners: z.enum(['sharp', 'soft', 'round']),
  logo: z.string().max(400_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable(),
});

export const Settings = z.strictObject({
  name: text(80),
  currency: z.string().regex(/^[A-Z]{3}$/).refine(validCurrency, 'Unknown currency'),
  locale: z.string().min(2).max(35).refine(validLocale, 'Unknown locale'),
  timezone: z.string().min(1).max(64).refine(validTz, 'Unknown timezone'),
  taxRateBp: z.int().min(0).max(5000), // basis points: 1000 = 10%
  taxInclusive: z.boolean(),
  serviceChargeBp: z.int().min(0).max(5000),
  dayStartHour: z.int().min(0).max(23),
  weekStartsOn: z.int().min(0).max(6), // 0 = Sunday
  overtimeWeeklyHours: z.number().min(0).max(168), // 0 = overtime off
  overtimeMultiplierPct: z.int().min(100).max(300),
  paymentMethods: z.array(text(24)).min(1).max(10),
  lockAfterSec: z.int().min(15).max(3600),
  historyDays: z.int().min(1).max(14),
  require2faForFinance: z.boolean(),
  receiptFooter: opt(200),
  brand: Brand.default(DEFAULT_BRAND),
});

export const Group = z.strictObject({
  name: text(40),
  rank: z.int().min(1).max(100),
  permissions: z.array(z.enum(ALL_PERMISSIONS)).max(ALL_PERMISSIONS.length)
    .refine((p) => new Set(p).size === p.length, 'Duplicate permission'),
  color,
});

export const User = z.strictObject({
  name: text(60),
  groupId: ref,
  active: z.boolean(),
  color,
  // server-managed (written only by server/staff.ts)
  email: z.string().max(254).nullable(),
  pinSalt: z.string().max(64).nullable(),
  pinCheck: z.string().max(64).nullable(),
  // lets the PIN pad submit on the last digit. Leaks ~nothing: offline guessing tries shorter PINs first anyway
  pinLen: z.number().int().min(4).max(8).nullable().default(null),
  pwdSalt: z.string().max(64).nullable().default(null), // password-derived approval key (see ELEVATED)
  pwdCheck: z.string().max(64).nullable().default(null),
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
});

export const Photo = z.strictObject({
  dataUrl: z.string().max(400_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
});

export const Category = z.strictObject({ name: text(40), sort: z.int(), color });

/** Kitchen station, a sub-role such as Tandoor or Desserts: the menu categories it cooks and who works it. */
export const Station = z.strictObject({ name: text(40), color, categoryIds: z.array(ref).max(100), userIds: z.array(ref).max(500) });

export const Item = z.strictObject({
  name: text(80),
  categoryId: ref,
  price: money,
  active: z.boolean(),
  sort: z.int(),
  sendToKitchen: z.boolean(),
});

export const Area = z.strictObject({ name: text(40), sort: z.int() });

export const Table = z.strictObject({ name: text(12), areaId: ref, seats: z.int().min(1).max(50), sort: z.int() });

export const RESERVATION_STATUS = ['booked', 'seated', 'completed', 'no_show', 'cancelled'] as const;
export const Reservation = z.strictObject({
  name: text(80),
  phone: opt(32),
  partySize: z.int().min(1).max(200),
  start: ts,
  durationMin: z.int().min(15).max(720),
  tableId: ref.nullable(),
  status: z.enum(RESERVATION_STATUS),
  notes: opt(500),
});

export const Totals = z.strictObject({ subtotal: money, discount: money, service: money, tax: money, total: money });

export const Order = z.strictObject({
  number: text(16),
  type: z.enum(['dine_in', 'takeaway']),
  tableId: ref.nullable(),
  guests: z.int().min(0).max(200),
  status: z.enum(['open', 'paid', 'void']),
  discount: z.strictObject({ kind: z.enum(['pct', 'amt']), value: z.int().min(0).max(10_000_000_00) }).nullable(),
  note: opt(500),
  billRequested: z.boolean(),
  openedBy: ref,
  openedAt: ts,
  closedAt: ts.nullable(),
  voidReason: opt(200),
  totals: Totals.nullable(), // server-managed: set when the order is paid
});

export const OrderItem = z.strictObject({
  orderId: ref,
  itemId: ref.nullable(),
  name: text(80),
  unitPrice: money,
  qty: z.int().min(1).max(999),
  note: opt(200),
  status: z.enum(['new', 'sent', 'ready']),
  sentAt: ts.nullable(),
  voided: z.boolean(),
  voidReason: opt(200),
  addedBy: ref,
  addedAt: ts,
});

export const Payment = z.strictObject({
  orderId: ref,
  method: text(24),
  amount: money.min(1),
  tip: money,
  tendered: money.nullable(),
  takenBy: ref,
  at: ts,
});

export const Shift = z.strictObject({
  userId: ref,
  clockIn: ts,
  clockOut: ts.nullable(),
  breakMin: z.int().min(0).max(600),          // unpaid break minutes so far
  breakStart: ts.nullable().default(null),     // on a break since then; its minutes join breakMin when it ends (server-timed)
  note: opt(200),
  review: z.boolean().default(false), // server-managed: punch synced late or shift unusually long — check it
});

/**
 * indexes: Dexie secondary indexes (primary key is always `id`).
 * windowed: terminals only keep open + recently touched docs (settings.historyDays).
 * apiOnly: never written through sync (credentials/rank rules live in dedicated endpoints).
 */
export const COLLECTIONS = {
  settings: { schema: Settings, indexes: '', windowed: false, apiOnly: false },
  groups: { schema: Group, indexes: '', windowed: false, apiOnly: true },
  users: { schema: User, indexes: 'groupId', windowed: false, apiOnly: true },
  photos: { schema: Photo, indexes: '', windowed: false, apiOnly: false },
  categories: { schema: Category, indexes: 'sort', windowed: false, apiOnly: false },
  items: { schema: Item, indexes: 'categoryId', windowed: false, apiOnly: false },
  stations: { schema: Station, indexes: '', windowed: false, apiOnly: false },
  areas: { schema: Area, indexes: 'sort', windowed: false, apiOnly: false },
  tables: { schema: Table, indexes: 'areaId', windowed: false, apiOnly: false },
  reservations: { schema: Reservation, indexes: 'start, tableId', windowed: true, apiOnly: false },
  orders: { schema: Order, indexes: 'status, tableId', windowed: true, apiOnly: false },
  orderItems: { schema: OrderItem, indexes: 'orderId, status', windowed: true, apiOnly: false },
  payments: { schema: Payment, indexes: 'orderId', windowed: true, apiOnly: false },
  shifts: { schema: Shift, indexes: 'userId, clockIn', windowed: true, apiOnly: false },
} as const;

/** Bump when you add a collection or change `indexes` (Dexie needs a new version number). */
export const LOCAL_DB_VERSION = 2;

export type CollectionName = keyof typeof COLLECTIONS;
export const COLLECTION_NAMES = Object.keys(COLLECTIONS) as CollectionName[];

export interface Meta { id: string; updatedAt: number; updatedBy: string }
export type DataOf<C extends CollectionName> = z.output<(typeof COLLECTIONS)[C]['schema']>;
/** What a write may send: fields with server defaults (e.g. shift.review) are optional. */
export type DataIn<C extends CollectionName> = z.input<(typeof COLLECTIONS)[C]['schema']>;
export type Doc<C extends CollectionName> = DataOf<C> & Meta;

export type SettingsDoc = Doc<'settings'>;
export type GroupDoc = Doc<'groups'>;
export type UserDoc = Doc<'users'>;
export type ItemDoc = Doc<'items'>;
export type OrderDoc = Doc<'orders'>;
export type OrderItemDoc = Doc<'orderItems'>;
export type PaymentDoc = Doc<'payments'>;
export type ShiftDoc = Doc<'shifts'>;
export type ReservationDoc = Doc<'reservations'>;
export type TableDoc = Doc<'tables'>;
export type StationDoc = Doc<'stations'>;

/** A queued change as sent to /api/sync/push. */
export const Mutation = z.strictObject({
  mid: z.uuid(),
  collection: z.enum(COLLECTION_NAMES),
  id: z.string().min(1).max(64),
  op: z.enum(['put', 'del']),
  data: z.record(z.string(), z.unknown()).nullable(),
  at: ts,
  actor: ref,
  sig: z.string().max(128).nullable(), // base64 HMAC when signed on a terminal, null for session changes
  kid: z.enum(['pin', 'pwd']).optional(), // which key signed: PIN, or password-derived (manager approvals)
});
export type Mutation = z.infer<typeof Mutation>;

/** PIN key derivation, identical on server (node:crypto) and terminals (WebCrypto). */
export const PIN_ITERATIONS = 200_000;
// These labels keep the project's first name (p0rtal) on purpose: they're mixed into every stored PIN and
// password check, so changing them would lock everyone out.
export const PIN_CHECK_LABEL = 'p0rtal-pin-check';
export const PIN_RE = /^\d{4,8}$/;
export const PWD_ITERATIONS = 600_000;
export const PWD_CHECK_LABEL = 'p0rtal-pwd-check';

/** The exact string a PIN signature covers (see PLAN §5.2). */
export const signingString = (m: Omit<Mutation, 'sig'>, dataHash: string) =>
  [m.mid, m.collection, m.id, m.op, m.at, m.actor, dataHash].join('|');

export const DEFAULT_SETTINGS: z.input<typeof Settings> = {
  name: 'My Venue',
  currency: 'AUD',
  locale: 'en-AU',               // shows AUD as "$" and dates day-first
  timezone: 'Australia/Melbourne',
  taxRateBp: 0,
  taxInclusive: false,
  serviceChargeBp: 0,
  dayStartHour: 4,
  weekStartsOn: 1,
  overtimeWeeklyHours: 0,
  overtimeMultiplierPct: 150,
  paymentMethods: ['Cash', 'Card'],
  lockAfterSec: 120,
  historyDays: 2,
  require2faForFinance: false,
  receiptFooter: 'Thank you!',
  brand: DEFAULT_BRAND,
};
