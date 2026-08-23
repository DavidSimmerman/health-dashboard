// Runnable check for the projection math: `npx tsx src/lib/energy.selfcheck.ts`.
// No test framework — just asserts. Exits non-zero on failure.
import assert from 'node:assert/strict';
import {
	linearRegression,
	interpolateGaps,
	etaDaysToGoal,
	daysBetween,
	addDays,
	bodyFatPctFromLean,
	katchMcArdleBmr,
	tefKcal,
	targetRatePctPerWeek,
	modeDeficit,
	correctActive,
	activeCorrectionFactor,
	ratchetTarget,
	targetBaseline,
	deficitBalance,
	isTrustedWorkoutSource,
	isUncountedWorkout,
	workoutActiveKcal,
	metWorkoutKcal,
	fallbackWorkoutKcal
} from './energy.ts';

// linearRegression recovers a known line y = 2x + 1
{
	const fit = linearRegression([
		{ x: 0, y: 1 },
		{ x: 1, y: 3 },
		{ x: 2, y: 5 },
		{ x: 3, y: 7 }
	]);
	assert(fit, 'fit should exist');
	assert(Math.abs(fit!.slope - 2) < 1e-9, `slope ${fit!.slope}`);
	assert(Math.abs(fit!.intercept - 1) < 1e-9, `intercept ${fit!.intercept}`);
}
// degenerate inputs → null
assert.equal(linearRegression([{ x: 1, y: 1 }]), null);
assert.equal(
	linearRegression([
		{ x: 5, y: 1 },
		{ x: 5, y: 9 }
	]),
	null
); // all x equal

// interpolateGaps fills the middle and carries the ends
assert.deepEqual(interpolateGaps([1, null, 3]), [1, 2, 3]);
assert.deepEqual(interpolateGaps([null, 2, null]), [2, 2, 2]);
assert.deepEqual(interpolateGaps([null, null]), [null, null]);
assert.deepEqual(interpolateGaps([1, null, null, 4]), [1, 2, 3, 4]);

// etaDaysToGoal: losing 0.1kg/day from 80 to 75 = 50 days; wrong-way = null
assert.equal(etaDaysToGoal(80, 75, -0.1), 50);
assert.equal(etaDaysToGoal(80, 75, 0.1), null);
assert.equal(etaDaysToGoal(75, 75, -0.1), 0);
assert.equal(etaDaysToGoal(80, 75, 0), null);

// date helpers
assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
assert.equal(addDays('2026-01-01', 30), '2026-01-31');
assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30); // spans US DST change

// body fat from lean mass: 80kg, 64kg lean → 20%
assert.equal(bodyFatPctFromLean(80, 64), 20);

// sanity: existing formulas still wired
assert.equal(katchMcArdleBmr(60), 370 + 21.6 * 60);
assert(Math.abs(tefKcal(100, 0, 0) - 0.27 * 4 * 100) < 1e-9);

// ── Dynamic deficit ──────────────────────────────────────────────────────────
// Cut at 18% bf, ~69.3kg → ≈ −500 kcal/day (≈1 lb/wk).
{
	const d = modeDeficit('cut', 18, 69.3);
	assert(d < 0, `cut is a deficit, got ${d}`);
	assert(Math.abs(d - -503) < 15, `cut@18% ≈ −503, got ${Math.round(d)}`);
}
assert.equal(modeDeficit('recomp', 18, 69.3), 0); // recomp holds at maintenance
assert(modeDeficit('lean_bulk', 18, 69.3) > 0, 'lean bulk is a surplus');
// Leanness scaling: harder when fat to spare, gentler when lean; clamped.
assert.equal(targetRatePctPerWeek('cut', 30), -1.0); // ramp hits the −1.0%/wk cap
assert.equal(targetRatePctPerWeek('cut', 8), -0.3); // eased to the −0.3%/wk floor
assert(targetRatePctPerWeek('cut', 20) < targetRatePctPerWeek('cut', 15)); // more bf ⇒ bigger (more negative) cut

