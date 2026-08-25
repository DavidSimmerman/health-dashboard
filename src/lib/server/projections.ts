import { asc, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { bodyComp, settings } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { deficitDays, MENTAL_HEALTH_SURPLUS_KCAL, type DayEnergy } from '$lib/server/deficit';
import { loadIsVacation } from '$lib/server/vacations';
import {
	linearRegression,
	interpolateGaps,
	etaDaysToGoal,
	daysBetween,
	addDays,
	KCAL_PER_KG,
	type Point
} from '$lib/energy';

// Body-composition trends + projections, built on the synced weigh-ins and the
// energy ledger. Weight on a scale is noisy, so we project off a least-squares
// trend line through the weigh-ins, and cross-check the implied weight-loss rate
// against the measured calorie deficit (avg deficit ÷ 7700 kcal/kg). Shared by
// the /trends page, the /day view, and the MCP server.

export type WeighIn = {
	date: string; // YYYY-MM-DD in APP_TZ
	weightKg: number;
	bodyFatPct: number | null;
	leanMassKg: number | null;
};

export type Trend = {
	slopePerDay: number; // signed change per day (negative = decreasing)
	ratePerWeek: number;
	current: number; // trend value at `today` (smoother than the last raw reading)
	anchorDate: string; // x=0 for the fit
	intercept: number; // value at anchorDate
};

export type GoalEta = {
	goal: number;
	current: number;
	ratePerWeek: number;
	etaDays: number | null;
	etaDate: string | null;
};

export type Projection = {
	date: string;
	label: string; // e.g. "+1 month"
	weightKg: number | null;
	bodyFatPct: number | null;
	leanMassKg: number | null;
};

export type BodyInsights = {
	asOf: string;
	series: WeighIn[]; // actual weigh-ins in the window (oldest → newest)
	weight: Trend | null;
	bodyFat: Trend | null;
	leanMass: Trend | null;
	deficitImplied: { ratePerWeekKg: number; avgDeficitKcal: number; days: number } | null;
	projections: Projection[];
	goal: { weight: GoalEta | null; bodyFat: GoalEta | null };
};

const compDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ });

// All weigh-ins up to `toDate` (default today), oldest first, bucketed to a
// local date. Multiple weigh-ins on a day are kept — the regression handles
// repeated x's fine.
export async function weighInsThrough(toDate?: string): Promise<WeighIn[]> {
	const to = toDate ?? todayLabel();
	const rows = await db
		.select()
		.from(bodyComp)
		.where(
			sql`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date <= ${to}::date`
		)
		.orderBy(asc(bodyComp.measuredAt));
	return rows.map((r) => ({
		date: compDateFmt.format(r.measuredAt),
		weightKg: r.weightKg,
		bodyFatPct: r.bodyFatPct,
		leanMassKg: r.leanMassKg
	}));
}

function trendFor(
	series: WeighIn[],
	pick: (w: WeighIn) => number | null,
	anchorDate: string,
	today: string
): Trend | null {
	const points: Point[] = [];
	for (const w of series) {
		const y = pick(w);
		if (y != null) points.push({ x: daysBetween(anchorDate, w.date), y });
	}
	const fit = linearRegression(points);
	if (!fit) return null;
	return {
		slopePerDay: fit.slope,
		ratePerWeek: fit.slope * 7,
		current: fit.intercept + fit.slope * daysBetween(anchorDate, today),
		anchorDate,
		intercept: fit.intercept
	};
}

// A fitted trend evaluated on `date` — interpolation inside the fit window. Exported because
// the deficit balance judges each past day against the baseline IT had, which means reading
// weight/body-fat off the LINE rather than off that day's weigh-in: the raw readings carry
// roughly as much scale noise (~±0.4% bf) as the real drift across the window.
export function projAt(trend: Trend | null, date: string): number | null {
	if (!trend) return null;
	return trend.intercept + trend.slopePerDay * daysBetween(trend.anchorDate, date);
}

