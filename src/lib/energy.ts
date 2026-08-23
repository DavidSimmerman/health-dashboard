// Energy expenditure math. Pure functions — all data fetching lives in
// $lib/server/deficit.

// Katch-McArdle BMR — the preferred formula since the smart scale gives lean
// mass. Unlike weight-only formulas it doesn't assume an average body
// composition, which is the whole reason we sync body comp data.
export function katchMcArdleBmr(leanMassKg: number): number {
	return 370 + 21.6 * leanMassKg;
}

// Mifflin-St Jeor BMR — fallback for weigh-ins with no body-fat reading.
export function mifflinBmr(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	sex: 'male' | 'female'
): number {
	return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + (sex === 'male' ? 5 : -161);
}

// Thermic effect of food — digestion cost, per macro. Protein is ~25-30% of
// its own calories, carbs ~5-10%, fat ~0-3%; midpoints used. This is why
// logging macros (not just calories) sharpens the burn estimate.
export function tefKcal(proteinG: number, carbsG: number, fatG: number): number {
	return 0.27 * 4 * proteinG + 0.075 * 4 * carbsG + 0.02 * 9 * fatG;
}

// Whole years between birthDate ('YYYY-MM-DD') and onDate ('YYYY-MM-DD').
export function ageOn(onDate: string, birthDate: string): number {
	const [oy, om, od] = onDate.split('-').map(Number);
	const [by, bm, bd] = birthDate.split('-').map(Number);
	let age = oy - by;
	if (om < bm || (om === bm && od < bd)) age -= 1;
	return age;
}

// ~7700 kcal per kg of body fat → 3500 per lb.
export const KCAL_PER_LB = 3500;
export const KCAL_PER_KG = 7700;

// Weigh-ins are stored in kg (HealthKit's native unit); the UI shows pounds.
// Convert only at the display edge — never store lb.
export const LB_PER_KG = 2.20462;
export const kgToLb = (kg: number) => kg * LB_PER_KG;
export const lbToKg = (lb: number) => lb / LB_PER_KG;

// ── Trend / projection math (pure) ──────────────────────────────────────────
// Body weight on a scale is noisy day to day (water, glycogen, gut contents), so
// we fit a least-squares line through the weigh-ins and project off the SLOPE of
// that line rather than the last reading. Same approach the "weight trend" apps
// use. See energy.selfcheck.ts for the runnable checks.

export type Point = { x: number; y: number };

// Ordinary least-squares fit. `x` is typically a day index. Returns null when
// there are fewer than two distinct x's — a line needs two points.
export function linearRegression(points: Point[]): { slope: number; intercept: number } | null {
	const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (pts.length < 2) return null;
	const n = pts.length;
	let sx = 0,
		sy = 0,
		sxx = 0,
		sxy = 0;
	for (const { x, y } of pts) {
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
	}
	const denom = n * sxx - sx * sx;
	if (denom === 0) return null; // all x identical
	const slope = (n * sxy - sx * sy) / denom;
	return { slope, intercept: (sy - slope * sx) / n };
}

// Whole days from `from` to `to` (YYYY-MM-DD). UTC noon avoids DST off-by-one.
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

