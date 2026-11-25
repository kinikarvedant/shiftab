// Module registry — the template's UI extension point.
// Add a feature: create src/modules/<id>/<Name>.tsx (default export), add one entry here.
// `anyOf`: the module shows for anyone holding at least one of these permissions ([] = everyone).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { BarChart3, CalendarClock, ChefHat, Clock, LayoutGrid, ScrollText, Settings, Users, Receipt, type LucideIcon } from 'lucide-react';
import type { Permission } from '../../shared/permissions.ts';

export interface ModuleProps { params: string[] }
export interface ModuleDef {
  id: string;
  label: string;
  icon: LucideIcon;
  anyOf: Permission[];
  component: LazyExoticComponent<ComponentType<ModuleProps>>;
  nav?: boolean;   // false = reachable by link only (e.g. an order)
  wall?: boolean;  // big-screen layout (kitchen display / TV)
}

export const MODULES: ModuleDef[] = [
  { id: 'floor', label: 'Floor', icon: LayoutGrid, anyOf: ['pos.use'], component: lazy(() => import('./floor/Floor.tsx')) },
  { id: 'order', label: 'Order', icon: Receipt, anyOf: ['pos.use'], component: lazy(() => import('./order/Order.tsx')), nav: false },
  { id: 'kitchen', label: 'Kitchen', icon: ChefHat, anyOf: ['kitchen.view'], component: lazy(() => import('./kitchen/Kitchen.tsx')), wall: true },
  { id: 'reservations', label: 'Bookings', icon: CalendarClock, anyOf: ['reservations.manage'], component: lazy(() => import('./reservations/Reservations.tsx')) },
  { id: 'time', label: 'Time', icon: Clock, anyOf: ['timeclock.self', 'timeclock.manage'], component: lazy(() => import('./timeclock/Timeclock.tsx')) },
  { id: 'staff', label: 'Staff', icon: Users, anyOf: ['staff.manage'], component: lazy(() => import('./staff/Staff.tsx')) },
  { id: 'reports', label: 'Reports', icon: BarChart3, anyOf: ['finance.view'], component: lazy(() => import('./reports/Reports.tsx')) },
  { id: 'audit', label: 'Audit', icon: ScrollText, anyOf: ['audit.view'], component: lazy(() => import('./audit/Audit.tsx')) },
  { id: 'settings', label: 'Settings', icon: Settings, anyOf: [], component: lazy(() => import('./settings/Settings.tsx')) },
];
