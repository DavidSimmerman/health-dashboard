import { sql, and, gte, lte, asc, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyLog, activityDays, bodyComp, settings, workouts } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import {
	katchMcArdleBmr,
	mifflinBmr,
	tefKcal,
	ageOn,
	correctActive,
	isUncountedWorkout
} from '$lib/energy';

// One day of the energy ledger. `burnedKcal`/`deficitKcal` are null when we
// can't estimate expenditure (no body comp ever synced AND no Apple basal) —
// the UI shows those days as "no data" rather than a fake zero.
export type DayEnergy = {
	date: string; // YYYY-MM-DD in APP_TZ
	intakeKcal: number;
	proteinG: number;
	bmrKcal: number | null; // our BMR (Katch-McArdle or Mifflin)
	bmrSource: 'katch' | 'mifflin' | 'apple-basal' | 'interpolated' | null;
	activeKcal: number | null;
	tefKcal: number;
	burnedKcal: number | null;
	deficitKcal: number | null; // positive = deficit
	weightKg: number | null; // latest weigh-in on/before this day
};

// A resolved active-energy correction + dynamic today-target, applied only when
// passed. Computed once by resolveCorrection() (energyBreakdown.ts) and threaded
// in, so the calibration path keeps calling deficitDays RAW (no correction) and
// can't recurse into its own output.
export type DayCorrection = {
	factor: number; // haircut on Apple's PASSIVE active (1 = none)
	trustedByDate: Map<string, number>; // date → dedicated (workout/pad) kcal, ridden at 1.0
	todayTargetKcal: number | null; // dynamic calorie target for today's effective intake
};

