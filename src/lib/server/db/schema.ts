import {
	pgTable,
	text,
	integer,
	real,
	timestamp,
	uuid,
	jsonb,
	boolean,
	index,
	uniqueIndex,
	primaryKey
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Nutrients } from '$lib/nutrients';

// One component of a recipe. Macros are this ingredient's contribution to the
// WHOLE recipe (not per serving). `amount` is the free-text quantity as entered
// (e.g. "6 oz", "1 cup cooked") — kept for display and so a single ingredient
// can be tweaked later without re-entering the rest.
export type Ingredient = {
	name: string;
	amount?: string | null;
	barcode?: string | null;
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
	nutrients?: Partial<Nutrients> | null;
};

// Master food catalog. Populated as you scan/log new foods.
// Acts as your personal cache — a barcode looked up once is local forever.
export const foods = pgTable(
	'foods',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		brand: text('brand'),
		barcode: text('barcode').unique(),

		// Per-serving macros
		servingSize: text('serving_size'), // e.g. "1 container (170g)"
		servingGrams: real('serving_grams'),
		calories: real('calories').notNull(),
		proteinG: real('protein_g').notNull(),
		carbsG: real('carbs_g').notNull(),
		fatG: real('fat_g').notNull(),

		// Optional extended nutrients (per serving). Stored for later AI analysis; not displayed.
		nutrients: jsonb('nutrients').$type<Partial<Nutrients>>(),

		// Human-readable category string (e.g. "Cakes, Protein bars"), mainly from
		// Open Food Facts. Not displayed — used to widen fuzzy search coverage.
		categories: text('categories'),

		// Recipe / meal-prep support. A food may be composed of sub-ingredients so a
		// single one can be tweaked later and the per-serving macros recomputed.
		// `ingredients` holds whole-recipe contributions; the per-serving macros above
		// = sum(ingredients) / makesServings. `servingGrams` above = totalGrams /
		// makesServings, which lets a recipe be logged by grams.
		ingredients: jsonb('ingredients').$type<Ingredient[]>(),
		makesServings: real('makes_servings'), // servings the recipe yields (null = not a recipe)
		totalGrams: real('total_grams'), // cooked batch weight, for logging by grams

		// Provenance
		source: text('source').notNull(), // 'off' | 'manual' | 'label_ocr' | 'claude_code' | 'estimate'
		sourcePayload: jsonb('source_payload'), // raw API/OCR response for debugging

		// Source-tracking (so a hand-corrected food isn't silently stale).
		// `overridden` = the stored macros are a deliberate correction, so a scan
		// keeps showing them and only NOTIFIES when the external source changes.
		// Non-overridden rows just mirror the source on each scan. `sourceMacros`
		// is the last external (Open Food Facts) snapshot we reconciled with — the
		// baseline a fresh lookup is compared against; null until first established.
		overridden: boolean('overridden').notNull().default(false),
		sourceMacros: jsonb('source_macros').$type<{
			calories: number;
			proteinG: number;
			carbsG: number;
			fatG: number;
		}>(),
		sourceCheckedAt: timestamp('source_checked_at'),

		// Soft-delete: hidden from search/quick-adds but kept so historical day
		// entries (which reference foodId and render from cached macros) still resolve.
		archivedAt: timestamp('archived_at'),

		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [index('foods_barcode_idx').on(t.barcode), index('foods_name_idx').on(t.name)]
);

// Each thing you ate today (and historically).
export const dailyLog = pgTable(
	'daily_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		foodId: uuid('food_id')
			.notNull()
			.references(() => foods.id),
		servings: real('servings').notNull().default(1),
		// What the user actually entered (display + edit). `servings` above is the canonical multiplier.
		amount: real('amount'),
		unit: text('unit'), // 'serving' | 'gram' | 'cup' | 'tbsp' | 'tsp'
		loggedAt: timestamp('logged_at').notNull().defaultNow(),

		// A meal scheduled for later is just a log row with pending=true and loggedAt
		// set to the planned time — so it counts toward deficit / goals / macros like
		// any entry. The UI surfaces pending rows under "Planned later" with confirm
		// (clears pending, stamps the actual eaten time) or cancel (deletes the row).
		pending: boolean('pending').notNull().default(false),

		// Cached macros (so historical entries don't change if the food's macros are edited later)
		calories: real('calories').notNull(),
		proteinG: real('protein_g').notNull(),
		carbsG: real('carbs_g').notNull(),
		fatG: real('fat_g').notNull()
	},
	(t) => [index('daily_log_logged_at_idx').on(t.loggedAt)]
);

