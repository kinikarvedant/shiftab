// Permission catalogue + the single authorisation primitive used by client and server.
// Add a permission: add a key here, then reference it from a collection rule or module.

export const PERMISSIONS = {
  'pos.use': 'Take and edit orders',
  'orders.discount': 'Apply discounts',
  'orders.price': 'Override item prices',
  'orders.void': 'Void items and orders',
  'payments.take': 'Take payments',
  'payments.refund': 'Remove payments / reopen paid orders',
  'reservations.manage': 'Manage reservations',
  'kitchen.view': 'Use the kitchen display',
  'timeclock.self': 'Clock in and out',
  'timeclock.manage': "Edit other people's timesheets",
  'menu.manage': 'Edit the menu',
  'floor.manage': 'Edit areas and tables',
  'staff.manage': 'Manage staff, groups and PINs',
  'finance.view': 'View reports and payroll',
  'finance.manage': 'Edit pay rates',
  'settings.manage': 'Change business settings',
  'devices.manage': 'Enrol and revoke devices',
  'audit.view': 'View the audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Never usable from a PIN sign-in: needs a password (+TOTP) session. */
export const SENSITIVE = new Set<Permission>([
  'staff.manage', 'finance.view', 'finance.manage', 'settings.manage', 'devices.manage', 'audit.view',
]);

/**
 * Money and timesheet overrides. A PIN can't unlock them: PINs are short, and terminals can check them
 * offline, so a stolen terminal could be used to guess them. They need the approver's password-derived key
 * ("strong", which also works offline) or a password session.
 */
export const ELEVATED = new Set<Permission>(['orders.void', 'orders.discount', 'orders.price', 'payments.refund', 'timeclock.manage']);

/** pin: PIN-signed · strong: signed with a password-derived key on a terminal · password: server session. */
export type AuthLevel = 'pin' | 'strong' | 'password';

export interface GroupLike { id: string; rank: number; permissions: string[] }
export interface UserLike { id: string; groupId: string; active: boolean }

export function can(
  user: UserLike | undefined,
  group: GroupLike | undefined,
  perm: Permission,
  level: AuthLevel,
): boolean {
  if (!user || !user.active || !group || group.id !== user.groupId) return false;
  if (level !== 'password' && SENSITIVE.has(perm)) return false;
  if (level === 'pin' && ELEVATED.has(perm)) return false;
  return group.permissions.includes(perm);
}

/** Rank rule: you may only manage people/groups strictly below you. */
export const outranks = (actor: GroupLike, target: GroupLike) => actor.rank > target.rank;

/** Granting rule: a group may only be given permissions the actor holds. */
export const canGrant = (actor: GroupLike, perms: string[]) => perms.every((p) => actor.permissions.includes(p));

const POS: Permission[] = ['pos.use', 'payments.take', 'reservations.manage', 'timeclock.self'];

export const DEFAULT_GROUPS = [
  { key: 'owner', name: 'Owner', rank: 100, color: '#a78bfa', permissions: ALL_PERMISSIONS },
  {
    key: 'manager', name: 'Manager', rank: 80, color: '#60a5fa',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'settings.manage'),
  },
  {
    key: 'supervisor', name: 'Supervisor', rank: 60, color: '#34d399',
    permissions: [...POS, 'orders.discount', 'orders.void', 'payments.refund', 'kitchen.view', 'timeclock.manage'] as Permission[],
  },
  { key: 'staff', name: 'Staff', rank: 20, color: '#fbbf24', permissions: POS },
  { key: 'kitchen', name: 'Kitchen', rank: 10, color: '#f87171', permissions: ['kitchen.view', 'timeclock.self'] as Permission[] },
];
