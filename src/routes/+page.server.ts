import { db } from '$lib/server/db';
import { dailyLog, foods, quickAdds, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { loggedToday, todayLabel } from '$lib/server/day';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { fiberModeFrom } from '$lib/server/prefs';
import { deficitDays } from '$lib/server/deficit';
import { resolveCorrection } from '$lib/server/energyBreakdown';
import { dayMetricsForRange, loadScoringSpecs } from '$lib/server/goals';
import { scoreDay, weekBalances } from '$lib/score';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

export async function load() {
	const today = todayLabel();
	const weekStart = weekToDate(today).from;

	// One settings read per load: fiber mode is derived from the row and the row
	// is handed to deficitDays (which otherwise re-queries it).
	const settingsP = db
		.select()
		.from(settings)
		.where(eq(settings.id, 1))
		.then((rows) => rows[0] ?? null);

	// One correction/target context per load, reused for the corrected deficit, the
	// dynamic calorie target, and the bank-adjusted goal score.
	const ctxP = settingsP.then((s) => resolveCorrection(s));

	// Today's deficit (assumes you eat up to your calorie budget — see deficitDays)
	// and today's goal score, for the two side rings on the home page. Both may be
	// null when the inputs aren't there yet; the rings render a dash, not a zero.
	// All of today's daily_log rows (eaten AND scheduled) in ONE query — split by
	// `pending` below instead of filtering twice in SQL. Everything here is
	// independent, so it all runs in parallel.
	const [
		settingsRow,
		ctx,
		rawToday,
		quickAddItems,
		[todayEnergy],
		dayMetrics,
		priorDays,
		specsFor
	] = await Promise.all([
		settingsP,
		ctxP,
		db
			.select({
				id: dailyLog.id,
				pending: dailyLog.pending,
				servings: dailyLog.servings,
				amount: dailyLog.amount,
				unit: dailyLog.unit,
				loggedAt: dailyLog.loggedAt,
				calories: dailyLog.calories,
				proteinG: dailyLog.proteinG,
				carbsG: dailyLog.carbsG,
				fatG: dailyLog.fatG,
				foodId: foods.id,
				foodName: foods.name,
				foodServingSize: foods.servingSize,
				foodServingGrams: foods.servingGrams,
				foodCalories: foods.calories,
				foodProteinG: foods.proteinG,
				foodCarbsG: foods.carbsG,
				foodFatG: foods.fatG,
				foodNutrients: foods.nutrients,
				foodIngredients: foods.ingredients,
				foodMakesServings: foods.makesServings
			})
			.from(dailyLog)
			.innerJoin(foods, eq(dailyLog.foodId, foods.id))
			.where(loggedToday())
			.orderBy(asc(dailyLog.loggedAt)),
		db
			.select({
				id: quickAdds.id,
				foodId: foods.id,
				name: foods.name,
				calories: foods.calories,
				proteinG: foods.proteinG
			})
			.from(quickAdds)
			.innerJoin(foods, eq(quickAdds.foodId, foods.id))
			.orderBy(asc(quickAdds.sortOrder)),
		ctxP.then((c) =>
			settingsP.then((s) => deficitDays(today, today, { settingsRow: s, correction: c.correction }))
		),
		ctxP.then((c) => dayMetricsForRange(today, today, c.correction)),
		// Earlier days of this week, for today's bank/debt — so the home ring matches
		// the goals page's day-detail score (both bank-adjusted) instead of trailing it.
		today > weekStart
			? ctxP.then((c) => dayMetricsForRange(weekStart, addDays(today, -1), c.correction))
			: Promise.resolve([]),
		// Same resolver /goals scores with (dynamic deficit target, vacation relaxation)
		// — the home ring used to score against the old static 750 and trail the goals page.
		ctxP.then((c) => loadScoringSpecs(c.modeDeltaKcal).then((r) => r.specsFor))
	]);

	const fiberMode = fiberModeFrom(settingsRow);

	// Eaten meals: the non-pending rows, decorated with derived bolusable carbs.
	const todayEntries = rawToday.flatMap(({ pending, ...e }) => {
		if (pending) return [];
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
		return [{ ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence }];
	});

	// Meals scheduled for later today: pending daily_log rows. They already count
	// toward the day's metrics; here they're surfaced separately so the eaten list
	// stays clean and each can be confirmed (stamp the real time) or cancelled.
	const plannedToday = rawToday
		.filter((r) => r.pending)
		.map((r) => ({
			id: r.id,
			servings: r.servings,
			amount: r.amount,
			unit: r.unit,
			scheduledAt: r.loggedAt,
			calories: r.calories,
			proteinG: r.proteinG,
			carbsG: r.carbsG,
			fatG: r.fatG,
			foodName: r.foodName,
			foodServingSize: r.foodServingSize
		}));

	const goalScore = dayMetrics[0]
		? scoreDay(dayMetrics[0], weekBalances(priorDays, specsFor), specsFor(today)).score
		: null;

	// Active-calorie goal: how many active kcal you still need today to hit your
	// deficit — each active kcal adds 1 to the deficit, so it's just the gap to the
	// goal. D = the mode's leanness-scaled deficit, else the configured fixed target.
	// The deficit balance shifts today's target: recovery eases it UP (drop the goal so the
	// ring doesn't push you to burn the credit back), debt trims it DOWN (raise the goal to
	// catch up). Same signed shift keeps target and ring in step. Never below 0.
	// todayDeltaKcal, not modeDeltaKcal: it's 0 on a break day, so the ring asks for no
	// active calories — matching the eat-to target, which is plain maintenance that day.
	const deficitGoal =
		ctx.todayDeltaKcal != null
			? Math.max(0, -ctx.todayDeltaKcal - ctx.balanceKcal)
			: (settingsRow?.deficitTargetKcal ?? 500);
	// A break day needs NO special case here, and must not get one (I shipped
	// `breakDay ? 0` once — it hid a real 200-kcal surplus behind "0 to go"). The goal
	// is simply 0 deficit, so the same subtraction still answers the right question:
	// in a surplus, that's how much to burn to climb back to maintenance; already at or
	// past maintenance, the max() floors it at 0. Big early-morning numbers are the
	// ring's normal behaviour on every day — it counts down as real burn accrues.
	// A mental health day IS the one case that needs the special-case a break day must not
	// get. On a break day the number is real — you logged food, so the gap to maintenance is
	// measured. Here the "surplus" is our own assumption about a day you chose not to log,
	// so turning it into a burn demand would invent a chore out of an imputation.
	const activeToGo =
		ctx.mentalHealthDay || todayEnergy?.deficitKcal == null
			? null
			: Math.max(0, Math.round(deficitGoal - todayEnergy.deficitKcal));

	return {
		settings: settingsRow ?? {
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70
		},
		todayEntries,
		plannedMeals: plannedToday,
		quickAddItems,
		deficit: todayEnergy?.deficitKcal ?? null,
		// Dynamic daily calorie target (live) for the calorie ring — replaces the fixed
		// settings.calorieTarget. Falls back to the fixed value until there's data.
		calorieTarget: ctx.targetKcal ?? settingsRow?.calorieTarget ?? 2100,
		// Active-calorie ring for CUT mode (fill = deficit→goal, centre = active kcal
		// still to burn); recomp/lean-bulk have no deficit to chase, so they fall back
		// to the plain deficit ring in the svelte.
		mode: ctx.mode,
		deficitGoal,
		activeToGo,
		deficitTarget: settingsRow?.deficitTargetKcal ?? 500,
		goalScore,
		// Today is off: the svelte drops the deficit/active ring entirely rather than draw a
		// goal against an intake we invented. goalScore is already null (the day is out of
		// scoring), so the score ring blanks itself.
		mentalHealthDay: ctx.mentalHealthDay,
		// The APP_TZ date, so the header links to the day the SERVER calls today (the
		// browser's own clock can be a zone off and open the wrong day detail).
		today
	};
}