// Foods you want surfaced as quick-add tiles on the today view.
export const quickAdds = pgTable('quick_adds', {
	id: uuid('id').primaryKey().defaultRandom(),
	foodId: uuid('food_id')
		.notNull()
		.references(() => foods.id),
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// User-configurable daily targets. Single-row table for now (solo app).
export const settings = pgTable('settings', {
	id: integer('id').primaryKey().default(1),
	calorieTarget: integer('calorie_target').notNull().default(2100),
	proteinTargetG: integer('protein_target_g').notNull().default(180),
	// Daily calorie-deficit target — drives the deficit ring on the home page.
	// Null = no target set yet (ring shows the number but no fill).
	deficitTargetKcal: integer('deficit_target_kcal'),
	carbsTargetG: integer('carbs_target_g').notNull().default(220),
	fatTargetG: integer('fat_target_g').notNull().default(70),

	// Profile inputs for BMR estimation — Mifflin-St Jeor fallback for when a
	// weigh-in has no body-fat % (Katch-McArdle needs lean mass).
	heightCm: real('height_cm'),
	birthDate: text('birth_date'), // 'YYYY-MM-DD'
	sex: text('sex'), // 'male' | 'female'

	// Body-composition goals — drive the "time to goal" projection. Either, both,
	// or neither may be set.
	goalWeightKg: real('goal_weight_kg'),
	goalBodyFatPct: real('goal_body_fat_pct'), // 0–100

	// Dynamic calorie goal: the daily target is calibrated maintenance ± a
	// leanness-scaled delta instead of a fixed number. 'cut' = deficit, 'recomp' =
	// hold at maintenance, 'lean_bulk' = small surplus.
	goalMode: text('goal_mode').notNull().default('cut'), // 'cut' | 'recomp' | 'lean_bulk'

	// Live-target activity override for a single day: 0–4 (Rest…Very active). Applies
	// only when activityLevelDate === today; null / stale date = auto (your average).
	activityLevel: integer('activity_level'),
	activityLevelDate: text('activity_level_date'), // 'YYYY-MM-DD'

	// Bolusable (net glycemic) carb derivation. CLINICAL CALIBRATION — review with a
	// care team and validate against CGM traces; this is not medical fact. 'full' =
	// subtract all fiber (David's standing rule); 'half_over_5' = subtract half of
	// fiber, only when > 5g (ADA-style). Changing it recomputes the whole history,
	// because bolusable carbs are derived live, never stored.
	fiberMode: text('fiber_mode').notNull().default('full'), // 'full' | 'half_over_5'

	// Free-text notes surfaced to the scheduled Claude review (supplements, current
	// questions, context) so it sees them without a heavier feature. Included in the
	// export_data payload; editable on /settings.
	notes: text('notes'),

	// Editable instruction bodies for the scheduled report chats, one per cadence
	// (null = the built-in default in reportChats.ts). Only the analysis instructions
	// are editable — the base system prompt (tools, formatting, history rules) is code.
	dailyReportPrompt: text('daily_report_prompt'),
	weeklyReportPrompt: text('weekly_report_prompt'),
	monthlyReportPrompt: text('monthly_report_prompt')
});

// Analysis reports written back by the scheduled Claude review (via the save_report
// MCP tool) and read in-app at /reports. Content is markdown, rendered + sanitized
// server-side. `rangeFrom`/`rangeTo` record the date window the analysis covered;
// `period` is the optional label ('day'|'week'|'month'); `tag` is an optional theme.
export const reports = pgTable(
	'reports',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		title: text('title').notNull(),
		content: text('content').notNull(), // markdown
		period: text('period'), // 'day' | 'week' | 'month' | null
		rangeFrom: text('range_from'), // 'YYYY-MM-DD' covered (inclusive), nullable
		rangeTo: text('range_to'),
		tag: text('tag') // optional theme, e.g. 'sleep'
	},
	(t) => [index('reports_created_at_idx').on(t.createdAt)]
);

// A saved AI-assistant conversation. Messages are a JSONB array. Image DATA is intentionally
// NOT persisted (base64 would bloat the row) — user turns keep only text + how many photos
// were attached (shown as a chip on resume). Scheduled reports stay in the `reports` table and
// are merged into the Assistant list by the /reports loader.
export type ChatMessage =
	| { role: 'user'; text: string; imageCount?: number }
	| { role: 'assistant'; text: string }
	| {
			role: 'action';
			kind: 'track' | 'recipe' | 'schedule';
			name: string;
			summary?: string;
			macros: { calories: number; proteinG: number; carbsG: number; fatG: number };
			status: 'pending' | 'done' | 'cancelled';
			scheduled?: boolean;
	  };

export const chats = pgTable(
	'chats',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		title: text('title').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
		messages: jsonb('messages').$type<ChatMessage[]>().notNull().default([]),
		// Scheduled reports are chat rows too ('daily'|'weekly'|'monthly') so the user
		// can reply to them like any conversation. dateLabel is the APP_TZ day the
		// report was generated for; the partial unique index makes scheduled generation
		// idempotent (a second generator — e.g. the old container during a rolling
		// deploy — fails the insert and skips).
		kind: text('kind').notNull().default('chat'), // 'chat' | 'daily' | 'weekly' | 'monthly'
		unread: boolean('unread').notNull().default(false),
		dateLabel: text('date_label') // 'YYYY-MM-DD' for report kinds, null for plain chats
	},
	(t) => [
		index('chats_updated_at_idx').on(t.updatedAt),
		uniqueIndex('chats_report_per_day_uq')
			.on(t.kind, t.dateLabel)
			.where(sql`${t.kind} <> 'chat'`)
	]
);

