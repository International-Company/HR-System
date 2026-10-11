import { and, eq, gte, lte } from 'drizzle-orm';
import type { Tx } from '../db/database.js';
import { leavePermission, leaveRequest } from '../db/schema.js';
import { zonedToUtc } from '../attendance/time.js';
import { eachDay } from '../calendar/calendar.service.js';

export interface LeaveCoverage {
  /** Dates covered by approved full-day leave. */
  leaveDates: Set<string>;
  /** Approved in-day permissions per date, as instants. */
  permissions: Map<string, { start: Date; end: Date }[]>;
}

/**
 * Read interface used by attendance (architecture.md §5: attendance only reads leave).
 * Runs in the caller's transaction and row-level security.
 */
export async function leaveCoverage(tx: Tx, employeeId: string, from: string, to: string, tz: string): Promise<LeaveCoverage> {
  const requests = await tx
    .select({ startDate: leaveRequest.startDate, endDate: leaveRequest.endDate })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employeeId, employeeId),
        eq(leaveRequest.status, 'approved'),
        lte(leaveRequest.startDate, to),
        gte(leaveRequest.endDate, from),
      ),
    );
  const leaveDates = new Set<string>();
  for (const r of requests) {
    for (const d of eachDay(r.startDate > from ? r.startDate : from, r.endDate < to ? r.endDate : to)) leaveDates.add(d);
  }
  const perms = await tx
    .select()
    .from(leavePermission)
    .where(
      and(
        eq(leavePermission.employeeId, employeeId),
        eq(leavePermission.status, 'approved'),
        gte(leavePermission.workDate, from),
        lte(leavePermission.workDate, to),
      ),
    );
  const permissions = new Map<string, { start: Date; end: Date }[]>();
  for (const p of perms) {
    const list = permissions.get(p.workDate) ?? [];
    list.push({ start: zonedToUtc(p.workDate, p.startTime.slice(0, 5), tz), end: zonedToUtc(p.workDate, p.endTime.slice(0, 5), tz) });
    permissions.set(p.workDate, list);
  }
  return { leaveDates, permissions };
}