function goalEta(
	trend: Trend | null,
	goal: number | null | undefined,
	today: string
): GoalEta | null {
	if (!trend || goal == null) return null;
	const etaDays = etaDaysToGoal(trend.current, goal, trend.slopePerDay);
	return {
		goal,
		current: trend.current,
		ratePerWeek: trend.ratePerWeek,
		etaDays: etaDays == null ? null : Math.round(etaDays),
		etaDate: etaDays == null ? null : addDays(today, Math.round(etaDays))
	};
}

/**
 * @param windowDays trailing window of weigh-ins to fit the trend over
 * @param horizons   future offsets (in days) to project at
 * @param targetDate optional extra date to project at (YYYY-MM-DD)
 */
export async function bodyInsights({
	windowDays = 90,
	horizons = [
		{ days: 30, label: '+1 month' },
		{ days: 60, label: '+2 months' },
		{ days: 90, label: '+3 months' }
	],
	targetDate
}: {
	windowDays?: number;
	horizons?: { days: number; label: string }[];
	targetDate?: string;
} = {}): Promise<BodyInsights> {
	// Clamp untrusted input (URL ?window=, MCP args) — an Infinite/huge window
	// would make addDays throw and deficitDays iterate forever. 1–1825 days.
	windowDays = Math.min(Math.max(1, Math.floor(Number(windowDays)) || 90), 1825);

	const today = todayLabel();
	// Vacation days are dropped from the learning inputs: trip weigh-ins are
	// water-noisy and trip food is guesswork, so both skew the trend + calibration.
	const isVac = await loadIsVacation();
	const all = (await weighInsThrough(today)).filter((w) => !isVac(w.date));

	// Window to the trailing `windowDays` of weigh-ins; if that leaves <2 points,
	// fall back to the full history so a sparse logger still gets a trend.
	let series = all;
	if (all.length) {
		const cutoff = addDays(all[all.length - 1].date, -windowDays);
		const windowed = all.filter((w) => w.date >= cutoff);
		if (windowed.length >= 2) series = windowed;
	}

	const anchor = series.length ? series[0].date : today;
	const weight = trendFor(series, (w) => w.weightKg, anchor, today);
	const bodyFat = trendFor(series, (w) => w.bodyFatPct, anchor, today);
	const leanMass = trendFor(series, (w) => w.leanMassKg, anchor, today);

	// Deficit-implied weight rate over the same window: avg daily deficit ÷ 7700
	// kcal/kg. Positive deficit ⇒ losing ⇒ negative weight change. Fetch one extra
	// day back (−windowDays, not −windowDays+1): today is excluded below, so this
	// keeps a full windowDays of completed days — same window energyInsights uses.
	const from = addDays(today, -windowDays);
	const ledger = await deficitDays(from, today);
	// Exclude today's deficit — you're not done eating, so it's an inflated
	// partial. Today's weigh-in still counts (it's in `series` above).
	const counted = ledger.filter(
		(d) => d.deficitKcal != null && d.intakeKcal > 0 && d.date !== today && !isVac(d.date)
	);
	const deficitImplied = counted.length
		? (() => {
				const avgDeficitKcal =
					counted.reduce((a, d) => a + (d.deficitKcal ?? 0), 0) / counted.length;
				return {
					avgDeficitKcal: Math.round(avgDeficitKcal),
					ratePerWeekKg: (-avgDeficitKcal / KCAL_PER_KG) * 7,
					days: counted.length
				};
			})()
		: null;

	const projections: Projection[] = [];
	const horizonRows = [...horizons];
	if (targetDate && targetDate > today) {
		horizonRows.push({ days: daysBetween(today, targetDate), label: targetDate });
	}
	for (const h of horizonRows) {
		const date = h.label === targetDate ? targetDate : addDays(today, h.days);
		projections.push({
			date,
			label: h.label,
			weightKg: round1(projAt(weight, date)),
			bodyFatPct: round1(projAt(bodyFat, date)),
			leanMassKg: round1(projAt(leanMass, date))
		});
	}

	const [settingsRow] = await db
		.select()
		.from(settings)
		.where(sql`${settings.id} = 1`);
	return {
		asOf: today,
		series,
		weight,
		bodyFat,
		leanMass,
		deficitImplied,
		projections,
		goal: {
			weight: goalEta(weight, settingsRow?.goalWeightKg, today),
			bodyFat: goalEta(bodyFat, settingsRow?.goalBodyFatPct, today)
		}
	};
}