// Last sync outcome per integration ('fitbit' | 'dexcom' | 'tandem' | 'healthkit').
// Written by every sync/backfill/import call; read by the /settings health card.
// The *Auth.updatedAt columns can't serve this: they track token writes, which are
// rare (and rarer still now that access tokens are cached in-process).
export const syncStatus = pgTable('sync_status', {
	source: text('source').primaryKey(),
	at: timestamp('at').notNull().defaultNow(),
	ok: boolean('ok').notNull(),
	detail: text('detail') // '3 days · 812 readings' or the error message
});

// ── HealthKit sync (pushed by the iOS wrapper app) ──────────────────────────

// One row per weigh-in. Sourced from HealthKit (smart scale → Fit Days → Apple
// Health → iOS app). `hkUuid` is the HealthKit sample UUID — the upsert key, so
// re-syncs are idempotent. Body fat / lean mass are nullable: a manual weight
// entry in Apple Health has no composition data.
export const bodyComp = pgTable(
	'body_comp',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		hkUuid: text('hk_uuid').notNull().unique(),
		measuredAt: timestamp('measured_at').notNull(),
		weightKg: real('weight_kg').notNull(),
		bodyFatPct: real('body_fat_pct'), // 0–100, not 0–1
		leanMassKg: real('lean_mass_kg'),
		source: text('source'), // HK source bundle id (e.g. the Fit Days app)
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('body_comp_measured_at_idx').on(t.measuredAt)]
);

