<script lang="ts">
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { kgToLb } from '$lib/energy';
	import InsulinGlucoseChart from '$lib/components/InsulinGlucoseChart.svelte';

	let { data, form } = $props();

	const bmrSourceLabel: Record<string, string> = {
		katch: 'Katch-McArdle',
		mifflin: 'Mifflin-St Jeor',
		'apple-basal': 'Apple Watch basal estimate',
		interpolated: 'BMR interpolated from nearby weigh-ins'
	};

	function fmtDate(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	function prettyMetric(name: string): string {
		const map: Record<string, string> = {
			resting_hr: 'Resting HR',
			hrv_ms: 'HRV',
			spo2_pct: 'Blood oxygen',
			hr_avg: 'Avg HR',
			hr_min: 'Min HR',
			hr_max: 'Max HR',
			resp_rate: 'Respiratory rate',
			vo2max: 'VO₂ max',
			bmi: 'BMI'
		};
		if (map[name]) return map[name];
		return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function metricUnit(name: string): string {
		const units: Record<string, string> = {
			resting_hr: 'bpm',
			hr_avg: 'bpm',
			hr_min: 'bpm',
			hr_max: 'bpm',
			hrv_ms: 'ms',
			spo2_pct: '%',
			resp_rate: 'br/min'
		};
		return units[name] ?? '';
	}

	const day = $derived(data.day);
	const entryTotals = $derived(
		data.entries.reduce(
			(a, e) => ({
				calories: a.calories + e.calories,
				proteinG: a.proteinG + e.proteinG,
				carbsG: a.carbsG + e.carbsG,
				fatG: a.fatG + e.fatG
			}),
			{ calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
		)
	);

	// Glucose summaries get their own section (below); keep them out of the generic list.
	const GLUCOSE_KEYS = ['blood_glucose_mgdl', 'glucose_tir_pct', 'glucose_gmi_pct'];
	const metricVal = (k: string) => data.metrics.find((m) => m.metric === k)?.value ?? null;

	const water = $derived(data.metrics.find((m) => m.metric === 'water_l') ?? null);
	const otherMetrics = $derived(
		data.metrics.filter((m) => m.metric !== 'water_l' && !GLUCOSE_KEYS.includes(m.metric))
	);
	const glucoseAvg = $derived(metricVal('blood_glucose_mgdl'));
	const tir = $derived(metricVal('glucose_tir_pct'));
	const gmi = $derived(metricVal('glucose_gmi_pct'));

	function workoutMinutes(startedAt: Date | string, endedAt: Date | string | null): number | null {
		if (!endedAt) return null;
		return Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000);
	}
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
	use:pullToRefresh
>
	<header class="mb-6 flex items-center gap-3">
		<a
			href="/deficit"
			class="card-sm flex h-9 w-9 shrink-0 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to energy balance"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M15 18l-6-6 6-6" />
			</svg>
		</a>
		<div class="min-w-0">
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Day detail
			</p>
			<h1 class="truncate text-xl font-bold text-white">{fmtDate(data.date)}</h1>
		</div>
		<nav class="card-sm ml-auto flex shrink-0 items-center gap-0.5 p-1" aria-label="Navigate days">
			<a
				href="/day/{data.prevDate}"
				class="flex h-7 w-7 items-center justify-center rounded-lg text-white transition hover:brightness-125"
				aria-label="Previous day"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
				>
			</a>
			<!-- No "next" past today — future days have no real data. -->
			<a
				href={data.date < data.today ? `/day/${data.nextDate}` : undefined}
				aria-disabled={data.date >= data.today}
				class="flex h-7 w-7 items-center justify-center rounded-lg text-white transition hover:brightness-125 aria-disabled:pointer-events-none aria-disabled:opacity-30"
				aria-label="Next day"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
				>
			</a>
		</nav>
	</header>

	<input
		type="date"
		value={data.date}
		max={data.today}
		onchange={(e) => goto('/day/' + e.currentTarget.value)}
		class="card-sm mb-4 w-full px-3 py-2 text-sm text-white"
		style="color-scheme: dark; background: var(--color-bg-elevated);"
		aria-label="Jump to date"
	/>

	<!-- Energy -->
	<section class="card mb-3 p-5">
		<p
			class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-accent-from);"
		>
			Energy
		</p>
		{#if day}
			<div class="ledger-row">
				<span>Intake</span><b>{Math.round(day.intakeKcal).toLocaleString()}</b>
			</div>
			<div class="ledger-row">
				<span>Resting</span><b>{day.bmrKcal?.toLocaleString() ?? '—'}</b>
			</div>
			<div class="ledger-row">
				<span>Active</span><b
					>{day.activeKcal != null ? Math.round(day.activeKcal).toLocaleString() : '—'}</b
				>
			</div>
			<div class="ledger-row">
				<span>Digestion</span><b>{Math.round(day.tefKcal).toLocaleString()}</b>
			</div>
			<div
				class="ledger-row"
				style="border-top: 1px solid var(--color-border); margin-top: 4px; padding-top: 7px;"
			>
				<span>Total burn</span><b>{day.burnedKcal?.toLocaleString() ?? '—'}</b>
			</div>
			<div class="ledger-row">
				<span class="font-medium" style="color: var(--color-text);">Deficit</span>
				{#if day.deficitKcal !== null}
					<b style={day.deficitKcal >= 0 ? 'color: #4ade80;' : 'color: #f87171;'}>
						{day.deficitKcal >= 0 ? '−' : '+'}{Math.abs(day.deficitKcal).toLocaleString()}
					</b>
				{:else}
					<b style="color: var(--color-text-subtle); font-weight: 400;">—</b>
				{/if}
			</div>

			{#if day.burnedKcal == null}
				<p class="mt-3 text-xs" style="color: var(--color-text-subtle);">
					Not enough data to estimate burn for this day.
				</p>
			{:else if day.bmrSource}
				<p class="mt-3 text-xs" style="color: var(--color-text-subtle);">
					{bmrSourceLabel[day.bmrSource] ?? day.bmrSource}
				</p>
			{/if}
		{:else}
			<p class="text-sm" style="color: var(--color-text-subtle);">No energy data for this day.</p>
		{/if}

		<!-- Break day: eat at maintenance, no deficit asked for. One per week. -->
		<form method="POST" action="?/toggleBreak" class="mt-4" use:enhance>
			<button
				type="submit"
				aria-pressed={data.breakDay}
				class="w-full rounded-xl px-3 py-2 text-sm font-semibold transition hover:brightness-125"
				style={data.breakDay
					? 'background: color-mix(in srgb, var(--color-accent-from) 20%, transparent); color: var(--color-accent-from);'
					: 'background: var(--color-bg-elevated); color: var(--color-text-subtle);'}
			>
				{data.breakDay ? 'Break day · eating at maintenance' : 'Make this a break day'}
			</button>
			<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
				{data.breakDay
					? 'No deficit asked for today — every other goal still counts. Tap to undo.'
					: 'One a week: eat at maintenance, no deficit. Marking another day this week moves it.'}
			</p>
			{#if form?.breakError}
				<p class="mt-2 text-xs text-red-400">{form.breakError}</p>
			{/if}
		</form>

		<!-- Mental health day: nothing logged, a surplus assumed, day excluded from scoring.
		     Soft budget of one a month — warned past the first, never blocked. -->
		<form method="POST" action="?/toggleMentalHealth" class="mt-3" use:enhance>
			<button
				type="submit"
				aria-pressed={data.mentalHealthDay}
				class="w-full rounded-xl px-3 py-2 text-sm font-semibold transition hover:brightness-125"
				style={data.mentalHealthDay
					? 'background: color-mix(in srgb, var(--color-accent-to) 20%, transparent); color: var(--color-accent-to);'
					: 'background: var(--color-bg-elevated); color: var(--color-text-subtle);'}
			>
				{data.mentalHealthDay ? 'Mental health day · not scored' : 'Make this a mental health day'}
			</button>
			<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
				{data.mentalHealthDay
					? 'Nothing to log — this day is out of your goals entirely, and a surplus is assumed so the scale makes sense. Tap to undo.'
					: "Don't log anything. The day leaves your goals completely and a big surplus is assumed, so a jump on the scale isn't blamed on your metabolism."}
			</p>
			{#if form?.mentalHealthDay && (form?.usedThisMonth ?? 0) > 1}
				<p class="mt-2 text-xs" style="color: var(--color-warning, #fbbf24);">
					That's {form.usedThisMonth} this month. Worth a look at what's driving them.
				</p>
			{/if}
			{#if form?.mentalHealthError}
				<p class="mt-2 text-xs text-red-400">{form.mentalHealthError}</p>
			{/if}
		</form>
	</section>

	<!-- Food log -->
	<section class="card mb-3 p-5">
		<p
			class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-fat);"
		>
			Food log
		</p>
		{#if data.entries.length === 0}
			<p class="text-sm" style="color: var(--color-text-subtle);">Nothing logged.</p>
		{:else}
			<div class="flex flex-col gap-3">
				{#each data.entries as e (e.id)}
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<p class="truncate text-sm font-medium text-white">{e.name}</p>
							<p class="text-xs" style="color: var(--color-text-subtle);">
								{#if e.amount != null && e.unit}
									{e.amount}
									{e.unit}{e.unit === 'serving' && e.amount !== 1 ? 's' : ''}
								{:else}
									×{e.servings}
								{/if}
								{#if e.brand}· {e.brand}{/if}
							</p>
						</div>
						<div class="shrink-0 text-right">
							<p class="text-sm font-semibold text-white">
								{Math.round(e.calories).toLocaleString()}
							</p>
							<p class="text-[11px]" style="color: var(--color-text-subtle);">
								<span style="color: var(--color-protein);">{Math.round(e.proteinG)}P</span>
								<span style="color: var(--color-carbs);">{Math.round(e.carbsG)}C</span>
								<span style="color: var(--color-fat);">{Math.round(e.fatG)}F</span>
							</p>
							<p class="text-[11px] font-medium" style="color: var(--color-carbs);">
								{Math.round(e.bolusableCarbsG ?? 0)}g bolusable{#if e.bolusableLowConfidence}
									⚠︎{/if}
							</p>
						</div>
					</div>
				{/each}
			</div>
			<div
				class="mt-3 flex items-center justify-between border-t pt-3 text-sm font-semibold text-white"
				style="border-color: var(--color-border);"
			>
				<span>Total</span>
				<span>
					{Math.round(entryTotals.calories).toLocaleString()} kcal ·
					<span style="color: var(--color-protein);">{Math.round(entryTotals.proteinG)}P</span>
					<span style="color: var(--color-carbs);">{Math.round(entryTotals.carbsG)}C</span>
					<span style="color: var(--color-fat);">{Math.round(entryTotals.fatG)}F</span>
				</span>
			</div>
		{/if}
	</section>

	<!-- Body -->
	<section class="card mb-3 p-5">
		<p
			class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-protein);"
		>
			Body
		</p>
		{#if data.weighIn}
			<div class="ledger-row">
				<span>Weight</span>
				<b>{kgToLb(data.weighIn.weightKg).toFixed(1)} lb</b>
			</div>
			{#if data.weighIn.bodyFatPct != null}
				<div class="ledger-row">
					<span>Body fat</span><b>{data.weighIn.bodyFatPct.toFixed(1)}%</b>
				</div>
			{/if}
			{#if data.weighIn.leanMassKg != null}
				<div class="ledger-row">
					<span>Lean / muscle mass</span><b>{kgToLb(data.weighIn.leanMassKg).toFixed(1)} lb</b>
				</div>
			{/if}
			<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
				Latest weigh-in on/before this day ({fmtDate(data.weighIn.measuredDate)})
			</p>
		{:else}
			<p class="text-sm" style="color: var(--color-text-subtle);">
				No weigh-in on or before this day.
			</p>
		{/if}
	</section>

	<!-- Workouts -->
	<section class="card mb-3 p-5">
		<p
			class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-carbs);"
		>
			Workouts
		</p>
		{#if data.workouts.length === 0}
			<p class="text-sm" style="color: var(--color-text-subtle);">No workouts.</p>
		{:else}
			<div class="flex flex-col gap-3">
				{#each data.workouts as w (w.hkUuid)}
					{@const mins = workoutMinutes(w.startedAt, w.endedAt)}
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<p class="truncate text-sm font-medium text-white">{w.name}</p>
							<p class="text-xs" style="color: var(--color-text-subtle);">
								{#if mins != null}{mins} min{/if}
								{#if w.avgHr != null}· {Math.round(w.avgHr)} avg{/if}
								{#if w.maxHr != null}/ {Math.round(w.maxHr)} max bpm{/if}
							</p>
						</div>
						{#if w.kcal != null}
							<p class="shrink-0 text-right text-sm font-semibold text-white">
								{Math.round(w.kcal)} kcal
								{#if w.estimated}
									<span class="block text-xs font-normal" style="color: var(--color-text-subtle);"
										>estimated</span
									>
								{/if}
							</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Glucose & insulin intraday trace (Dexcom/pump CGM + Tandem insulin) -->
	{#if data.glucose.length || data.insulin.length}
		<section class="card mb-3 p-5">
			<div class="mb-3 flex items-center justify-between">
				<p
					class="text-[10px] font-semibold tracking-widest uppercase"
					style="color: var(--color-text-subtle);"
				>
					Glucose &amp; Insulin
				</p>
				<div class="flex gap-4 text-xs" style="color: var(--color-text-subtle);">
					{#if glucoseAvg != null}<span>avg <b class="text-white">{Math.round(glucoseAvg)}</b></span
						>{/if}
					{#if tir != null}<span>TIR <b class="text-white">{Math.round(tir)}%</b></span>{/if}
					{#if gmi != null}<span>GMI <b class="text-white">{gmi.toFixed(1)}%</b></span>{/if}
				</div>
			</div>
			<InsulinGlucoseChart glucose={data.glucose} insulin={data.insulin} />
		</section>
	{/if}

	<!-- Metrics -->
	{#if water || otherMetrics.length}
		<section class="card mb-3 p-5">
			<p
				class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Metrics
			</p>
			{#if water}
				<div class="ledger-row">
					<span>Water</span>
					<b>{water.value.toFixed(1)} L · {Math.round(water.value * 4.22675)} cups</b>
				</div>
			{/if}
			{#each otherMetrics as m (m.metric)}
				<div class="ledger-row">
					<span>{prettyMetric(m.metric)}</span>
					<b>{Number.isInteger(m.value) ? m.value : m.value.toFixed(1)} {metricUnit(m.metric)}</b>
				</div>
			{/each}
		</section>
	{/if}
</main>

<style>
	.ledger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		color: var(--color-text-muted);
		padding: 3px 0;
	}
	.ledger-row b {
		color: white;
		font-weight: 600;
	}
</style>