// ── Active-energy correction ─────────────────────────────────────────────────
// 400 trusted (pad) rides at 1.0; only the 600 passive gets ×0.7 → 400 + 420.
assert.equal(correctActive(1000, 400, 0.7), 820);
assert.equal(correctActive(500, 800, 0.7), 800); // trusted ≥ total ⇒ passive floored at 0
// factor: real active 600, raw 900, trusted 300 → passive 600, realPassive 300 → 0.5.
assert.equal(activeCorrectionFactor(600, 900, 300), 0.5);
assert.equal(activeCorrectionFactor(600, 320, 300), 1); // ~no passive signal ⇒ no correction
assert.equal(activeCorrectionFactor(200, 900, 0), 0.4); // clamped to floor

// ── Daily eat-to target ──────────────────────────────────────────────────────
// Burn-anchored: conservative burn estimate = 0.9 × 2400 = 2160; floor = 2160 − 500 = 1660.
// Once actual burn passes 2160, target = burn − 500.
const rt = (actualBurnKcal: number) =>
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal
	});
assert.equal(rt(1800), 1660); // burn below the conservative estimate → held at the floor
assert.equal(rt(2160), 1660); // right at the estimate → floor
assert.equal(rt(2900), 2400); // out-burned the estimate → burn − deficit (climbs 1:1)
assert.equal(rt(3000), 2500); // keeps tracking real burn
assert(rt(2900) > rt(2160)); // rises once you out-burn the estimate
assert(rt(3000) >= rt(2900)); // monotonic non-decreasing in actual burn

// The 90% haircut is a CUT-only conservative burn estimate: recomp/lean_bulk assume FULL
// maintenance, so a low-burn day can't floor them below maintenance into an accidental deficit.
assert.equal(targetBaseline(2400, -500), 1660); // cut floor → 0.9×2400 − 500
assert.equal(targetBaseline(2400, 0), 2400); // recomp floor → maintenance, no haircut
assert.equal(targetBaseline(2400, 150), 2550); // lean bulk floor → maintenance + surplus
// recomp on a low-burn day still targets maintenance (no phantom deficit); a high-burn day eats back
assert.equal(
	ratchetTarget({ maintenanceKcal: 2400, modeDeltaKcal: 0, actualBurnKcal: 2000 }),
	2400
);
assert.equal(
	ratchetTarget({ maintenanceKcal: 2400, modeDeltaKcal: 0, actualBurnKcal: 2900 }),
	2900
);

// ── Deficit balance (recovery + debt) ─────────────────────────────────────────
// Baseline goal 700, cap ±500. Every day is scored against the goal it was SHOWN
// (700 + carryover). Dip under baseline while short → that debt carries IN FULL;
// everything else halves. Balance sign: + = recovery, − = debt (carryover = −balance).
const G = 700;
const bal = (ds: number[]) =>
	deficitBalance(
		ds.map((d) => ({ deficitKcal: d, goalKcal: G })),
		500
	);

assert.equal(bal([700]), 0); // exactly on goal → nothing owed, nothing earned
assert.equal(bal([900]), 100); // beat by 200 → credit halves (100/50/25… = 200 back in total)
assert.equal(bal([300]), -400); // 400 under BASELINE → owed IN FULL tomorrow (goal 1100)
assert.equal(bal([5000]), 500); // huge deficit → +cap
assert.equal(bal([-1000]), -500); // big surplus → −cap (debt), clamped
assert.equal(bal([null as unknown as number]), 0); // no data → skipped

// Credit decays by half: beat by 400, then sit exactly on the (lowered) goal.
assert.equal(bal([1100, 700]), 100); // goal 300 → beat by 400 → 200 credit; then 700 vs 500 → +100

// THE BUG THIS REPLACED: fall short, then do the catch-up. You must never be paid for
// missing the number on screen. 400 under → owe 400 → goal 1100.
assert.equal(bal([300, 1100]), 0); // hit 1100 exactly → debt cleared, NO recovery minted
assert.equal(bal([300, 1050]), -25); // 50 short of 1100 (but over baseline) → still in debt, halved
assert.equal(bal([300, 1200]), 50); // beat 1100 by 100 → half of the genuine overshoot

// Dip under baseline again and the NEW shortfall is owed in full, while the OLD carry halves —
// this is what keeps a bad streak from compounding into an unreachable ask.
assert.equal(bal([300, 500]), -400); // owe 400 → goal 1100, did 500: (700−500) + 400/2 = 400
assert.equal(bal([300, 500, 500]), -400); // steady 200-under settles, doesn't spiral