// Fill days whose BMR couldn't be estimated by interpolating between the days
// that could, then recompute burn + deficit for those days. Returns a NEW array;
// untouched days are returned as-is. No-op when no day has a BMR (nothing to
// interpolate from).
export function fillBmrGaps(days: DayEnergy[]): DayEnergy[] {
	const filled = interpolateGaps(days.map((d) => d.bmrKcal));
	return days.map((d, i) => {
		if (d.bmrKcal != null || filled[i] == null) return d;
		const bmr = Math.round(filled[i]!);
		const burned = bmr + (d.activeKcal ?? 0) + d.tefKcal;
		// This is the first moment a mental health day with no BMR of its own HAS a
		// maintenance figure, so impute against it here rather than booking `burned − 0` —
		// which would turn the day we deliberately left unlogged into a full-day fast, the
		// precise misreading the imputation exists to prevent.
		if (d.mentalHealth && !d.imputed)
			return {
				...d,
				bmrKcal: bmr,
				bmrSource: 'interpolated' as const,
				burnedKcal: Math.round(burned),
				intakeKcal: Math.round(burned + MENTAL_HEALTH_SURPLUS_KCAL),
				deficitKcal: -MENTAL_HEALTH_SURPLUS_KCAL,
				imputed: true
			};
		return {
			...d,
			bmrKcal: bmr,
			bmrSource: 'interpolated',
			burnedKcal: Math.round(burned),
			deficitKcal: Math.round(burned - d.intakeKcal)
		};
	});
}

function round1(n: number | null): number | null {
	return n == null ? null : Math.round(n * 10) / 10;
}

// ── Energy-balance projection model ──────────────────────────────────────────
// Beyond the raw weigh-in trend, project body comp from calorie balance. The
// core trick (what adaptive-TDEE apps like MacroFactor do): instead of trusting
// a BMR formula OR the noisy scale, BACK OUT the user's real maintenance from
// observed data over a window — calibratedTDEE = avgIntake − weightSlope×7700.
// Then forward-simulate, decaying TDEE as weight drops and splitting each
// increment of loss into fat vs lean by a protein/leanness-aware p-ratio.
//
// Constants are research-defaulted and live here to tune in one place.
// (see .claude/research/weight-projection-science.md — Hall/Thomas linearized
// model, Forbes p-ratio, ISSN/Helms protein.)
const PROTEIN_ADEQUATE_G_PER_KG = 1.6; // g/kg floor that protects lean mass (optimal ~2.3 + lifting)
const TDEE_DROP_PER_KG = 32; // kcal/day maintenance falls per kg lost — obligatory ~25 + adaptive ~7 (ε)
const RHO_KCAL_PER_KG = 8700; // effective energy density of weight change in the forward model
// NOTE: calibrating TDEE from observed loss uses the classic 7700 (KCAL_PER_KG);
// the forward simulation uses ρ=8700 + ε decay, which converges to the same
// equilibrium loss (deficit ÷ ε) Hall's model predicts.

export type ProjectionMethod = 'trend' | 'deficit' | 'combined';

export type MethodProjection = {
	method: ProjectionMethod;
	label: string;
	note: string;
	ratePerWeekKg: number | null; // near-term loss rate this method implies (neg = losing)
	rows: Projection[];
};

export type EnergyInsights = {
	windowDays: number;
	loggedDays: number;
	avgIntakeKcal: number | null;
	avgProteinG: number | null;
	proteinPerKg: number | null;
	proteinAdequate: boolean | null;
	estimatedTdee: number | null; // our BMR+active+TEF average (the formula's guess)
	calibratedTdee: number | null; // backed out of observed intake + weight change (reality)
	measuredRatePerWeekKg: number | null; // from the weigh-in trend
	expectedRatePerWeekKg: number | null; // from the logged calorie deficit (formula)
	pace: {
		ratio: number | null;
		verdict: 'on-track' | 'slower' | 'faster' | 'gaining' | 'surplus' | 'unknown';
	};
	methods: MethodProjection[];
	currentDeficitKcal: number | null; // calibratedTDEE − avg intake (your real current deficit)
	whatIf: WhatIf | null; // "what if my deficit were X?" scenario
};