// Per-day energy ledger for [fromDate, toDate] inclusive (YYYY-MM-DD, APP_TZ).
// Callers that already hold the (single-row) settings can pass it to skip a query.
export async function deficitDays(
	fromDate: string,
	toDate: string,
	opts?: { settingsRow?: typeof settings.$inferSelect | null; correction?: DayCorrection }
): Promise<DayEnergy[]> {
	const logDate = sql<string>`(${dailyLog.loggedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;

	const [intakeRows, activityRows, compInRange, compBefore, settingsRows, workoutRows] =
		await Promise.all([
			db
				.select({
					date: sql<string>`${logDate}::text`,
					calories: sql<number>`sum(${dailyLog.calories})::float`,
					proteinG: sql<number>`sum(${dailyLog.proteinG})::float`,
					carbsG: sql<number>`sum(${dailyLog.carbsG})::float`,
					fatG: sql<number>`sum(${dailyLog.fatG})::float`
				})
				.from(dailyLog)
				.where(sql`${logDate} between ${fromDate}::date and ${toDate}::date`)
				// Group by ordinal: repeating the expression would re-bind APP_TZ as a
				// new parameter, which Postgres then treats as a different expression.
				.groupBy(sql`1`),
			db
				.select()
				.from(activityDays)
				.where(and(gte(activityDays.date, fromDate), lte(activityDays.date, toDate))),
			// Weigh-ins inside the range…
			db
				.select()
				.from(bodyComp)
				.where(
					sql`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date between ${fromDate}::date and ${toDate}::date`
				)
				.orderBy(asc(bodyComp.measuredAt)),
			// …plus the single latest one before it, so every day still carries the
			// latest measurement on/before it forward — without loading the entire
			// weigh-in history on every call like this used to.
			db
				.select()
				.from(bodyComp)
				.where(
					sql`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date < ${fromDate}::date`
				)
				.orderBy(desc(bodyComp.measuredAt))
				.limit(1),
			opts?.settingsRow !== undefined
				? Promise.resolve(opts.settingsRow ? [opts.settingsRow] : [])
				: db
						.select()
						.from(settings)
						.where(sql`${settings.id} = 1`),
			// Workout kcal, to spot the ones Apple never folded into its daily active total.
			db
				.select({ date: sql<string>`${woDate}::text`, kcal: workouts.kcal })
				.from(workouts)
				.where(sql`${woDate} between ${fromDate}::date and ${toDate}::date`)
		]);
	const settingsRow = settingsRows[0];
	const compRows = [...compBefore, ...compInRange];

	const intakeByDate = new Map(intakeRows.map((r) => [r.date, r]));
	const activityByDate = new Map(activityRows.map((r) => [r.date, r]));

	// A manually entered workout writes no activeEnergyBurned samples, so its kcal is missing from
	// Apple's daily total — provable when it claims more than the whole day (isUncountedWorkout).
	// Add those in so the day's active reflects everything that was actually logged. Unconditional:
	// the raw ledger, the corrected view, and the calibration that learns off them must agree.
	const uncountedByDate = new Map<string, number>();
	for (const w of workoutRows) {
		if (!isUncountedWorkout(w.kcal, activityByDate.get(w.date)?.activeKcal ?? null)) continue;
		uncountedByDate.set(w.date, (uncountedByDate.get(w.date) ?? 0) + (w.kcal ?? 0));
	}

	const compFmt = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ });
	const compByDate = compRows.map((c) => ({
		date: compFmt.format(c.measuredAt),
		...c
	}));

	// Today is still in progress: assume you'll eat up to your calorie target if you're
	// under it, so the deficit goal reflects where the day will land — not a phantom
	// huge deficit from a half-logged day. Already over target → use actual. Past days
	// always use actual intake.
	const today = todayLabel();
	const calorieTarget = settingsRow?.calorieTarget ?? 2100;
	const correction = opts?.correction;

	const days: DayEnergy[] = [];
	// compByDate is ascending; walk it once with a pointer instead of a
	// clone+reverse+find per day (was O(days × weigh-ins)).
	let compIdx = -1;
	for (const date of dateRange(fromDate, toDate)) {
		const intake = intakeByDate.get(date);
		const activity = activityByDate.get(date);
		// Latest weigh-in on/before this day.
		while (compIdx + 1 < compByDate.length && compByDate[compIdx + 1].date <= date) compIdx++;
		const comp = compIdx >= 0 ? compByDate[compIdx] : null;

		const intakeKcal = intake?.calories ?? 0;
		const tef = intake ? tefKcal(intake.proteinG, intake.carbsG, intake.fatG) : 0;

		// BMR preference: Katch-McArdle (needs lean mass or bf%) → Mifflin
		// (needs weight + profile) → Apple's basal estimate → null.
		let bmr: number | null = null;
		let bmrSource: DayEnergy['bmrSource'] = null;
		if (comp) {
			const lean =
				comp.leanMassKg ??
				(comp.bodyFatPct != null ? comp.weightKg * (1 - comp.bodyFatPct / 100) : null);
			if (lean != null) {
				bmr = katchMcArdleBmr(lean);
				bmrSource = 'katch';
			} else if (settingsRow?.heightCm && settingsRow?.birthDate && settingsRow?.sex) {
				bmr = mifflinBmr(
					comp.weightKg,
					settingsRow.heightCm,
					ageOn(date, settingsRow.birthDate),
					settingsRow.sex as 'male' | 'female'
				);
				bmrSource = 'mifflin';
			}
		}
		if (bmr == null && activity?.basalKcal != null) {
			bmr = activity.basalKcal;
			bmrSource = 'apple-basal';
		}

		// Corrected active when a correction is supplied: dedicated workout kcal ride
		// at 1.0, only Apple's passive estimate gets the haircut. Raw path unchanged.
		// Apple's daily active + any workout kcal it never included (null activeKcal but a workout
		// present still counts — the workout is real data even if the daily aggregate didn't sync).
		const uncounted = uncountedByDate.get(date) ?? 0;
		// Trusted kcal (pad / distance / estimated workouts) are themselves evidence the day had
		// active energy, so they alone are enough to open the day's account. Without this a day
		// whose daily aggregate never synced stays null and drops the workout from burn entirely —
		// correctActive would have counted it, but it was never reached. Correction-only: on the
		// raw path trusted is always 0, so `rawActive` keeps its old meaning.
		const trusted = correction?.trustedByDate.get(date) ?? 0;
		const rawActive =
			activity?.activeKcal != null || uncounted > 0 || trusted > 0
				? (activity?.activeKcal ?? 0) + uncounted
				: null;
		const active =
			correction && rawActive != null
				? correctActive(rawActive, trusted, correction.factor)
				: rawActive;
		const burned = bmr != null ? bmr + (active ?? 0) + tef : null;
		// Predicted intake for the deficit: today, eat at least to target; else actual.
		const targetToday = correction?.todayTargetKcal ?? calorieTarget;
		const effIntake = date === today ? Math.max(intakeKcal, targetToday) : intakeKcal;

		days.push({
			date,
			intakeKcal,
			proteinG: intake?.proteinG ?? 0,
			bmrKcal: bmr != null ? Math.round(bmr) : null,
			bmrSource,
			activeKcal: active,
			tefKcal: Math.round(tef),
			burnedKcal: burned != null ? Math.round(burned) : null,
			deficitKcal: burned != null ? Math.round(burned - effIntake) : null,
			weightKg: comp?.weightKg ?? null
		});
	}
	return days;
}

function* dateRange(from: string, to: string): Generator<string> {
	// Walk dates as plain UTC noon timestamps so DST can't skip/repeat a day.
	const cursor = new Date(`${from}T12:00:00Z`);
	const end = new Date(`${to}T12:00:00Z`);
	while (cursor <= end) {
		yield cursor.toISOString().slice(0, 10);
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
}
