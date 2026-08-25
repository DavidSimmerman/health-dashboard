import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// E2E for the two granted-day toggles on /day/[date]:
//   • break day     — one per calendar week, marking a second MOVES it. Food still logged.
//   • mental health — nothing logged, excluded from scoring, soft one-a-month warning.
// They share the break_days table (PK = date, distinguished by `kind`), so they live in ONE
// spec file on purpose: separate files run in parallel workers and would race on the same
// rows. Tests inside a file run serially, and beforeEach re-clears, so order can't leak.
// Also loads /goals with a mental health day as the anchor — that page used to score the
// anchor unconditionally and threw on a day deliberately left unscored.

function envVar(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	try {
		const line = readFileSync('.env', 'utf8')
			.split('\n')
			.find((l) => l.startsWith(`${name}=`));
		return line
			?.slice(name.length + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
	} catch {
		return undefined;
	}
}

const password = envVar('MCP_AUTH_PASSWORD');
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const today = fmt.format(new Date());
const yesterday = fmt.format(new Date(Date.now() - 86_400_000));
// Sunday starts the week, so on a Sunday yesterday belongs to the PREVIOUS week and
// can't demonstrate the move. Every other day, yesterday shares today's week.
const sameWeek = new Date(`${today}T12:00:00Z`).getUTCDay() !== 0;
// The >1-per-month warning needs two marked days in the SAME calendar month; on the 1st,
// yesterday belongs to the previous month and can't demonstrate it.
const sameMonth = today.slice(0, 7) === yesterday.slice(0, 7);

async function withDb(fn: (sql: any) => Promise<void>) {
	const url = envVar('DATABASE_URL');
	if (!url) return;
	const { default: postgres } = await import('postgres');
	const sql = postgres(url, { max: 1 });
	try {
		await fn(sql);
	} finally {
		await sql.end();
	}
}

// Both toggles clear rows around the date they touch, so snapshot every real granted day in
// the affected span up front and put it back afterwards instead of just deleting. `kind`
// rides along: restoring a mental health day without it would downgrade it to a break day.
let saved: { date: string; kind: string }[] = [];
const weekStart = (() => {
	const d = new Date(`${today}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - d.getUTCDay());
	return d.toISOString().slice(0, 10);
})();
const weekEnd = (() => {
	const d = new Date(`${weekStart}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 6);
	return d.toISOString().slice(0, 10);
})();
// The week can straddle a month boundary, so span the union of both windows. Dates are
// fixed-width 'YYYY-MM-DD' text — plain string compare orders them correctly.
const monthStart = `${today.slice(0, 7)}-01`;
const monthEnd = `${today.slice(0, 7)}-31`;
const lo = weekStart < monthStart ? weekStart : monthStart;
const hi = weekEnd > monthEnd ? weekEnd : monthEnd;

test.beforeAll(async () => {
	await withDb(async (sql) => {
		const rows = await sql`SELECT date, kind FROM break_days WHERE date BETWEEN ${lo} AND ${hi}`;
		saved = rows.map((r: { date: string; kind: string }) => ({ date: r.date, kind: r.kind }));
	});
});

// Blank slate before EACH test: a real granted day already on today would leave a button in
// its marked state and the first click would find nothing to press.
test.beforeEach(async () => {
	await withDb(async (sql) => {
		await sql`DELETE FROM break_days WHERE date BETWEEN ${lo} AND ${hi}`;
	});
});

test.afterAll(async () => {
	await withDb(async (sql) => {
		await sql`DELETE FROM break_days WHERE date BETWEEN ${lo} AND ${hi}`;
		for (const row of saved) await sql`INSERT INTO break_days ${sql(row)}`;
	});
});

async function login(page: any) {
	if (!password) return;
	await page.goto('/login');
	await page.fill('input[type="password"]', password);
	await page.click('button[type="submit"]');
	await page.waitForURL('**/');
}

test('break day toggles, and one per week moves it', async ({ page }) => {
	await login(page);

	const mark = page.getByRole('button', { name: 'Make this a break day' });
	const marked = page.getByRole('button', { name: 'Break day · eating at maintenance' });

	// Mark today, then unmark it.
	await page.goto(`/day/${today}`);
	await mark.click();
	await expect(marked).toBeVisible();
	await marked.click();
	await expect(mark).toBeVisible();

	if (!sameWeek) return;

	// Mark yesterday, then today: the week only gets one, so yesterday's clears.
	await page.goto(`/day/${yesterday}`);
	await mark.click();
	await expect(marked).toBeVisible();

	await page.goto(`/day/${today}`);
	await mark.click();
	await expect(marked).toBeVisible();

	await page.goto(`/day/${yesterday}`);
	await expect(mark).toBeVisible();
});

test('mental health day toggles, warns past one a month, and converts a break day', async ({
	page
}) => {
	await login(page);

	const mark = page.getByRole('button', { name: 'Make this a mental health day' });
	const marked = page.getByRole('button', { name: 'Mental health day · not scored' });
	const markBreak = page.getByRole('button', { name: 'Make this a break day' });
	const markedBreak = page.getByRole('button', { name: 'Break day · eating at maintenance' });

	// Mark today, then unmark it. The first one in a month draws no warning.
	await page.goto(`/day/${today}`);
	await mark.click();
	await expect(marked).toBeVisible();
	await expect(page.getByText(/this month/)).toHaveCount(0);
	await marked.click();
	await expect(mark).toBeVisible();

	// A mental health day CONVERTS a maintenance break day on the same date — they share the
	// table's PK, so marking one must flip the other off rather than collide with it.
	await markBreak.click();
	await expect(markedBreak).toBeVisible();
	await mark.click();
	await expect(marked).toBeVisible();
	await expect(markBreak).toBeVisible(); // the break day gave way

	// /goals must survive an unscored anchor day rather than throwing on it.
	const res = await page.goto(`/goals?date=${today}`);
	expect(res?.status()).toBe(200);

	if (!sameMonth) return;

	// A second one in the same month still works — never blocked — but warns.
	await page.goto(`/day/${yesterday}`);
	await mark.click();
	await expect(marked).toBeVisible();
	await expect(page.getByText(/2 this month/)).toBeVisible();

	// Marking yesterday as the week's BREAK day converts it back off mental health, and
	// leaves today's mental health day alone — different budgets, same table.
	await markBreak.click();
	await expect(markedBreak).toBeVisible();
	await expect(mark).toBeVisible();

	await page.goto(`/day/${today}`);
	await expect(marked).toBeVisible();
});