// A hypothetical-deficit scenario: hold a chosen daily deficit and project the
// loss rate + time to the saved goal(s) using calibrated maintenance.
export type WhatIf = {
	deficitKcal: number;
	plannedIntakeKcal: number;
	ratePerWeekKg: number;
	goalWeightEtaDays: number | null;
	goalWeightEtaDate: string | null;
	goalBodyFatEtaDays: number | null;
	goalBodyFatEtaDate: string | null;
};

// Share of a weight CHANGE that comes from LEAN mass (the p-ratio). Leaner
// bodies surrender more lean (Forbes); adequate protein + lifting protect it.
// Defaults from the p-ratio review tables (Thomas 2012 / Helms 2014).
function leanLossFraction(bodyFatPct: number, proteinAdequate: boolean): number {
	let p = 0.2 - (bodyFatPct - 15) * 0.006; // ~0.20 at 15% bf, falls as bf rises
	p = Math.min(0.45, Math.max(0.05, p));
	if (!proteinAdequate) p = Math.min(0.6, p * 1.5); // too little protein → more lean lost
	return p;
}

// One day of energy-balance dynamics: maintenance decays with lost mass, the
// day's change is split fat/lean by the p-ratio. Shared by every projection.
type CompState = { weight: number; fat: number | null; lean: number | null };
function stepBodyComp(
	s: CompState,
	w0: number,
	tdee0: number,
	plannedIntake: number,
	proteinG: number | null
): CompState {
	const tdee = tdee0 - (w0 - s.weight) * TDEE_DROP_PER_KG; // less mass → less maintenance
	const dW = -(tdee - plannedIntake) / RHO_KCAL_PER_KG; // kg/day, neg when in a deficit
	if (s.fat != null && s.lean != null) {
		const bf = s.weight > 0 ? (s.fat / s.weight) * 100 : 0;
		const adequate =
			proteinG != null && s.weight > 0 && proteinG / s.weight >= PROTEIN_ADEQUATE_G_PER_KG;
		const leanShare = leanLossFraction(bf, adequate);
		const fat = Math.max(0, s.fat + dW * (1 - leanShare));
		const lean = Math.max(0, s.lean + dW * leanShare);
		return { weight: fat + lean, fat, lean };
	}
	return { weight: Math.max(0, s.weight + dW), fat: null, lean: null };
}

// Forward-simulate body comp day by day from `today` to the furthest requested
// date, recording at each requested horizon. TDEE decays with lost mass; loss is
// split fat/lean by the p-ratio. If bodyFat is unknown we project weight only.
function forwardSim(opts: {
	today: string;
	weightKg: number;
	bodyFatPct: number | null;
	tdee0: number;
	plannedIntake: number;
	proteinG: number | null;
	dates: { date: string; label: string }[];
}): { rows: Projection[]; ratePerWeekKg: number } {
	const ratePerWeekKg = (-(opts.tdee0 - opts.plannedIntake) / RHO_KCAL_PER_KG) * 7;
	const maxDay = opts.dates.reduce((m, d) => Math.max(m, daysBetween(opts.today, d.date)), 0);
	if (maxDay <= 0) return { rows: [], ratePerWeekKg };

	const w0 = opts.weightKg;
	let state: CompState = {
		weight: opts.weightKg,
		fat: opts.bodyFatPct != null ? (opts.weightKg * opts.bodyFatPct) / 100 : null,
		lean: null
	};
	state.lean = state.fat != null ? opts.weightKg - state.fat : null;
	const recordOn = new Map(opts.dates.map((d) => [daysBetween(opts.today, d.date), d.label]));
	const rows: Projection[] = [];

	for (let day = 1; day <= maxDay; day++) {
		state = stepBodyComp(state, w0, opts.tdee0, opts.plannedIntake, opts.proteinG);
		const label = recordOn.get(day);
		if (label !== undefined) {
			const bf = state.fat != null && state.weight > 0 ? (state.fat / state.weight) * 100 : null;
			rows.push({
				date: addDays(opts.today, day),
				label,
				weightKg: round1(state.weight),
				bodyFatPct: round1(bf),
				leanMassKg: round1(state.lean)
			});
		}
	}
	return { rows, ratePerWeekKg };
}