// THE GUARD: under baseline but you BEAT your goal (banked credit lowered it). Beating your
// goal must never flip you into debt.
assert.equal(bal([900, 650]), 25); // goal 600, did 650 → beat by 50 → stays CREDIT (+25)

// NO CLIFF at the goal line: banked credit is spent in full, not halved, so missing a
// credit-lowered goal by 1 owes 1 — not 51. (900 → 100 credit → next goal 600.)
assert.equal(bal([900, 600]), 0); // dead on the shown goal → nothing owed
assert.equal(bal([900, 599]), -1); // 1 short → owe 1
assert.equal(bal([900, 550]), -50); // 50 short → owe 50, in full (under baseline = real debt)
for (let v = 560; v <= 640; v += 5) {
	// continuous either side of the boundary: no jump bigger than the step itself
	assert.ok(Math.abs(bal([900, v]) - bal([900, v + 5])) <= 5.01, `cliff at ${v}`);
}

// Steady overshoot converges to exactly that overshoot — eat back what you over-did, not double.
assert.ok(Math.abs(bal(Array(20).fill(900)) - 200) < 1);
// balance shifts the eat-to target 1:1: recovery raises it, debt lowers it
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 2900,
		balanceKcal: 300
	}),
	2700 // 2900 − 500 + 300 recovery
);
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 2900,
		balanceKcal: -300
	}),
	2100 // 2900 − 500 − 300 debt
);
// safety floor: deep debt on a low-burn day can't recommend an unsafely low intake
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 1800,
		balanceKcal: -500
	}),
	1500 // 2160 − 500 − 500 = 1160 → floored to MIN_EAT_TO_KCAL
);

// Trusted workout source: dedicated third-party trackers yes, Apple's own no,
// null (pre-capture) yes (no regression).
assert.equal(isTrustedWorkoutSource(null), true);
assert.equal(isTrustedWorkoutSource('com.kingsmith.walkingpad'), true);
assert.equal(isTrustedWorkoutSource('com.apple.health'), false);
assert.equal(isTrustedWorkoutSource('com.apple.workout.build'), false);

// Workout active energy: net cost of transport, distance × weight, split by activity type.
{
	// Run ~1.0 kcal/kg/km, walk ~0.5. Activity word decides, case-insensitive.
	assert.equal(workoutActiveKcal({ name: 'Run', distanceKm: 10, weightKg: 70 }), 700);
	assert.equal(workoutActiveKcal({ name: 'Outdoor Walk', distanceKm: 5, weightKg: 70 }), 175);
	assert.equal(workoutActiveKcal({ name: 'Trail Running', distanceKm: 4, weightKg: 80 }), 320);
	// No distance → null (e.g. strength training — leave it to the existing path).
	assert.equal(workoutActiveKcal({ name: 'Run', distanceKm: null, weightKg: 70 }), null);
	assert.equal(
		workoutActiveKcal({ name: 'Strength Training', distanceKm: null, weightKg: 70 }),
		null
	);
	// Non-transport activity where distance is a poor energy proxy → null (fall back).
	assert.equal(workoutActiveKcal({ name: 'Cycling', distanceKm: 20, weightKg: 70 }), null);
}

// Uncounted (manually entered) workout: kcal that Apple's daily active total can't contain.
{
	// The real case: a 1,000 kcal hand-entered water sport on a day Apple only logged 546 active.
	assert.equal(isUncountedWorkout(1000, 546), true);
	// A Watch workout is a SUBSET of the day's active energy → never flagged.
	assert.equal(isUncountedWorkout(836, 1275), false);
	assert.equal(isUncountedWorkout(546, 546), false); // equal ⇒ could be inside it ⇒ no
	// No daily active row at all (nothing synced) → nothing to be inside of.
	assert.equal(isUncountedWorkout(300, null), true);
	assert.equal(isUncountedWorkout(null, 500), false);
	// End to end: deficit.ts ADDS uncounted kcal into the day's active (546 + 1000) and
	// energyBreakdown marks the workout trusted, so it rides at face value AND Apple's own 546
	// still gets the haircut on top — the calories add together, they don't replace each other.
	assert.equal(correctActive(546 + 1000, 1000, 0.5), 1000 + 0.5 * 546);
	// A counted (Watch) workout is already inside the day's total: it only carves ITSELF out of
	// the haircut — 836 at face value + half of the remaining 439 passive. No addition.
	assert.equal(correctActive(1275, 836, 0.5), 836 + 0.5 * 439);
}

