import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { requireApiToken } from '$lib/server/auth';
import { loggedToday, todayLabel } from '$lib/server/day';
import { deficitDays } from '$lib/server/deficit';
import { resolveCorrection } from '$lib/server/energyBreakdown';
import { fillBmrGaps } from '$lib/server/projections';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { fiberModeFrom } from '$lib/server/prefs';

export async function GET({ request }) {
	requireApiToken(request);
	const today = todayLabel();

	// One settings read per request: fiber mode is derived from the row and the
	// row is handed to deficitDays (which otherwise re-queries it). The entries
	// query is independent of both — run everything together.
	const settingsP = db
		.select()
		.from(settings)
		.where(eq(settings.id, 1))
		.then((rows) => rows[0] ?? null);

	const ctxP = settingsP.then((row) => resolveCorrection(row));

	const [rawEntries, s, ctx, energyDays] = await Promise.all([
		db
			.select({
				id: dailyLog.id,
				loggedAt: dailyLog.loggedAt,
				servings: dailyLog.servings,
				calories: dailyLog.calories,
				proteinG: dailyLog.proteinG,
				carbsG: dailyLog.carbsG,
				fatG: dailyLog.fatG,
				foodName: foods.name,
				foodNutrients: foods.nutrients,
				foodIngredients: foods.ingredients,
				foodMakesServings: foods.makesServings
			})
			.from(dailyLog)
			.innerJoin(foods, eq(dailyLog.foodId, foods.id))
			.where(loggedToday())
			.orderBy(asc(dailyLog.loggedAt)),
		settingsP,
		ctxP,
		ctxP.then((c) =>
			settingsP.then((row) =>
				deficitDays(today, today, { settingsRow: row, correction: c.correction })
			)
		)
	]);

	const fiberMode = fiberModeFrom(s);
	const entries = rawEntries.map(({ foodNutrients, foodIngredients, foodMakesServings, ...e }) => {
		const b = bolusableForLoggedEntry(
			e.carbsG,
			{ nutrients: foodNutrients, ingredients: foodIngredients, makesServings: foodMakesServings },
			e.servings ?? 1,
			{ fiberMode }
		);
		return { ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
	});

	const [day] = fillBmrGaps(energyDays);
	const burnedKcal = day?.burnedKcal ?? null;

	// Widget/app deficit: if still under the calorie goal, assume they'll eat up
	// to it (so the number doesn't look rosy mid-morning); if over, use actual
	// intake. Computed here so the widget and the app's drift check agree.
	const calSum = entries.reduce((sum, e) => sum + e.calories, 0);
	// Deficit uses the STABLE assumed intake (so activity doesn't cancel out); the
	// widget's displayed calorie goal uses the ratcheting eat-to target.
	const stableTarget = ctx.stableTargetKcal ?? s?.calorieTarget ?? 2100;
	const goalTarget = ctx.targetKcal ?? s?.calorieTarget ?? 2100;
	// A mental health day has no logged intake to reason about — the ledger already decided
	// what the day assumes, so take its number rather than re-deriving one from an empty food
	// log. Re-deriving would land near zero (calSum 0, stableTarget = maintenance) and the
	// widget would quietly contradict every other surface, which reports the full surplus.
	const deficit = day?.imputed
		? (day.deficitKcal ?? null)
		: burnedKcal != null
			? Math.round(burnedKcal - Math.max(calSum, stableTarget))
			: null;

	return json({
		date: today,
		entries,
		// Surface the dynamic calorie target as calorieTarget so the widget's ring
		// matches the app (not the fixed settings value).
		targets: s ? { ...s, calorieTarget: goalTarget } : null,
		burnedKcal,
		deficit
	});
}
