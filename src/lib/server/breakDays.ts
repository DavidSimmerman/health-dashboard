import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { breakDays } from '$lib/server/db/schema';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

// The two kinds of granted day. See the `breakDays` table comment in db/schema.ts —
// 'maintenance' still logs food, 'mental_health' logs nothing and gets an imputed surplus.
export type GrantedDayKind = 'maintenance' | 'mental_health';

// A date → boolean predicate for one kind, same shape as loadIsVacation: loaded once per
// request, then a cheap in-memory Set lookup. One row per granted day (≈64/year across
// both kinds) so reading them all is cheaper than a per-date query.
async function loadIsKind(kind: GrantedDayKind): Promise<(date: string) => boolean> {
	const rows = await db
		.select({ date: breakDays.date })
		.from(breakDays)
		.where(eq(breakDays.kind, kind));
	if (!rows.length) return () => false;
	const set = new Set(rows.map((r) => r.date));
	return (date: string) => set.has(date);
}

export const loadIsBreakDay = () => loadIsKind('maintenance');
export const loadIsMentalHealthDay = () => loadIsKind('mental_health');

// Mark / unmark `date` as this week's break day. One per calendar week (Sun–Sat), so
// marking a second day MOVES the break instead of failing — that's the useful outcome
// when plans change. Tapping the day that's already the break clears it. Returns the
// new state. Throws on a malformed date (weekToDate validates).
// Scoped to kind='maintenance' throughout: a mental health day in the same week is a
// separate budget and must survive the week-clearing delete below.
// ponytail: delete-then-insert, not a transaction — single-user app. A double-tap is
// the realistic race and onConflictDoNothing keeps it from erroring; the remaining
// ceiling is two tabs marking DIFFERENT days at once, which can leave two in a week
// (one tap fixes it). Wrap in a transaction with a lock only if that ever happens.
export async function toggleBreakDay(date: string): Promise<boolean> {
	const from = weekToDate(date).from; // Sunday of that week
	const to = addDays(from, 6);
	const inWeek = and(
		eq(breakDays.kind, 'maintenance'),
		gte(breakDays.date, from),
		lte(breakDays.date, to)
	);
	const existing = await db.select({ date: breakDays.date }).from(breakDays).where(inWeek);
	const on = !existing.some((r) => r.date === date);
	await db.delete(breakDays).where(inWeek);
	if (on) {
		// onConflictDoUpdate, not DoNothing: `existing` only sees maintenance rows, so a date
		// that's currently a MENTAL HEALTH day reads as unmarked here and the delete above
		// (also maintenance-only) leaves it in place — DoNothing would swallow the insert and
		// the tap would appear to do nothing. Converting is the right outcome, and mirrors
		// toggleMentalHealthDay going the other way.
		await db
			.insert(breakDays)
			.values({ date, kind: 'maintenance' })
			.onConflictDoUpdate({ target: breakDays.date, set: { kind: 'maintenance' } });
	}
	return on;
}

// Mark / unmark `date` as a mental health day: nothing logged, intake imputed, excluded
// from scoring. Deliberately has NO hard cap — refusing the day you take because you're
// struggling is the wrong behaviour. Instead it reports how many are used in that calendar
// month so the UI can warn past the first. Returns the new state plus that count (already
// accounting for this toggle). Throws on a malformed date.
export async function toggleMentalHealthDay(
	date: string
): Promise<{ on: boolean; usedThisMonth: number }> {
	// Round-trip the parse, don't just check it succeeded: Date happily NORMALISES an
	// impossible-but-well-formed label — '2026-02-31' parses fine and becomes March 3 —
	// which would store a row under a date the day view can never show. Comparing the
	// re-formatted date back to the input is what actually rejects it.
	const parsed = new Date(`${date}T00:00:00Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== date
	)
		throw new Error(`Bad date: ${date}`);
	const month = date.slice(0, 7);
	// Dates are fixed-width 'YYYY-MM-DD' text, so a plain string range bounds the month:
	// no real date sorts above 'YYYY-MM-31', including in short months.
	const inMonth = and(
		eq(breakDays.kind, 'mental_health'),
		gte(breakDays.date, `${month}-01`),
		lte(breakDays.date, `${month}-31`)
	);
	const existing = await db.select({ date: breakDays.date }).from(breakDays).where(inMonth);
	const on = !existing.some((r) => r.date === date);
	if (on) {
		// onConflictDoUpdate, not DoNothing: the date may already be this week's
		// maintenance break, and marking it a mental health day should CONVERT it —
		// the PK is the date, so the two kinds can never both hold it.
		await db
			.insert(breakDays)
			.values({ date, kind: 'mental_health' })
			.onConflictDoUpdate({ target: breakDays.date, set: { kind: 'mental_health' } });
	} else {
		await db.delete(breakDays).where(eq(breakDays.date, date));
	}
	return { on, usedThisMonth: on ? existing.length + 1 : existing.length - 1 };
}
