<script lang="ts">
	import { onMount } from 'svelte';
	import MacroRing from '$lib/components/MacroRing.svelte';
	import MacroBar from '$lib/components/MacroBar.svelte';
	import { sumMacros, pct, formatTime } from '$lib/macros';
	import { grade } from '$lib/score';

	// Goal-ring colour by score — same thresholds as the /goals page rings.
	function goalColor(s: number | null): string {
		if (s == null) return '#3f3f46';
		if (s >= 90) return '#4ade80'; // green
		if (s >= 75) return '#fb923c'; // orange
		if (s >= 50) return '#fbbf24'; // yellow
		return '#fb7185'; // red
	}
	import { entryDisplay } from '$lib/units';
	import StatRing from '$lib/components/StatRing.svelte';
	import EditEntrySheet from '$lib/components/EditEntrySheet.svelte';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';

	let { data } = $props();

	// Planned (scheduled-but-unconfirmed) meals fold into the totals so the calorie
	// ring / protein bar "remaining" reads as what's left for snacks after dinner.
	let totals = $derived(sumMacros([...data.todayEntries, ...data.plannedMeals]));
	let goalPct = $derived(pct(totals.calories, data.calorieTarget));
	let editingEntry = $state<(typeof data.todayEntries)[number] | null>(null);

	// Default a new schedule to the next round hour (HH:00, local) so the time field
	// starts somewhere sensible for a "dinner later" plan.
	function defaultTime(): string {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, mutated, formatted in one call
		const d = new Date();
		d.setHours(d.getHours() + 1, 0, 0, 0);
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}
	// "HH:MM" (local, today) → ISO instant for the API.
	function timeToISO(hhmm: string): string {
		const [h, m] = hhmm.split(':').map(Number);
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, mutated, serialized to ISO in one call
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d.toISOString();
	}

	// One in-flight guard + one error line for every quick mutating action here.
	// The guard: a double-tap would race two POSTs before location.reload() lands
	// (double-log). The ok-check: a 400 (e.g. a past schedule time) used to clear
	// state and reload as fake success. pendingKey stays set on success (the
	// reload replaces the page) and clears on failure so a retry works.
	let pendingKey = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	async function act(key: string, url: string, init?: RequestInit): Promise<boolean> {
		if (pendingKey) return false;
		pendingKey = key;
		actionError = null;
		try {
			const res = await fetch(url, init);
			if (res.ok) return true;
			actionError = (await res.json().catch(() => null))?.message ?? `Failed (${res.status})`;
		} catch {
			actionError = 'Network error — try again.';
		}
		pendingKey = null;
		return false;
	}
	const postJson = (body: unknown): RequestInit => ({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	async function quickAdd(foodId: string) {
		if (await act(`quick:${foodId}`, '/api/log', postJson({ foodId, servings: 1 })))
			location.reload();
	}

	// Quick-add scheduling: tapping a tile's clock opens one shared time row.
	// Kept open on failure so the user can fix the time (server names the reason).
	let schedulingQuick = $state<{ foodId: string; name: string } | null>(null);
	let quickTime = $state('');
	async function scheduleQuick() {
		if (!schedulingQuick) return;
		// Guard before timeToISO — a cleared input would throw RangeError outside act().
		if (!/^\d{2}:\d{2}$/.test(quickTime)) {
			actionError = 'Pick a time first.';
			return;
		}
		const body = postJson({
			foodId: schedulingQuick.foodId,
			servings: 1,
			scheduledAt: timeToISO(quickTime)
		});
		if (await act('schedule', '/api/planned', body)) {
			schedulingQuick = null;
			location.reload();
		}
	}

	async function confirmPlanned(id: string) {
		if (await act(`confirm:${id}`, `/api/planned/${id}`, { method: 'POST' })) location.reload();
	}
	async function removePlanned(id: string) {
		if (await act(`remove:${id}`, `/api/planned/${id}`, { method: 'DELETE' })) location.reload();
	}

	// Whether the calorie ring and protein bar lead with what's left vs. consumed.
	// Shared across both so a tap on either keeps them consistent; persisted locally.
	const MODE_KEY = 'macroDisplayMode';
	let showRemaining = $state(true);
	// A day off never leads with what's LEFT: "2,213 kcal left" / "180g left" is a target to
	// chase, and today has none. The consumed framing shows the same numbers as a record of
	// the day instead of a demand on it, and it already exists — no separate no-target mode.
	let leadWithRemaining = $derived(showRemaining && !data.mentalHealthDay);

	onMount(() => {
		if (localStorage.getItem(MODE_KEY) === 'consumed') showRemaining = false;
	});

	function toggleMode() {
		showRemaining = !showRemaining;
		localStorage.setItem(MODE_KEY, showRemaining ? 'remaining' : 'consumed');
	}

	// The SERVER's day (APP_TZ), not the browser's: every number on this page is
	// bucketed by that date, so the header must name the same day it links to.
	const fmtToday = (opts: Intl.DateTimeFormatOptions) =>
		new Date(`${data.today}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
	const weekday = $derived(fmtToday({ weekday: 'long' }));
	const monthDay = $derived(fmtToday({ month: 'long', day: 'numeric' }));
</script>

<main class="mx-auto max-w-md p-6" use:pullToRefresh>
	<header class="mb-1 flex items-center justify-between">
		<!-- The date opens today's day detail: full ledger, food log, break-day toggle. -->
		<a
			href="/day/{data.today}"
			class="transition hover:brightness-125"
			aria-label="Open today's detail"
		>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				{weekday}
			</p>
			<h1 class="flex items-center gap-1 text-2xl font-bold text-white">
				{monthDay}
				<!-- Chevron so the date reads as tappable, not just a label. -->
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
					stroke-linejoin="round"
					style="color: var(--color-text-subtle);"
					aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg
				>
			</h1>
		</a>
		<div class="flex items-center gap-2">
			<a
				href="/settings"
				class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
				aria-label="Settings"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<circle cx="12" cy="12" r="3" />
					<path
						d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
					/>
				</svg>
			</a>
		</div>
	</header>

	<section class="card mt-4 p-5">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="font-semibold text-white">Today</h2>
			<!-- This badge is percent-of-calorie-target CONSUMED. On a day off nothing is
			     logged, so it would sit at a red-looking 0% all day — reading as a failed day
			     when the day was deliberately taken. Show the reason instead of the number. -->
			{#if data.mentalHealthDay}
				<span
					class="rounded-full px-2 py-0.5 text-xs font-semibold"
					style="background: rgba(148,163,184,0.15); color: var(--color-text-subtle);"
				>
					Day off
				</span>
			{:else}
				<span
					class="rounded-full px-2 py-0.5 text-xs font-semibold"
					style="background: rgba(251,146,60,0.15); color: #fdba74;"
				>
					{goalPct}%
				</span>
			{/if}
		</div>
		<div class="mb-4 flex items-center justify-between gap-1">
			<StatRing
				value={data.goalScore}
				target={100}
				label="Goal"
				centerText={data.goalScore == null ? undefined : String(Math.round(data.goalScore))}
				centerSub={data.goalScore == null ? undefined : grade(data.goalScore)}
				href="/goals"
				ariaLabel="Goal score — open goals"
				color={goalColor(data.goalScore)}
				size={84}
			/>
			<MacroRing
				value={totals.calories}
				target={data.calorieTarget}
				size={146}
				showRemaining={leadWithRemaining}
				ontoggle={toggleMode}
			/>
			{#if data.mentalHealthDay}
				<!-- Today is off. Both rings here measure food against a target, and today's
				     intake is an assumption we made, not something logged — drawing a goal
				     against it would be the app asking for something on the one day it
				     shouldn't. A plain label, no progress, nothing to chase. -->
				<div
					class="flex flex-col items-center justify-center text-center"
					style="width: 84px; height: 84px;"
				>
					<span class="text-2xl" aria-hidden="true">🌤️</span>
					<span class="mt-1 text-xs font-semibold" style="color: var(--color-text-subtle);">
						Day off
					</span>
				</div>
			{:else if data.mode === 'cut'}
				<StatRing
					value={data.deficit}
					target={data.deficitGoal}
					centerText={data.activeToGo != null ? data.activeToGo.toLocaleString() : undefined}
					centerSub="to go"
					label="Active"
					href="/energy"
					ariaLabel="Active calories left to hit today's deficit"
					color="#38bdf8"
					size={84}
				/>
			{:else}
				<StatRing
					value={data.deficit}
					target={data.deficitTarget}
					label="Deficit"
					unit="kcal"
					href="/deficit?today=1"
					ariaLabel="Today's deficit — open energy balance"
					color="#38bdf8"
					size={84}
				/>
			{/if}
		</div>
		<div class="grid grid-cols-3 gap-3">
			<MacroBar
				label="Protein"
				value={totals.proteinG}
				target={data.settings.proteinTargetG}
				color="var(--color-protein)"
				remaining={leadWithRemaining}
				ontoggle={toggleMode}
			/>
			<MacroBar label="Carbs" value={totals.carbsG} color="var(--color-carbs)" />
			<MacroBar label="Fat" value={totals.fatG} color="var(--color-fat)" />
		</div>
	</section>

	{#if data.quickAddItems.length > 0}
		<h3
			class="mt-6 mb-3 text-xs font-semibold tracking-wider uppercase"
			style="color: var(--color-text-subtle);"
		>
			Quick adds
		</h3>
		<div class="no-scrollbar flex gap-2 overflow-x-auto pb-1">
			{#each data.quickAddItems as q (q.id)}
				<div class="card-sm relative shrink-0 transition hover:bg-white/10">
					<button
						class="px-4 py-3 pr-9 text-left active:scale-95 disabled:opacity-50"
						disabled={pendingKey === `quick:${q.foodId}`}
						onclick={() => quickAdd(q.foodId)}
					>
						<div class="text-sm font-semibold text-white">{q.name}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{Math.round(q.calories)} · {Math.round(q.proteinG)}p
						</div>
					</button>
					<button
						class="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
						aria-label="Schedule {q.name} for later"
						onclick={() => {
							quickTime = defaultTime();
							schedulingQuick = { foodId: q.foodId, name: q.name };
						}}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
						>
					</button>
				</div>
			{/each}
		</div>
		{#if schedulingQuick}
			<div class="card-sm mt-2 flex items-center gap-2 p-3">
				<span class="flex-1 truncate text-sm text-white"
					>Schedule <b>{schedulingQuick.name}</b></span
				>
				<input
					type="time"
					bind:value={quickTime}
					class="rounded-md bg-white/10 px-2 py-1 text-sm text-white"
					aria-label="Scheduled time"
				/>
				<button
					class="rounded-md bg-white/10 px-3 py-1 text-sm font-semibold text-white hover:bg-white/20 disabled:opacity-50"
					disabled={pendingKey === 'schedule'}
					onclick={scheduleQuick}>Schedule</button
				>
				<button
					class="px-2 py-1 text-sm text-white/60 hover:text-white"
					onclick={() => (schedulingQuick = null)}
					aria-label="Cancel">✕</button
				>
			</div>
		{/if}
	{/if}

	{#if actionError}
		<p class="mt-2 text-sm text-red-400" role="alert">{actionError}</p>
	{/if}

	{#if data.plannedMeals.length > 0}
		<h3
			class="mt-6 mb-3 text-xs font-semibold tracking-wider uppercase"
			style="color: var(--color-text-subtle);"
		>
			Planned later
		</h3>
		<div class="card divide-y" style="border-color: var(--color-border);">
			{#each data.plannedMeals as p (p.id)}
				<div class="flex items-center gap-3 p-4">
					<div class="min-w-0 flex-1">
						<div class="truncate font-medium text-white">{p.foodName}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{formatTime(new Date(p.scheduledAt))} · {Math.round(p.calories)} kcal · {Math.round(
								p.proteinG
							)}p
						</div>
					</div>
					<button
						class="rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition hover:brightness-125 disabled:opacity-50"
						style="background: rgba(74,222,128,0.18); color: #4ade80;"
						disabled={pendingKey === `confirm:${p.id}`}
						onclick={() => confirmPlanned(p.id)}
					>
						Confirm
					</button>
					<button
						class="rounded-lg px-2.5 py-1.5 text-sm text-white/60 transition hover:text-white disabled:opacity-50"
						aria-label="Remove planned {p.foodName}"
						disabled={pendingKey === `remove:${p.id}`}
						onclick={() => removePlanned(p.id)}
					>
						✕
					</button>
				</div>
			{/each}
		</div>
		<p class="mt-2 text-center text-xs" style="color: var(--color-text-subtle);">
			Planned meals already count toward your day — confirm when you eat (stamps the time) or
			remove.
		</p>
	{/if}

	<h3
		class="mt-6 mb-3 text-xs font-semibold tracking-wider uppercase"
		style="color: var(--color-text-subtle);"
	>
		Eaten today
	</h3>
	{#if data.todayEntries.length === 0}
		<div class="card p-8 text-center" style="color: var(--color-text-subtle);">
			Nothing yet. Tap the + below to add something.
		</div>
	{:else}
		<div class="card divide-y" style="border-color: var(--color-border);">
			{#each data.todayEntries as e (e.id)}
				<button
					type="button"
					class="flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/5"
					style="border-color: var(--color-border);"
					onclick={() => (editingEntry = e)}
				>
					<div class="flex-1">
						<div class="font-medium text-white">{e.foodName}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{formatTime(new Date(e.loggedAt))} · {entryDisplay(
								e.amount,
								e.unit,
								e.servings,
								e.foodServingSize
							)}
						</div>
					</div>
					<div class="text-right text-sm">
						<div class="font-semibold text-white">{Math.round(e.calories)}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{Math.round(e.proteinG)}p · {Math.round(e.carbsG)}c
						</div>
						<div class="text-xs font-medium" style="color: var(--color-carbs);">
							{Math.round(e.bolusableCarbsG)}g bolus{#if e.bolusableLowConfidence}
								⚠︎{/if}
						</div>
					</div>
				</button>
			{/each}
		</div>
		<p class="mt-2 text-center text-xs" style="color: var(--color-text-subtle);">
			Tap any entry to edit or remove
		</p>
	{/if}
</main>

<EditEntrySheet
	entry={editingEntry}
	onclose={() => (editingEntry = null)}
	onsaved={() => location.reload()}
/>