// The YYYY-MM-DD `n` days after `from`.
export function addDays(from: string, n: number): string {
	return new Date(Date.parse(`${from}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// Linear-interpolate nulls in a series; hold the nearest known value flat past
// the ends (carry forward / back). All-null in → all-null out. Used to fill
// days whose BMR couldn't be estimated from the days that could.
export function interpolateGaps(values: (number | null)[]): (number | null)[] {
	const out = values.slice();
	const known = values.flatMap((v, i) => (v == null ? [] : [i]));
	if (known.length === 0) return out;
	// Two-pointer walk (known is ascending): ki is the last known index < i.
	let ki = -1;
	for (let i = 0; i < out.length; i++) {
		if (out[i] != null) {
			ki++;
			continue;
		}
		const prev = ki >= 0 ? known[ki] : undefined;
		const next = ki + 1 < known.length ? known[ki + 1] : undefined;
		if (prev !== undefined && next !== undefined) {
			const t = (i - prev) / (next - prev);
			out[i] = values[prev]! + t * (values[next]! - values[prev]!);
		} else out[i] = values[prev ?? next!]; // carry forward, else back
	}
	return out;
}

// Days until `current` reaches `goal` at `ratePerDay` (signed change per day).
// Null if already met within tolerance, the rate is ~0, or it moves away.
export function etaDaysToGoal(current: number, goal: number, ratePerDay: number): number | null {
	const remaining = goal - current;
	if (Math.abs(remaining) < 1e-9) return 0;
	if (!Number.isFinite(ratePerDay) || Math.abs(ratePerDay) < 1e-9) return null;
	const days = remaining / ratePerDay;
	return days > 0 ? days : null; // negative ⇒ trending the wrong way
}

// Body-fat % implied by weight + lean (fat-free) mass.
export function bodyFatPctFromLean(weightKg: number, leanMassKg: number): number {
	return weightKg > 0 ? ((weightKg - leanMassKg) / weightKg) * 100 : 0;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ── Dynamic deficit goal ─────────────────────────────────────────────────────
export type GoalMode = 'cut' | 'recomp' | 'lean_bulk';

// Target rate of body-weight change per week as a % of bodyweight, scaled by how
// lean you are: cut harder with fat to spare, ease as you approach single digits
// to protect muscle. Signed — negative = losing. Anchored so ~18% bf → −0.66%/wk
// (≈1 lb/wk), ramping to −1.0% at 25% and easing to a −0.3% floor by ~13%.
export function targetRatePctPerWeek(mode: GoalMode, bodyFatPct: number): number {
	if (mode === 'recomp') return 0;
	if (mode === 'lean_bulk') return 0.25; // ponytail: flat gentle surplus; taper vs a bf ceiling only if it matters
	return -clamp(0.66 + (bodyFatPct - 18) * 0.07, 0.3, 1.0); // cut
}

// Signed daily energy delta vs maintenance (kcal). Negative = deficit (eat less
// than you burn), positive = surplus. target = maintenance + modeDeficit(...).
export function modeDeficit(mode: GoalMode, bodyFatPct: number, weightKg: number): number {
	const kgPerWeek = (targetRatePctPerWeek(mode, bodyFatPct) / 100) * weightKg;
	return (kgPerWeek * KCAL_PER_KG) / 7;
}

// ── Active-energy correction ─────────────────────────────────────────────────
// HealthKit over-estimates PASSIVE active energy; dedicated workout tracking (the
// walking pad) is trusted. So trusted kcal ride at 1.0 and only the passive
// remainder gets the haircut. `dailyActiveKcal` already includes the workout kcal.
//
// `countedKcal` is how much of `dailyActiveKcal` those trusted workouts ALREADY occupy —
// Apple's own activeEnergyBurned summed over their windows. It is NOT the same number as
// `trustedKcal`, and conflating them is a real error: our figure REPLACES Apple's for that
// window, so the passive remainder is the day minus APPLE'S share, not minus ours. A 56-min
// run Apple credited ~600 while our distance formula says 515 would otherwise leave 220
// "passive" when only ~135 really is — haircutting ~85 kcal of genuine run energy as couch time.
// Defaults to trustedKcal, reproducing the old behaviour for workouts synced before the iOS app
// began sending the window sum. 0 is valid and distinct from absent: the Watch was off, so Apple
// counted nothing for that hour and the whole day outside it is passive.
export function correctActive(
	dailyActiveKcal: number,
	trustedKcal: number,
	factor: number,
	countedKcal: number = trustedKcal
): number {
	const passive = Math.max(0, dailyActiveKcal - countedKcal);
	return trustedKcal + factor * passive;
}

// Back the passive haircut out of calibration: `realActiveAvg` is the true active
// burn implied by the weight trend (calibratedMaintenance − BMR − TEF); solve for
// the factor that scales the window's average PASSIVE active to reality with
// trusted held fixed. Clamped; returns 1 (no correction) when there's too little
// passive signal to learn from (e.g. every active calorie came from a workout).
// `countedAvg` mirrors correctActive's `countedKcal`: training has to solve the SAME equation
// the correction applies, real = trusted + f × (raw − counted). Using trusted in the denominator
// while the correction subtracts counted biases the learned factor on every day where Apple's
// window sum differs from the number we credit. Defaults to trustedAvg (old behaviour).
export function activeCorrectionFactor(
	realActiveAvg: number,
	rawActiveAvg: number,
	trustedAvg: number,
	countedAvg: number = trustedAvg
): number {
	const passiveAvg = rawActiveAvg - countedAvg;
	if (!(passiveAvg > 50)) return 1;
	return clamp((realActiveAvg - trustedAvg) / passiveAvg, 0.4, 1.2);
}

// Eat-to target sits at this fraction of calibrated maintenance (before the mode
// deficit). The <1 haircut is a deliberate cushion: the daily number is stable and
// only ratchets UP for extra exercise (never down for a lazy day), so a below-average
// day would otherwise leave the target too high — the haircut keeps those days netting
// a deficit and stops the target chasing an activity-inflated average upward over time.
// ponytail: one knob; tune here if the cushion feels wrong.
export const TARGET_BUFFER_FRACTION = 0.9;

// The daily eat-to baseline (fixed for the whole day, from trailing data that EXCLUDES
// today). On a CUT it's held at TARGET_BUFFER_FRACTION × maintenance + the deficit — i.e.
// ~90% of maintenance minus the deficit. The <1 haircut is a cut-only cushion. Recomp
// (delta 0, eat AT maintenance) and lean bulk (delta > 0, eat ABOVE it) get NO haircut —
// applying it would wrongly turn a maintenance/surplus goal into a deficit. So the buffer
// only kicks in when there's a deficit to cushion (negative delta).
export function targetBaseline(maintenanceKcal: number, modeDeltaKcal: number): number {
	const fraction = modeDeltaKcal < 0 ? TARGET_BUFFER_FRACTION : 1;
	return fraction * maintenanceKcal + modeDeltaKcal;
}

// Rolling signed "deficit balance" (kcal): recovery when you overshoot your deficit goal,
// DEBT when you fall short of it — so neither losing too fast nor stalling compounds. Positive
// (recovery) → raise today's eat-to (you already lost enough, ease off). Negative (debt) →
// lower it (trim to catch back up). Symmetric cap at ±maxKcal so recovery never recommends a
// surplus and debt can't spiral.
//
// Each day is scored against the goal it was ACTUALLY SHOWN (base + carryover), never against
// the bare base. That's the whole ballgame: score against base and a day you only cleared
// because the goal was raised by debt mints fresh recovery for doing the catch-up you owed —
// you could miss the number on screen and still get paid (the real bug this replaced: shown
// 726, did 683, awarded +101).
//
// Carry-forward is ASYMMETRIC on purpose:
//   • Fell short AND finished under the baseline deficit → that's real debt, owed IN FULL
//     tomorrow. No softening: dip below baseline and the next day immediately makes it up.
//   • Anything else (beat the goal, or missed only an already-inflated catch-up goal) → HALF.
// Old carryover always halves either way, so aged debt keeps fading even while new debt
// accrues — that's what stops a bad streak compounding into an unreachable 900-kcal ask.
// The `remaining > 0` guard matters: on a day you're under baseline but still BEAT your goal
// (because banked credit lowered it), you'd otherwise be flipped from credit into debt.
//
// `days` run oldest→newest; the halving makes anything past ~10 days ago negligible, so it's
// recomputed from the trailing ledger with no stored state. Days with no deficit data are
// skipped (carry the balance). goalKcal is the BASE goal for that day — do NOT pre-adjust it
// by the balance, that's what this recurrence does.
// ponytail: one baseline for the whole window (today's), so past days are judged against
// today's number rather than the one they actually had. Drift over ~10 days is a few kcal;
// thread a per-day baseline in only if the goal ever moves fast.
export function deficitBalance(
	days: { deficitKcal: number | null; goalKcal: number }[],
	maxKcal: number
): number {
	let balance = 0;
	for (const d of days) {
		if (d.deficitKcal == null || !Number.isFinite(d.deficitKcal)) continue;
		const carry = -balance; // + = extra you were asked to make up that day
		const remaining = d.goalKcal + carry - d.deficitKcal; // + = still short, − = beat it
		const owed = d.deficitKcal < d.goalKcal && remaining > 0;
		// Only aged DEBT is forgiven. Banked credit is NOT halved here — it was already spent
		// lowering today's goal, so refunding half of it would double-count: with 100 credit
		// (goal 700→600), finishing at 599 would owe 51 instead of 1, a 51-kcal cliff off a
		// 1-kcal miss. Forgiving only the debt half keeps `owed` continuous with the branch
		// below (at remaining → 0 both sides go to 0).
		const forgiven = carry > 0 ? carry / 2 : 0;
		const next = owed ? remaining - forgiven : remaining / 2;
		balance = clamp(0 - next, -maxKcal, maxKcal); // 0 − n, not −n: avoids a −0 balance
	}
	return balance;
}

// ── Daily eat-to target ──────────────────────────────────────────────────────
// Burn-anchored eat-to target, with maintenance as a CONSERVATIVE starting guess of today's
// burn. The morning floor is `TARGET_BUFFER_FRACTION × maintenance − deficit` — a slightly
// low burn estimate, minus the deficit — so it's steady and plannable before you've moved.
// As today's ACTUAL corrected burn (BMR + corrected active + TEF) climbs past that estimate,
// the target rises 1:1 with it, converging on `today's burn − deficit`: you eat back what you
// actually burn while still netting the deficit. Collapses to
// `max(fraction × maintenance, burn) + modeDelta` (+ deficit balance). Monotonic in burn — it
// never drops out from under you. `balanceKcal` (signed, see deficitBalance) shifts it:
// recovery raises it (ease off), debt lowers it (trim to catch up). On a cut the conservative
// fraction applies; recomp/lean_bulk assume full maintenance (fraction 1) so the low estimate
// can't floor them into an accidental deficit. Final target is floored at MIN_EAT_TO_KCAL so
// debt on a low-burn day can't recommend an unsafely low intake.
// ponytail: fixed safety floor; nudge if it clamps real targets.
export const MIN_EAT_TO_KCAL = 1500;

export function ratchetTarget(opts: {
	maintenanceKcal: number;
	modeDeltaKcal: number; // signed (negative = deficit)
	actualBurnKcal: number; // corrected total burn (BMR + corrected active + TEF) accrued so far today
	balanceKcal?: number; // signed deficit balance: + recovery raises eat-to, − debt lowers it; default 0
}): number {
	const fraction = opts.modeDeltaKcal < 0 ? TARGET_BUFFER_FRACTION : 1;
	const assumedBurn = Math.max(fraction * opts.maintenanceKcal, opts.actualBurnKcal);
	return Math.max(MIN_EAT_TO_KCAL, assumedBurn + opts.modeDeltaKcal + (opts.balanceKcal ?? 0));
}

// Which workout calories to trust at full value (not haircut): dedicated
// third-party trackers like the walking pad. Apple's OWN workout estimates (Watch)
// are treated like passive active energy and get the haircut, same as the rest of
// Apple's numbers. Null source (data synced before source capture) stays trusted
// to avoid a regression. ponytail: vendor-prefix heuristic — pin the pad's exact
// bundle id here once it shows up in real data.
export function isTrustedWorkoutSource(source: string | null): boolean {
	return source == null || !source.toLowerCase().includes('apple');
}

// A MANUALLY entered workout (Fitness app → Add Workout, e.g. a custom water sport) stores its
// energy only on the workout itself — it writes no activeEnergyBurned samples — so its kcal never
// reaches the daily active total that correctActive() haircuts, and as an "apple" source it isn't
// trusted either: the calories vanish from every total while still showing in the workout list.
// Detect it from data we already have: energy that IS inside the daily sum can never exceed it, so
// a workout claiming more kcal than the WHOLE day's active energy is provably uncounted. Then it
// rides at face value (the user's own number, out of the haircut) instead of being dropped.
// Uncounted kcal are ADDED to the day's active total (deficit.ts) as well as marked trusted
// (energyBreakdown.ts), so the workout rides at face value AND Apple's own active still gets its
// haircut on top: 1000 + 0.5 × 546, not max(1000, …). Detection must always run against Apple's
// PRISTINE daily total, never the post-addition one, or it flip-flops.
// ponytail: catches the gross case with zero new columns. Ceilings — a SMALL manual entry on a busy
// day still hides, and the Watch's own (low) estimate for the workout WINDOW is inside Apple's daily
// total, so that overlap is counted twice at haircut weight (~100 kcal on the motivating day).
// Upgrade path for both: have the iOS sync post the activeEnergyBurned sample sum inside each
// workout's window (the trick walkRunDistanceKm already uses), then add kcal − that sum: exact.
export function isUncountedWorkout(kcal: number | null, dayActiveKcal: number | null): boolean {
	return (kcal ?? 0) > (dayActiveKcal ?? 0);
}

// ── Workout active energy (distance workouts: runs & walks) ───────────────────
// Apple over-estimates PASSIVE active energy, so the daily total gets a weight-trend
// haircut — but a GPS workout with a MEASURED distance is physically grounded and shouldn't
// be cut like a couch estimate. So we compute the workout's OWN active kcal and let it ride
// at full value (trusted), out of the haircut pool.
//
// Method = net cost of transport: running burns ~1.0 kcal per kg of body weight per km,
// walking ~0.5 — essentially pace-independent (that constancy is why it's so robust) and
// already net of resting. distance × body weight, split by activity type.
//
// Why NOT heart rate: an HR→kcal formula (Keytel) needs the person's VO2max or it over-reads
// for fit people, and this user's VO2max syncs on ~2 days in 30. Un-calibrated HR clocked a
// 2-mile run at 260 kcal when distance, Apple's OWN workout estimate (204–233 on comparable
// runs), and the physiology all agree on ~220. With no fitness data to calibrate it, HR adds
// BIAS, not accuracy — so it's left out. Here distance × weight is both the simplest and the
// most accurate signal available. Blind spot is hills; revisit HR only if dense VO2max data
// appears. The weight-trend calibration stays the referee for absolute scale.
// ponytail: fixed cost-of-transport constants; non-transport types (cycling — where distance
// is a poor energy proxy) return null and fall back to the existing source path.
export function workoutActiveKcal(w: {
	name: string;
	distanceKm: number | null;
	weightKg: number | null;
}): number | null {
	const { name, distanceKm: dist, weightKg: wt } = w;
	if (dist == null || wt == null || dist <= 0 || wt <= 0) return null;
	const t = name.toLowerCase();
	const costPerKgKm = t.includes('run')
		? 1.0
		: t.includes('walk') || t.includes('hik')
			? 0.5
			: null;
	if (costPerKgKm == null) return null; // e.g. cycling — distance is a poor energy proxy
	return dist * wt * costPerKgKm;
}

// ── Workouts with NO energy recorded ─────────────────────────────────────────
// A third-party app can log a session to HealthKit without any calories (no workout
// kcal, no activeEnergyBurned samples of its own). Those rows would otherwise count as
// zero — worse than nothing, because a 0 makes the whole day look passive and hands the
// real burn to the haircut. So estimate them: distance first (workoutActiveKcal, the
// grounded cost-of-transport number above), and only when there's no distance to stand
// on, MET × duration.
//
// MET = Compendium of Physical Activities intensity, in multiples of resting. Minus 1 to
// get the NET cost — the same "active kcal" units everything else here uses, and what
// Apple's activeEnergyBurned means. kcal = (MET − 1) × kg × hours.
// ponytail: fixed table, no intensity/HR/fitness adjustment — a hard interval session and
// a lazy one on the same machine estimate identically. It's a floor-quality guess used
// ONLY where the alternative is 0. Upgrade path (better than any formula here): have the
// iOS sync post the summed activeEnergyBurned samples inside the workout's window — the
// Watch's own measurement, the same trick walkRunDistanceKm already uses.
const MET_BY_ACTIVITY: Array<[RegExp, number]> = [
	[/run|jog/, 9.8],
	[/hiit|interval|cross ?train/, 8.0],
	[/cycl|bike|spin/, 7.5],
	[/swim|row|paddle|elliptical/, 7.0],
	[/stair|climb/, 6.0],
	[/strength|weight|lift|functional|core/, 5.0],
	[/walk|hik/, 3.5],
	[/yoga|stretch|pilates|barre|mind/, 2.8]
];
const DEFAULT_MET = 4.0; // unknown activity: deliberately modest, not heroic

export function metWorkoutKcal(w: {
	name: string;
	minutes: number | null;
	weightKg: number | null;
}): number | null {
	const { name, minutes, weightKg: wt } = w;
	if (minutes == null || wt == null || minutes <= 0 || wt <= 0) return null;
	// A session left running (forgotten stop) would otherwise invent thousands of kcal and
	// silently inflate the eat-to target. Cap the duration that can be claimed.
	const hours = Math.min(minutes, 240) / 60;
	const t = name.toLowerCase();
	const met = MET_BY_ACTIVITY.find(([re]) => re.test(t))?.[1] ?? DEFAULT_MET;
	return (met - 1) * wt * hours;
}

// THE estimate for a workout that recorded no energy: measured distance first, MET ×
// duration as the fallback. One entry point so the ledger and the day view can't drift.
// Null when there's nothing to estimate from (no weigh-in, or no duration and no distance).
export function fallbackWorkoutKcal(w: {
	name: string;
	distanceKm: number | null;
	minutes: number | null;
	weightKg: number | null;
}): number | null {
	return (
		workoutActiveKcal({ name: w.name, distanceKm: w.distanceKm, weightKg: w.weightKg }) ??
		metWorkoutKcal({ name: w.name, minutes: w.minutes, weightKg: w.weightKg })
	);
}