// Day-by-day forward simulation until the weight and/or body-fat goal is met;
// returns days-to-goal (null if not reached within the cap). Loss slows as TDEE
// adapts, so this is more honest than dividing the gap by the current rate.
function simulateToGoals(opts: {
	weightKg: number;
	bodyFatPct: number | null;
	tdee0: number;
	plannedIntake: number;
	proteinG: number | null;
	goalWeightKg: number | null;
	goalBodyFatPct: number | null;
	maxDays?: number;
}): { weightEtaDays: number | null; bodyFatEtaDays: number | null } {
	const maxDays = opts.maxDays ?? 1825;
	const w0 = opts.weightKg;
	let state: CompState = {
		weight: opts.weightKg,
		fat: opts.bodyFatPct != null ? (opts.weightKg * opts.bodyFatPct) / 100 : null,
		lean: null
	};
	state.lean = state.fat != null ? opts.weightKg - state.fat : null;
	const bfOf = (s: CompState) => (s.fat != null && s.weight > 0 ? (s.fat / s.weight) * 100 : null);

	// Direction-aware: a goal above the current value is reached by going UP
	// (surplus), below by going DOWN. `reached` crosses in the right direction.
	const bf0 = bfOf(state);
	const wDown = opts.goalWeightKg == null || state.weight >= opts.goalWeightKg;
	const bfDown = opts.goalBodyFatPct == null || bf0 == null || bf0 >= opts.goalBodyFatPct;
	const wReached = (v: number) =>
		opts.goalWeightKg != null && (wDown ? v <= opts.goalWeightKg : v >= opts.goalWeightKg);
	const bfReached = (v: number | null) =>
		opts.goalBodyFatPct != null &&
		v != null &&
		(bfDown ? v <= opts.goalBodyFatPct : v >= opts.goalBodyFatPct);

	let weightEtaDays: number | null = wReached(state.weight) ? 0 : null;
	let bodyFatEtaDays: number | null = bfReached(bf0) ? 0 : null;

	for (let day = 1; day <= maxDays && (weightEtaDays === null || bodyFatEtaDays === null); day++) {
		state = stepBodyComp(state, w0, opts.tdee0, opts.plannedIntake, opts.proteinG);
		if (weightEtaDays === null && wReached(state.weight)) weightEtaDays = day;
		const bf = bfOf(state);
		if (bodyFatEtaDays === null && bfReached(bf)) bodyFatEtaDays = day;
	}
	return { weightEtaDays, bodyFatEtaDays };
}

/**
 * Energy-aware insights + multi-method projections. Builds on bodyInsights for
 * the weigh-in trend, and on the calorie ledger for intake/protein/deficit.
 */