// One row per local calendar day of activity, aggregated on-device by the iOS
// app (HKStatisticsCollectionQuery already dedupes overlapping Watch/iPhone
// samples). The current day gets re-pushed with growing totals — upsert by date.
export const activityDays = pgTable('activity_days', {
	date: text('date').primaryKey(), // 'YYYY-MM-DD' in the device's local time
	activeKcal: real('active_kcal'),
	basalKcal: real('basal_kcal'), // Apple's basal estimate — kept to compare against our BMR
	steps: integer('steps'),
	exerciseMin: integer('exercise_min'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// One row per HKWorkout session, pushed by the iOS app (anchored query — only
// new/edited workouts arrive). `hkUuid` is the upsert key, so a re-sync or an
// edit in Apple Health (same UUID) is idempotent. avg/max HR are from the
// workout's heart-rate samples; null when none were recorded.
export const workouts = pgTable(
	'workouts',
	{
		hkUuid: text('hk_uuid').primaryKey(),
		name: text('name').notNull(), // activity type, e.g. 'Strength Training'
		startedAt: timestamp('started_at').notNull(),
		endedAt: timestamp('ended_at'),
		kcal: real('kcal'), // total energy burned, if recorded
		avgHr: real('avg_hr'),
		maxHr: real('max_hr'),
		distanceKm: real('distance_km'), // walking/running distance, if recorded (drives the running-miles goal)
		// Sum of Apple's OWN activeEnergyBurned samples inside this workout's window — i.e. how much
		// of the day's active total this hour ALREADY occupies. This is NOT the workout's energy;
		// it's the amount to take OUT of the daily figure before haircutting the rest as passive,
		// so a workout's own (trusted) number replaces Apple's for that window instead of being
		// subtracted from it. Null on rows synced before the app sent it → old behaviour.
		// 0 is meaningful and distinct from null: the Watch was off, so Apple counted nothing.
		appleActiveKcal: real('apple_active_kcal'),
		source: text('source'), // HK source bundle id — dedicated trackers (walking pad) are trusted; Apple's own estimates get the haircut
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('workouts_started_at_idx').on(t.startedAt)]
);

// Daily vitals from HealthKit — water, resting/avg/min/max HR, HRV, SpO2,
// respiratory rate, VO2max, BMI. One value per (date, metric), recomputed and
// re-pushed for a trailing window each sync (same upsert-by-day idea as
// activity_days). The metric name is free-form so the iOS app can ship a new
// metric without a server release.
export const dailyMetrics = pgTable(
	'daily_metrics',
	{
		date: text('date').notNull(), // 'YYYY-MM-DD' in device-local time
		metric: text('metric').notNull(), // e.g. 'water_l', 'resting_hr', 'hrv_ms'
		value: real('value').notNull(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.date, t.metric] })]
);

// One row per night's sleep-stage timeline (Fitbit or Apple Watch, both via
// Google Health), kept so the /sleep hypnogram can draw the night. The aggregate
// minutes live in daily_metrics; this is the per-segment detail. Keyed by local
// wake date; the main (longest) session of the night wins, tie → Fitbit.
// `segments` offsets are minutes from `startAt`.
export const sleepStages = pgTable('sleep_stages', {
	date: text('date').primaryKey(), // 'YYYY-MM-DD' in APP_TZ (wake date)
	startAt: timestamp('start_at').notNull(),
	endAt: timestamp('end_at').notNull(),
	segments: jsonb('segments')
		.$type<{ stage: string; startMin: number; durationMin: number }[]>()
		.notNull(),
	// Which watch recorded this night: 'fitbit' | 'apple'. One night = one device
	// (longest session wins, tie → Fitbit), so it's never a blend. Every existing
	// row predates Apple sleep, which the default states correctly — no backfill.
	source: text('source').notNull().default('fitbit'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── Fitbit (Google) OAuth — server-side nightly sync ────────────────────────
// Single-row store for the Fitbit refresh token. Fitbit ROTATES the refresh token
// on every refresh, so it must be persisted writably (env won't do). Never
// returned to any client — the owner authorizes once via
// /api/integrations/fitbit/authorize, and the daily sync refreshes from here.
export const fitbitAuth = pgTable('fitbit_auth', {
	id: integer('id').primaryKey().default(1),
	refreshToken: text('refresh_token').notNull(),
	scope: text('scope'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── OAuth 2.1 (for the MCP connector Claude.ai adds) ────────────────────────
// We are our own authorization server. Claude.ai registers dynamically, runs
// auth-code + PKCE against /authorize + /token, and presents the resulting
// access token as a Bearer to /mcp.

// Dynamically-registered OAuth clients (RFC 7591). Claude.ai self-registers.
export const oauthClients = pgTable('oauth_clients', {
	clientId: text('client_id').primaryKey(),
	clientName: text('client_name'),
	redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// Short-lived single-use authorization codes. Bound to a PKCE challenge.
// Stored hashed; `code` column holds sha256(code).
export const oauthCodes = pgTable(
	'oauth_codes',
	{
		code: text('code').primaryKey(), // sha256 of the issued code
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.clientId, { onDelete: 'cascade' }),
		redirectUri: text('redirect_uri').notNull(),
		codeChallenge: text('code_challenge').notNull(),
		codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
		scope: text('scope'),
		resource: text('resource'),
		expiresAt: timestamp('expires_at').notNull(),
		consumed: boolean('consumed').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('oauth_codes_expires_idx').on(t.expiresAt)]
);

// Issued access + refresh tokens. Both stored hashed; lookups hash the
// presented token. Access tokens are short-lived; refresh tokens rotate.
export const oauthTokens = pgTable(
	'oauth_tokens',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		accessTokenHash: text('access_token_hash').notNull().unique(),
		refreshTokenHash: text('refresh_token_hash').unique(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.clientId, { onDelete: 'cascade' }),
		scope: text('scope'),
		resource: text('resource'),
		accessExpiresAt: timestamp('access_expires_at').notNull(),
		revoked: boolean('revoked').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		index('oauth_tokens_access_idx').on(t.accessTokenHash),
		index('oauth_tokens_refresh_idx').on(t.refreshTokenHash)
	]
);

// ── Dexcom (CGM) OAuth — server-side sync ───────────────────────────────────
// Single-row store for the Dexcom refresh token. Dexcom ROTATES the refresh token
// on every use (valid ≤1yr), so it must be persisted writably (env won't do).
// Never returned to any client — the owner authorizes once via
// /api/integrations/dexcom/authorize, and the cron sync refreshes from here.
export const dexcomAuth = pgTable('dexcom_auth', {
	id: integer('id').primaryKey().default(1),
	refreshToken: text('refresh_token').notNull(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// Intraday CGM trace — one row per Dexcom EGV (~every 5 min) for the glucose curve
// and time-in-range. `at` is the reading's UTC systemTime (a stable id; EGVs are
// unique per timestamp). `date` is the device-local day (from displayTime) it
// belongs to, for fast per-day queries. Daily summaries (avg/TIR/GMI) are rolled
// up separately into daily_metrics so the existing vitals/MCP surface picks them
// up. Idempotent: re-syncing a window upserts on `at`.
export const glucoseReadings = pgTable(
	'glucose_readings',
	{
		at: timestamp('at', { withTimezone: true }).primaryKey(), // EGV systemTime (UTC)
		date: text('date').notNull(), // 'YYYY-MM-DD' device-local (displayTime)
		mgdl: real('mgdl').notNull(),
		trend: text('trend') // e.g. 'flat', 'fortyFiveUp' — nullable (Dexcom omits on gaps)
	},
	(t) => [index('glucose_readings_date_idx').on(t.date)]
);

// ── Tandem (insulin pump) — unofficial Tandem Source API via Python sidecar ──
// Tandem has NO official API; the only live route is the reverse-engineered
// Tandem Source event log, decoded by tconnectsync (Python). We store login
// credentials because that API uses username/password, not OAuth — encrypted at
// rest (aes-256-gcm, keyed off TANDEM_ENC_KEY) since it's a reusable account
// password, not a revocable token. Single row, never returned to any client.
export const tandemAuth = pgTable('tandem_auth', {
	id: integer('id').primaryKey().default(1),
	username: text('username').notNull(),
	secret: text('secret').notNull(), // iv:tag:ciphertext (hex), aes-256-gcm
	region: text('region').notNull().default('US'), // 'US' | 'EU'
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// Intraday insulin trace from the pump, the insulin counterpart to
// glucose_readings — drawn on the same day time-axis. Two kinds share one table:
//   kind='basal' → one ~5-min sample; `units` is the commanded basal RATE (U/hr).
//   kind='bolus' → one delivered bolus; `units` is units DELIVERED, plus carbs
//                  entered, BG used, units requested, and bolusType (notably
//                  'Automatic Correction' = a Control-IQ auto-bolus).
// Idempotent re-sync upserts on (at, kind).
// ponytail: PK (at, kind) — two boluses in the same second would collide (one
// wins). Add seqNum to the PK if that ever shows up; pump events are ≥ seconds apart.
export const insulinEvents = pgTable(
	'insulin_events',
	{
		at: timestamp('at', { withTimezone: true }).notNull(), // event time (UTC)
		date: text('date').notNull(), // 'YYYY-MM-DD' device-local (APP_TZ)
		kind: text('kind').notNull(), // 'basal' | 'bolus'
		units: real('units').notNull(), // basal: U/hr rate; bolus: units delivered
		bolusType: text('bolus_type'), // bolus only: 'Insulin'|'Carb'|'Automatic Correction'|'Remote'
		carbs: real('carbs'), // bolus only: grams entered
		bg: real('bg'), // bolus only: mg/dL used for the bolus
		requested: real('requested') // bolus only: units requested (delivered may be less)
	},
	(t) => [primaryKey({ columns: [t.at, t.kind] }), index('insulin_events_date_idx').on(t.date)]
);

// Pump-reported CGM (mg/dL the pump received from its linked sensor). Kept in a
// SEPARATE table from glucose_readings (Dexcom's) on purpose: the two clocks
// differ by seconds, so sharing one table would create near-duplicate points
// once the Dexcom API is live. Mirrors glucose_readings minus trend. The day
// chart prefers Dexcom per-day and falls back to this, so they coexist cleanly.
// ponytail: only 'Precise Value' status readings are stored; Special High/Low/
// Do-Not-Show are dropped (the curve wants real numbers, not sentinels).
export const pumpGlucose = pgTable(
	'pump_glucose',
	{
		at: timestamp('at', { withTimezone: true }).primaryKey(), // reading time (UTC)
		date: text('date').notNull(), // 'YYYY-MM-DD' device-local (APP_TZ)
		mgdl: real('mgdl').notNull()
	},
	(t) => [index('pump_glucose_date_idx').on(t.date)]
);

// A "break day": one day a week you eat at MAINTENANCE instead of a deficit. That
// day's eat-to target loses the mode deficit (target = maintenance, no cushion) and
// its deficit goal scores like a vacation day's (eating at maintenance = full marks).
// ONLY the deficit relaxes — protein, steps, sleep etc. still count. At most one per
// calendar week (Sun–Sat): marking a second day MOVES it (see server/breakDays.ts).
// The table holds BOTH kinds of granted day (see `kind`); a date can only be one.
export const breakDays = pgTable('break_days', {
	date: text('date').primaryKey(), // local (APP_TZ) 'YYYY-MM-DD'
	//   'maintenance'   the weekly break day described above — food IS still logged.
	//   'mental_health' nothing is logged, by design. Intake is IMPUTED at maintenance +
	//                   MENTAL_HEALTH_SURPLUS_KCAL (see server/deficit.ts) so the scale
	//                   bump has food behind it, and the day is excluded from scoring
	//                   outright. Soft budget of one per calendar month: warned, never
	//                   blocked — a hard cap on a mental health day defeats the point.
	kind: text('kind').notNull().default('maintenance')
});

// A travel window where goal targets relax (see VACATION_SPECS in score.ts). Any
// local (APP_TZ) day within [from, to] inclusive is scored against the easier
// vacation targets. Ranges may overlap harmlessly — a day in ANY range is a
// vacation day. Dates are 'YYYY-MM-DD', so plain string comparison orders them.
export const vacations = pgTable('vacations', {
	id: uuid('id').primaryKey().defaultRandom(),
	from: text('from').notNull(), // inclusive start, 'YYYY-MM-DD'
	to: text('to').notNull(), // inclusive end, 'YYYY-MM-DD'
	createdAt: timestamp('created_at').notNull().defaultNow()
});