// Workout logged with NO energy recorded (third-party app tracked the session, not the calories).
{
	// The motivating case: a 56-min run at 66.9 kg logged by an app that wrote no kcal.
	// With distance, the grounded cost-of-transport number wins over the MET table.
	assert.equal(workoutActiveKcal({ name: 'Run', distanceKm: 8, weightKg: 66.9 }), 8 * 66.9 * 1.0);
	// No distance to stand on → MET × duration, NET of rest ((MET − 1), not MET).
	const run = metWorkoutKcal({ name: 'Run', minutes: 55.6, weightKg: 66.9 });
	assert(run != null && Math.abs(run - (9.8 - 1) * 66.9 * (55.6 / 60)) < 1e-9, `run ${run}`);
	assert(run! > 500 && run! < 600, `a hard 56-min run should land ~545 kcal, got ${run}`);
	// Activity matched case-insensitively; unknown names get the modest default, not the max.
	assert.equal(
		metWorkoutKcal({ name: 'STRENGTH TRAINING', minutes: 60, weightKg: 70 }),
		(5.0 - 1) * 70 * 1
	);
	const unknown = metWorkoutKcal({ name: 'Kitesurfing', minutes: 60, weightKg: 70 });
	assert.equal(unknown, (4.0 - 1) * 70 * 1);
	assert(unknown! < metWorkoutKcal({ name: 'Run', minutes: 60, weightKg: 70 })!);
	// Missing inputs → null (never a bogus 0 that would read as "no burn").
	assert.equal(metWorkoutKcal({ name: 'Run', minutes: null, weightKg: 70 }), null);
	assert.equal(metWorkoutKcal({ name: 'Run', minutes: 60, weightKg: null }), null);
	assert.equal(metWorkoutKcal({ name: 'Run', minutes: 0, weightKg: 70 }), null);
	assert.equal(metWorkoutKcal({ name: 'Run', minutes: -5, weightKg: 70 }), null);
	// A workout left running all night is capped at 4h, not billed for 14.
	assert.equal(
		metWorkoutKcal({ name: 'Walk', minutes: 14 * 60, weightKg: 70 }),
		metWorkoutKcal({ name: 'Walk', minutes: 240, weightKg: 70 })
	);
	// The estimate is TRUSTED (out of the haircut), not ADDED: the Watch was on the wrist, so
	// the run's burn is already inside Apple's daily active. 717 total, ~545 of it the run.
	assert.equal(correctActive(717.6, 545, 0.5), 545 + 0.5 * (717.6 - 545));
	// Before the fix this booked 0 trusted kcal and haircut the whole day — strictly worse.
	assert(correctActive(717.6, 545, 0.5) > correctActive(717.6, 0, 0.5));
	// Ran without the Watch: the estimate exceeds Apple's whole day, so it BECOMES the day's
	// active (passive floors at 0) rather than double-counting or blowing up.
	assert.equal(correctActive(300, 545, 0.5), 545);
	// …and when the daily aggregate never synced at all, deficit.ts opens the day at 0 raw so
	// the trusted estimate still lands in burn. That reduces to exactly the estimate — the
	// workout must never be silently dropped just because Apple's daily row is missing.
	assert.equal(correctActive(0, 545, 0.5), 545);
	// fallbackWorkoutKcal prefers measured distance over the MET guess, and is null-safe.
	assert.equal(
		fallbackWorkoutKcal({ name: 'Run', distanceKm: 8, minutes: 55.6, weightKg: 66.9 }),
		8 * 66.9
	);
	assert.equal(
		fallbackWorkoutKcal({ name: 'Strength Training', distanceKm: null, minutes: 60, weightKg: 70 }),
		(5.0 - 1) * 70
	);
	assert.equal(
		fallbackWorkoutKcal({ name: 'Run', distanceKm: null, minutes: null, weightKg: 66.9 }),
		null
	);
	assert.equal(
		fallbackWorkoutKcal({ name: 'Run', distanceKm: 8, minutes: 55, weightKg: null }),
		null
	);
}

console.log('energy.selfcheck: all assertions passed ✓');