export async function energyInsights({
	windowDays = 30,
	horizons = [
		{ days: 30, label: '+1 month' },
		{ days: 60, label: '+2 months' },
		{ days: 90, label: '+3 months' }
	],
	targetDate,
	whatIfDeficitKcal
}: {
	windowDays?: number;
	horizons?: { days: number; label: string }[];
	targetDate?: string;
	whatIfDeficitKcal?: number;
} = {}): Promise<EnergyInsights & { body: BodyInsights }> {
	windowDays = Math.min(Math.max(1, Math.floor(Number(windowDays)) || 30), 1825);
	const today = todayLabel();
	const body = await bodyInsights({ windowDays, horizons, targetDate });

	// Window ledger for intake / protein / our formula-TDEE. Fetch one extra day
	// back (−windowDays, not −windowDays+1) because we drop today below — this
	// keeps a full `windowDays` of COMPLETED days so the coverage gate (≥7) can
	// still trip on the 7-day view.
	const from = addDays(today, -windowDays);
	// Drop today: its partial intake/deficit would skew intake, TDEE and pace.
	// The weigh-in trend (body.series) keeps today's weigh-in.
	const ledger = fillBmrGaps(await deficitDays(from, today)).filter((d) => d.date !== today);
	const isVac = await loadIsVacation();
	const logged = ledger.filter((d) => d.intakeKcal > 0 && !isVac(d.date));
	const withBurn = ledger.filter((d) => d.burnedKcal != null && !isVac(d.date));
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

	const avgIntakeKcal = mean(logged.map((d) => d.intakeKcal));
	// Macros skip imputed (mental health) days: the imputed INTAKE is a deliberate
	// assumption and belongs in the average above, but proteinG is 0 purely because nothing
	// was logged. Averaging that in would invent a protein crash that never happened and
	// drag proteinAdequate down with it.
	const avgProteinG = mean(logged.filter((d) => !d.imputed).map((d) => d.proteinG));
	const estimatedTdee = mean(withBurn.map((d) => d.burnedKcal as number));

	// Calibrated TDEE + the energy-based projections multiply avg intake across the
	// whole window, so they're only trustworthy with enough logged-day coverage —
	// otherwise one logged day would be treated as if it happened every day.
	const spanDays = body.series.length ? daysBetween(body.series[0].date, today) + 1 : windowDays;
	// Coverage denominator = LOGGABLE (non-vacation) days in the effective window, so a
	// long trip can't fail the gate despite full logging on the days that count.
	const effStart = addDays(today, -Math.min(windowDays, spanDays));
	const effWindow = Math.max(1, ledger.filter((d) => d.date >= effStart && !isVac(d.date)).length);
	const enoughIntake = logged.length >= 7 && logged.length / effWindow >= 0.5;

	const startWeight = body.weight?.current ?? null; // trend value today (smoothed)
	const startBf = body.bodyFat?.current ?? null;
	const proteinPerKg = avgProteinG != null && startWeight ? avgProteinG / startWeight : null;
	const proteinAdequate = proteinPerKg != null ? proteinPerKg >= PROTEIN_ADEQUATE_G_PER_KG : null;

	const measuredSlope = body.weight?.slopePerDay ?? null;
	const measuredRatePerWeekKg = body.weight?.ratePerWeek ?? null;
	const calibratedTdee =
		enoughIntake && avgIntakeKcal != null && measuredSlope != null
			? Math.round(avgIntakeKcal - measuredSlope * KCAL_PER_KG)
			: null;
	const expectedRatePerWeekKg = body.deficitImplied?.ratePerWeekKg ?? null;

	// "Am I losing as fast as my deficit predicts?" — branch on whether the logged
	// intake is actually a deficit; surplus/maintenance gets different copy.
	let ratio: number | null = null;
	let verdict: EnergyInsights['pace']['verdict'];
	if (!enoughIntake || measuredRatePerWeekKg == null || expectedRatePerWeekKg == null) {
		verdict = 'unknown';
	} else if (expectedRatePerWeekKg >= -1e-6) {
		// logged intake is at/above estimated maintenance — not a deficit
		verdict = measuredRatePerWeekKg > 0.05 ? 'gaining' : 'surplus';
	} else if (measuredRatePerWeekKg > 0.05) {
		verdict = 'gaining'; // a predicted deficit, yet trending up
	} else {
		ratio = measuredRatePerWeekKg / expectedRatePerWeekKg; // both neg when losing
		verdict = ratio >= 1.3 ? 'faster' : ratio >= 0.7 ? 'on-track' : 'slower';
	}

	// Project dates (horizons + optional custom target).
	const dates = horizons.map((h) => ({ date: addDays(today, h.days), label: h.label }));
	if (targetDate && targetDate > today) dates.push({ date: targetDate, label: targetDate });

	const methods: MethodProjection[] = [
		{
			method: 'trend',
			label: 'Current trend',
			note: 'Extrapolates your weigh-in trend line as-is.',
			ratePerWeekKg: measuredRatePerWeekKg,
			rows: body.projections
		}
	];
	if (enoughIntake && startWeight != null && estimatedTdee != null && avgIntakeKcal != null) {
		const sim = forwardSim({
			today,
			weightKg: startWeight,
			bodyFatPct: startBf,
			tdee0: estimatedTdee,
			plannedIntake: avgIntakeKcal,
			proteinG: avgProteinG,
			dates
		});
		methods.push({
			method: 'deficit',
			label: 'Calorie deficit',
			note: 'If your logged intake vs estimated burn holds — splits loss into fat/lean by protein & body-fat %.',
			ratePerWeekKg: sim.ratePerWeekKg,
			rows: sim.rows
		});
	}
	if (startWeight != null && calibratedTdee != null && avgIntakeKcal != null) {
		const sim = forwardSim({
			today,
			weightKg: startWeight,
			bodyFatPct: startBf,
			tdee0: calibratedTdee,
			plannedIntake: avgIntakeKcal,
			proteinG: avgProteinG,
			dates
		});
		methods.push({
			method: 'combined',
			label: 'Smart (calibrated)',
			note: 'Uses your REAL maintenance backed out of observed intake + weight change, then projects energy balance with metabolic adaptation.',
			ratePerWeekKg: sim.ratePerWeekKg,
			rows: sim.rows
		});
	}

	// Maintenance to project the what-if from: prefer the calibrated (measured)
	// value, fall back to the formula estimate so the explorer still works before
	// there's enough weigh-in/logging coverage to calibrate.
	const maintenanceTdee = calibratedTdee ?? estimatedTdee;

	// Your current average deficit over the selected window (maintenance − intake).
	const currentDeficitKcal =
		maintenanceTdee != null && avgIntakeKcal != null
			? Math.round(maintenanceTdee - avgIntakeKcal)
			: null;

	// "What if my deficit were X?" — hold a hypothetical deficit off maintenance
	// and forward-simulate to the saved goal(s). Defaults to the current average.
	let whatIf: WhatIf | null = null;
	const widParam =
		whatIfDeficitKcal != null && Number.isFinite(whatIfDeficitKcal)
			? Math.max(-3000, Math.min(3000, whatIfDeficitKcal))
			: null;
	const wid = widParam ?? currentDeficitKcal; // default the scenario to the current deficit
	if (wid != null && maintenanceTdee != null && startWeight != null) {
		const plannedIntake = Math.max(0, maintenanceTdee - wid);
		const etas = simulateToGoals({
			weightKg: startWeight,
			bodyFatPct: startBf,
			tdee0: maintenanceTdee,
			plannedIntake,
			proteinG: avgProteinG,
			goalWeightKg: body.goal.weight?.goal ?? null,
			goalBodyFatPct: body.goal.bodyFat?.goal ?? null
		});
		whatIf = {
			deficitKcal: Math.round(wid),
			plannedIntakeKcal: Math.round(plannedIntake),
			ratePerWeekKg: (-(maintenanceTdee - plannedIntake) / RHO_KCAL_PER_KG) * 7,
			goalWeightEtaDays: etas.weightEtaDays,
			goalWeightEtaDate: etas.weightEtaDays == null ? null : addDays(today, etas.weightEtaDays),
			goalBodyFatEtaDays: etas.bodyFatEtaDays,
			goalBodyFatEtaDate: etas.bodyFatEtaDays == null ? null : addDays(today, etas.bodyFatEtaDays)
		};
	}

	return {
		body,
		windowDays,
		loggedDays: logged.length,
		avgIntakeKcal: avgIntakeKcal == null ? null : Math.round(avgIntakeKcal),
		avgProteinG: avgProteinG == null ? null : Math.round(avgProteinG),
		proteinPerKg: round1(proteinPerKg),
		proteinAdequate,
		estimatedTdee: estimatedTdee == null ? null : Math.round(estimatedTdee),
		calibratedTdee,
		measuredRatePerWeekKg,
		expectedRatePerWeekKg,
		pace: { ratio, verdict },
		methods,
		currentDeficitKcal,
		whatIf
	};
}
