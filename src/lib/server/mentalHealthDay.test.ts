import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// The arithmetic at the heart of a mental health day, against the real ledger: nothing is
// logged, so intake is IMPUTED at that day's own maintenance + MENTAL_HEALTH_SURPLUS_KCAL.
// Without it the calibration sees a weight gain with zero food behind it and "explains" it
// by revising TDEE down — the exact failure this feature exists to prevent. The companion
// assertion is that the same day vanishes from the scoring metrics entirely.
//
// Needs a database; skipped without DATABASE_URL so `pnpm test:unit` still runs bare. The
// date is DISCOVERED (any day with an expenditure estimate) rather than hard-coded, and any
// real granted-day row on it is snapshotted and put back — this may run against a dev DB
// with real data in it.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('mental health day', () => {
	let sql: any;
	let date: string | null = null;
	let saved: { date: string; kind: string } | null = null;

	beforeAll(async () => {
		const { default: postgres } = await import('postgres');
		sql = postgres(url!, { max: 1 });
		const { deficitDays } = await import('./deficit');
		// Any completed day the ledger can already price. Without one there's no maintenance
		// to anchor the imputation to and the test has nothing to assert.
		const { todayLabel } = await import('./day');
		const today = todayLabel();
		const from = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 86_400_000)
			.toISOString()
			.slice(0, 10);
		const priced = (await deficitDays(from, today)).filter(
			(d) => d.date < today && d.burnedKcal != null && !d.mentalHealth
		);
		date = priced.length ? priced[priced.length - 1].date : null;
		if (!date) return;
		const rows = await sql`SELECT date, kind FROM break_days WHERE date = ${date}`;
		saved = rows.length ? { date: rows[0].date, kind: rows[0].kind } : null;
		await sql`DELETE FROM break_days WHERE date = ${date}`;
	});

	afterAll(async () => {
		if (date) {
			await sql`DELETE FROM break_days WHERE date = ${date}`;
			if (saved) await sql`INSERT INTO break_days ${sql(saved)}`;
		}
		await sql.end();
	});

	it('imputes maintenance + the surplus, and drops the day from scoring', async () => {
		if (!date) return; // no priced day in this database — nothing to assert against
		const { deficitDays, MENTAL_HEALTH_SURPLUS_KCAL } = await import('./deficit');
		const { dayMetricsForRange } = await import('./goals');

		// Baseline: the day prices normally and is visible to scoring.
		const before = (await deficitDays(date, date))[0];
		expect(before.imputed).toBe(false);
		expect(await dayMetricsForRange(date, date)).toHaveLength(1);

		await sql`INSERT INTO break_days ${sql({ date, kind: 'mental_health' })}`;

		const after = (await deficitDays(date, date))[0];
		expect(after.imputed).toBe(true);
		// Burn is measured, so it must not move; only the assumed intake is new.
		expect(after.burnedKcal).toBe(before.burnedKcal);
		// Intake is now maintenance + the surplus, so the day reads as a SURPLUS of exactly
		// that allowance rather than as a day of fasting.
		expect(after.intakeKcal).toBe(Math.round(after.burnedKcal! + MENTAL_HEALTH_SURPLUS_KCAL));
		expect(after.deficitKcal).toBe(-MENTAL_HEALTH_SURPLUS_KCAL);

		// ...and it is gone from the metrics every scoring surface reads, so it can neither
		// be marked a miss nor inflate a week toward 100 on goals it never attempted.
		expect(await dayMetricsForRange(date, date)).toHaveLength(0);
	});

	it('rejects impossible dates instead of normalising them into another month', async () => {
		const { toggleMentalHealthDay } = await import('./breakDays');
		// Date() ACCEPTS these and silently rolls them forward, which would store a row under
		// a date no day view can reach. Well-formed is not the same as real.
		await expect(toggleMentalHealthDay('2026-02-31')).rejects.toThrow();
		await expect(toggleMentalHealthDay('2025-02-29')).rejects.toThrow();
		await expect(toggleMentalHealthDay('2026-13-01')).rejects.toThrow();
		await expect(toggleMentalHealthDay('not-a-date')).rejects.toThrow();
	});

	it('still imputes when the burn had to be interpolated', async () => {
		if (!date) return;
		const { fillBmrGaps } = await import('./projections');
		const { MENTAL_HEALTH_SURPLUS_KCAL } = await import('./deficit');
		// A mental health day whose BMR only appears via interpolation must not be booked as
		// a full-day fast the moment fillBmrGaps invents a burn for it.
		const gap = {
			date,
			intakeKcal: 0,
			proteinG: 0,
			bmrKcal: null,
			bmrSource: null,
			activeKcal: 300,
			tefKcal: 0,
			burnedKcal: null,
			deficitKcal: null,
			weightKg: null,
			mentalHealth: true,
			imputed: false
		} as const;
		const neighbour = { ...gap, bmrKcal: 1700, mentalHealth: false };
		const [, filled] = fillBmrGaps([
			{ ...neighbour, date: '2020-01-01' },
			{ ...gap },
			{ ...neighbour, date: '2020-01-03' }
		]);
		expect(filled.imputed).toBe(true);
		expect(filled.deficitKcal).toBe(-MENTAL_HEALTH_SURPLUS_KCAL);
		expect(filled.intakeKcal).toBe(filled.burnedKcal! + MENTAL_HEALTH_SURPLUS_KCAL);
	});
});
