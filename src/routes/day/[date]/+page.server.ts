import { error, fail } from '@sveltejs/kit';
import { sql, eq, asc, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	dailyLog,
	foods,
	bodyComp,
	workouts,
	dailyMetrics,
	glucoseReadings,
	insulinEvents,
	pumpGlucose
} from '$lib/server/db/schema';
import { correctedDeficitDays } from '$lib/server/energyBreakdown';
import { fillBmrGaps } from '$lib/server/projections';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { addDays, fallbackWorkoutKcal } from '$lib/energy';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';
import { loadIsBreakDay, toggleBreakDay } from '$lib/server/breakDays';

// Well-formed AND real: '2026-02-31' is well-formed but rolls into March, and an
// invalid Date would throw on toISOString — so check getTime() before round-tripping.
const isDate = (d: unknown): d is string => {
	if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
	const parsed = new Date(`${d}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
};

export async function load({ params }) {
	const { date } = params;
	// Round-trip through Date so impossible-but-well-formed values (2026-02-31)
	// 404 cleanly instead of blowing up in Postgres' ::date cast (same guard as /goals).
	if (!isDate(date)) throw error(404, 'bad date');
	// No future days — deficitDays would synthesize a BMR-only "deficit" against
	// zero intake, which is fake data, not a real day.
	const today = todayLabel();
	if (date > today) throw error(404, 'future date');

	const logDate = sql<string>`(${dailyLog.loggedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const workoutDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const compDate = sql<string>`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	// Minute-of-day (0–1439) in local time, so the intraday chart needs no tz math.
	const glucoseMin = sql<number>`(extract(hour from (${glucoseReadings.at} at time zone ${APP_TZ})) * 60 + extract(minute from (${glucoseReadings.at} at time zone ${APP_TZ})))::int`;
	const insulinMin = sql<number>`(extract(hour from (${insulinEvents.at} at time zone ${APP_TZ})) * 60 + extract(minute from (${insulinEvents.at} at time zone ${APP_TZ})))::int`;
	const pumpGlucoseMin = sql<number>`(extract(hour from (${pumpGlucose.at} at time zone ${APP_TZ})) * 60 + extract(minute from (${pumpGlucose.at} at time zone ${APP_TZ})))::int`;

	const [[day], entries, [weighIn], workoutRows, metrics, dexcomGlucose, insulin, pumpGlucoseRows] =
		await Promise.all([
			// Energy ledger for the single day, with interpolated BMR filled in.
			(async () => fillBmrGaps(await correctedDeficitDays(date, date)))(),
			// Everything eaten that day, oldest first.
			db
				.select({
					id: dailyLog.id,
					name: foods.name,
					brand: foods.brand,
					servings: dailyLog.servings,
					amount: dailyLog.amount,
					unit: dailyLog.unit,
					loggedAt: dailyLog.loggedAt,
					calories: dailyLog.calories,
					proteinG: dailyLog.proteinG,
					carbsG: dailyLog.carbsG,
					fatG: dailyLog.fatG,
					foodNutrients: foods.nutrients,
					foodIngredients: foods.ingredients,
					foodMakesServings: foods.makesServings
				})
				.from(dailyLog)
				.innerJoin(foods, eq(dailyLog.foodId, foods.id))
				.where(sql`${logDate} = ${date}::date`)
				.orderBy(asc(dailyLog.loggedAt)),
			// Latest weigh-in on/before this day.
			db
				.select({
					weightKg: bodyComp.weightKg,
					bodyFatPct: bodyComp.bodyFatPct,
					leanMassKg: bodyComp.leanMassKg,
					measuredAt: bodyComp.measuredAt,
					measuredDate: sql<string>`${compDate}::text`, // local (APP_TZ) date, matches server selection
					source: bodyComp.source
				})
				.from(bodyComp)
				.where(sql`${compDate} <= ${date}::date`)
				.orderBy(desc(bodyComp.measuredAt))
				.limit(1),
			// Workouts that started that day.
			db
				.select({
					hkUuid: workouts.hkUuid,
					name: workouts.name,
					startedAt: workouts.startedAt,
					endedAt: workouts.endedAt,
					kcal: workouts.kcal,
					avgHr: workouts.avgHr,
					maxHr: workouts.maxHr,
					distanceKm: workouts.distanceKm
				})
				.from(workouts)
				.where(sql`${workoutDate} = ${date}::date`)
				.orderBy(asc(workouts.startedAt)),
			// Daily vitals (water, HR, HRV, …) for that day.
			db
				.select({ metric: dailyMetrics.metric, value: dailyMetrics.value })
				.from(dailyMetrics)
				.where(eq(dailyMetrics.date, date)),
			// Dexcom CGM trace for the day (intraday glucose curve).
			db
				.select({ min: glucoseMin, mgdl: glucoseReadings.mgdl })
				.from(glucoseReadings)
				.where(eq(glucoseReadings.date, date))
				.orderBy(asc(glucoseReadings.at)),
			// Tandem insulin trace: basal-rate samples + boluses for the day.
			db
				.select({
					min: insulinMin,
					kind: insulinEvents.kind,
					units: insulinEvents.units,
					bolusType: insulinEvents.bolusType,
					carbs: insulinEvents.carbs,
					bg: insulinEvents.bg,
					requested: insulinEvents.requested
				})
				.from(insulinEvents)
				.where(eq(insulinEvents.date, date))
				.orderBy(asc(insulinEvents.at)),
			// Pump-reported CGM (fallback glucose source when Dexcom isn't connected).
			db
				.select({ min: pumpGlucoseMin, mgdl: pumpGlucose.mgdl })
				.from(pumpGlucose)
				.where(eq(pumpGlucose.date, date))
				.orderBy(asc(pumpGlucose.at))
		]);

	// One glucose source on the chart: prefer Dexcom (authoritative, gap-free),
	// fall back to the pump's own CGM log for the day when Dexcom has nothing.
	const glucose = dexcomGlucose.length ? dexcomGlucose : pumpGlucoseRows;

	const fiberMode = await getFiberMode();
	const breakDay = (await loadIsBreakDay())(date);
	const entriesWithBolusable = entries.map((e) => {
		const b = bolusableForLoggedEntry(
			e.carbsG,
			{
				nutrients: e.foodNutrients,
				ingredients: e.foodIngredients,
				makesServings: e.foodMakesServings
			},
			e.servings ?? 1,
			{ fiberMode }
		);
		return { ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
	});

	// A workout the tracker logged without any calories shows OUR estimate rather than a blank,
	// via the same helper the energy ledger trusts, so the two can't drift apart in METHOD.
	// ponytail: the ledger scales by the CURRENT trend weight (one value across its window);
	// this uses the weigh-in as of the day being viewed, so an old day can differ by the weight
	// drift since — a couple of percent, under the estimate's own error. Not worth a second
	// resolveCorrection() pass on every day-page load; revisit if the numbers ever visibly split.
	const workoutsWithKcal = workoutRows.map((w) => ({
		...w,
		estimated: w.kcal == null,
		kcal:
			w.kcal ??
			fallbackWorkoutKcal({
				name: w.name,
				distanceKm: w.distanceKm,
				minutes: w.endedAt ? (w.endedAt.getTime() - w.startedAt.getTime()) / 60_000 : null,
				weightKg: weighIn?.weightKg ?? null
			})
	}));

	return {
		date,
		day,
		entries: entriesWithBolusable,
		weighIn: weighIn ?? null,
		workouts: workoutsWithKcal,
		metrics,
		glucose,
		insulin,
		prevDate: addDays(date, -1),
		nextDate: addDays(date, 1),
		today,
		breakDay
	};
}

export const actions = {
	// Mark/unmark this day as the week's break day (eat at maintenance). The date comes
	// from the URL, not the form, so it can't be pointed at some other day; still
	// validated because params are user input.
	toggleBreak: async ({ params }) => {
		if (!isDate(params.date)) return fail(400, { breakError: 'Bad date.' });
		if (params.date > todayLabel()) return fail(400, { breakError: 'That day is in the future.' });
		return { breakDay: await toggleBreakDay(params.date) };
	}
};
