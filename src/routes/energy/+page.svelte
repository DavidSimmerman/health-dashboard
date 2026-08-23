<script lang="ts">
	import { enhance } from '$app/forms';

	let { data } = $props();
	let b = $derived(data.breakdown);

	const modes = [
		{ key: 'cut', label: 'Cut' },
		{ key: 'recomp', label: 'Recomp' },
		{ key: 'lean_bulk', label: 'Lean bulk' }
	];

	let deltaLabel = $derived(
		b.breakDay
			? 'break day · at maintenance'
			: b.mode === 'recomp'
				? 'at maintenance'
				: b.modeDeltaKcal == null
					? ''
					: b.modeDeltaKcal < 0
						? `${Math.abs(b.modeDeltaKcal).toLocaleString()} deficit / day`
						: `+${b.modeDeltaKcal.toLocaleString()} surplus / day`
	);

	let daysDesc = $derived([...b.days].reverse());
	let today = $derived(daysDesc.find((d) => d.date === b.today));
	let prior = $derived(
		daysDesc.filter((d) => d.date !== b.today && (d.intakeKcal > 0 || d.activeKcal))
	);

	const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString());

	function shortDate(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
>
	<header class="mb-6 flex items-center gap-3">
		<a
			href="/"
			class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to today"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
			>
		</a>
		<div>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Energy breakdown
			</p>
			<h1 class="text-2xl font-bold text-white">Where your calories come from</h1>
		</div>
	</header>

	<!-- Mode + dynamic target -->
	<section class="card p-5" style="border-color: rgba(251, 146, 60, 0.35);">
		<form
			method="POST"
			action="?/setMode"
			use:enhance
			class="card-sm mb-4 flex items-center gap-0.5 p-1"
		>
			{#each modes as m (m.key)}
				<button
					name="mode"
					value={m.key}
					class="flex-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition"
					class:accent-gradient={b.mode === m.key}
					style={b.mode === m.key ? 'color: #000;' : 'color: var(--color-text-subtle);'}
				>
					{m.label}
				</button>
			{/each}
		</form>

		<div class="flex items-baseline justify-between">
			<span class="text-sm" style="color: var(--color-text-muted);">Today's target</span>
			<span class="text-3xl font-bold tracking-tight text-white">{num(b.targetKcal)}</span>
		</div>
		<p class="mt-1 text-xs" style="color: var(--color-text-subtle);">
			{num(b.maintenanceKcal)} maintenance
			{#if b.maintenanceSource === 'calibrated'}(calibrated to your weight trend){:else if b.maintenanceSource === 'estimated'}(formula
				estimate — log more to calibrate){/if}
			{#if deltaLabel}· <span style="color: var(--color-accent-from);">{deltaLabel}</span>{/if}
			{#if b.bodyFatPct != null && b.mode === 'cut'}· scaled to {b.bodyFatPct.toFixed(1)}% body fat{/if}
		</p>

		<p class="mt-3 text-xs" style="color: var(--color-text-subtle);">
			{#if b.breakDay}Break day: no deficit asked for. The target is your maintenance, and it still
				climbs with anything extra you burn.{:else if b.todayDeltaKcal != null && b.todayDeltaKcal < 0}Starts
				at a conservative burn estimate (90% of your maintenance) minus your deficit, then climbs
				toward (today's burn − deficit) as you out-burn that estimate — so you eat back what you
				actually burn.{:else}Tracks today's burn: eat back what you burn, adjusted for your goal.{/if}
			It never drops out from under you.
		</p>
		{#if b.balanceKcal > 0}
			<p class="mt-1 text-xs" style="color: var(--color-accent-from);">
				+{num(b.balanceKcal)} recovery — eased up after recent big-deficit days so you don't lose too
				fast. Fades over the next day or two.
			</p>
		{:else if b.balanceKcal < 0}
			<p class="mt-1 text-xs" style="color: var(--color-fat);">
				{num(b.balanceKcal)} debt — trimmed after recent days under your deficit goal, to catch back up.
				Fades over the next day or two.
			</p>
		{/if}
	</section>

	<!-- Maintenance + active-energy correction -->
	<section class="card-sm mt-3 p-4">
		<p
			class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-text-subtle);"
		>
			Active-energy correction
		</p>
		<div class="ledger-row">
			<span>Apple's estimate (formula)</span><b>{num(b.estimatedTdee)}</b>
		</div>
		<div class="ledger-row">
			<span>Calibrated to your weight</span><b>{num(b.calibratedTdee)}</b>
		</div>
		<div
			class="ledger-row"
			style="border-top: 1px solid rgba(255,255,255,0.07); margin-top:4px; padding-top:7px;"
		>
			<span>Apple active haircut</span><b>×{b.factor.toFixed(2)}</b>
		</div>
		<div class="ledger-row">
			<span>Avg active: Apple → corrected</span><b
				>{num(b.avgRawActive)} → {num(b.avgCorrectedActive)}</b
			>
		</div>
		<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
			{#if b.avgTrustedKcal}Workout calories ({num(b.avgTrustedKcal)}/day avg) ride out of the
				haircut — runs/walks are recomputed from distance & body weight (net cost of transport), and
				the walking pad rides as-is. Only Apple's passive estimate is corrected.{:else}Only Apple's
				passive active-energy estimate is corrected; workout tracking rides at full value.{/if}
		</p>
	</section>

	<!-- Today -->
	{#if today && (today.intakeKcal > 0 || today.activeKcal)}
		<section class="card-sm mt-3 p-4">
			<p
				class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Today · {shortDate(today.date)}
			</p>
			<div class="ledger-row"><span>Eaten</span><b>{num(today.intakeKcal)}</b></div>
			<div class="ledger-row"><span>Resting (BMR)</span><b>{num(today.bmrKcal)}</b></div>
			<div class="ledger-row">
				<!-- "logged", not "Apple": hand-entered workouts Apple left out are added in here. -->
				<span>Active — logged</span><b>{num(today.activeKcal)}</b>
			</div>
			{#each today.workouts as w (w.startedAt)}
				<div class="ledger-row" style="padding-left: 12px; font-size: 12px;">
					<span style="color: var(--color-text-subtle);"
						>↳ {w.name} · {w.time}
						{#if w.estimated}<span style="color: var(--color-amber, #fbbf24);">our est.</span
							>{:else if w.trusted}<span style="color: var(--color-mint, #34d399);">trusted</span
							>{:else}<span style="color: var(--color-text-subtle);">Apple est.</span
							>{/if}{#if w.appleWindowKcal != null}
							<!-- What Apple already had for this window — the number actually taken out of
							     "logged" before the rest is haircut. Without it the jump from logged to
							     corrected looks like it doesn't add up. -->
							· Apple had {Math.round(w.appleWindowKcal)} here{/if}</span
					>
					<b style="font-weight: 500;">{num(w.kcal)}</b>
				</div>
			{/each}
			<div class="ledger-row">
				<span>Active — corrected</span><b>{num(today.correctedActiveKcal)}</b>
			</div>
			<div class="ledger-row"><span>Digestion (TEF)</span><b>{num(today.tefKcal)}</b></div>
			<div
				class="ledger-row"
				style="border-top: 1px solid rgba(255,255,255,0.07); margin-top:4px; padding-top:7px;"
			>
				<span>Total burn (corrected)</span><b>{num(today.correctedBurnedKcal)}</b>
			</div>
			<div class="ledger-row">
				<span>Deficit so far</span>
				<b
					style={today.correctedDeficitKcal != null && today.correctedDeficitKcal < 0
						? 'color: var(--color-fat);'
						: ''}
				>
					{#if today.correctedDeficitKcal != null}{today.correctedDeficitKcal >= 0
							? '−'
							: '+'}{Math.abs(today.correctedDeficitKcal).toLocaleString()}{:else}—{/if}
				</b>
			</div>
		</section>
	{/if}

	<!-- Recent days -->
	{#if prior.length}
		<section class="card-sm mt-3 p-4">
			<p
				class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Recent days · corrected deficit
			</p>
			{#each prior as d (d.date)}
				<div class="ledger-row">
					<span class="w-28 shrink-0">{shortDate(d.date)}</span>
					<span class="flex-1 text-right" style="color: var(--color-text-subtle); font-size: 12px;">
						{num(d.activeKcal)}→{num(d.correctedActiveKcal)} active
					</span>
					<b
						class="ml-3 w-14 text-right"
						style={d.correctedDeficitKcal != null && d.correctedDeficitKcal < 0
							? 'color: var(--color-fat);'
							: ''}
					>
						{#if d.correctedDeficitKcal != null}{d.correctedDeficitKcal >= 0 ? '−' : '+'}{Math.abs(
								d.correctedDeficitKcal
							).toLocaleString()}{:else}—{/if}
					</b>
				</div>
			{/each}
		</section>
	{/if}

	<p class="mt-4 px-1 text-center text-xs" style="color: var(--color-text-subtle);">
		Target = calibrated maintenance {b.mode === 'cut'
			? '− a leanness-scaled deficit'
			: b.mode === 'lean_bulk'
				? '+ a small surplus'
				: '(hold)'}. Active energy is corrected against your actual weight trend; workout tracking
		is trusted.
	</p>
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
