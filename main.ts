#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * GitHub Contribution CLI
 * Displays your GitHub contribution graph in the terminal
 */

import { parseArgs } from "@std/cli/parse-args";
import { Spinner } from "./spinner.ts";
import denoConfig from "./deno.json" with { type: "json" };

export interface ContributionDay {
  date: string;
  contributionCount: number;
  contributionLevel: string;
}

export interface Week {
  contributionDays: ContributionDay[];
}

export interface ContributionData {
  totalContributions: number;
  weeks: Week[];
  restrictedContributions?: number;
}

function showHelp(): void {
  console.log(`
Usage: gh-contrib [options] [username]

Options:
  --year <YYYY>   Year to display (default: current year)
  --month <MM>    Month to display (default: current month)
  -v, --version   Show version
  -h, --help      Show this help message

Examples:
  gh-contrib
  gh-contrib --year 2025
  gh-contrib --year 2025 --month 6
  gh-contrib octocat
`);
}

async function runGh(
  args: string[],
): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  try {
    return await cmd.output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "gh command not found. Install GitHub CLI: https://cli.github.com",
      );
    }
    throw error;
  }
}

function withStatusHint(message: string): string {
  const looksLikeGitHubOutage =
    /HTTP 5\d\d|invalid character '<'|something went wrong/i
      .test(message);
  return looksLikeGitHubOutage
    ? `${message}\n\n  GitHub may be having issues: https://www.githubstatus.com/`
    : message;
}

async function fetchContributionsCollection(
  username: string,
  from: string,
  to: string,
  fields: string,
): Promise<Record<string, unknown>> {
  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          ${fields}
        }
      }
    }
  `;

  const { code, stdout, stderr } = await runGh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `username=${username}`,
    "-f",
    `from=${from}`,
    "-f",
    `to=${to}`,
  ]);

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr).trim();
    if (errorText.includes("Could not resolve to a User")) {
      throw new Error(`User "${username}" not found on GitHub`);
    }
    throw new Error(
      withStatusHint(`Failed to fetch contributions: ${errorText}`),
    );
  }

  const response = JSON.parse(new TextDecoder().decode(stdout));
  const collection = response.data?.user?.contributionsCollection;
  if (!collection) {
    throw new Error(`No contribution data returned for "${username}"`);
  }
  return collection;
}

const CALENDAR_FIELDS = `contributionCalendar {
  totalContributions
  weeks {
    contributionDays {
      date
      contributionCount
      contributionLevel
    }
  }
}`;

// The compute cost GitHub charges a contributionCalendar query is
// proportional to the number of contributions in the requested range, and
// past roughly 4k contributions the query deterministically fails with
// RESOURCE_LIMITS_EXCEEDED. Bisection here is only a safety net for when a
// single chunk somehow exceeds that; the normal path never triggers it.
async function fetchCalendarRange(
  username: string,
  from: string,
  to: string,
): Promise<{ total: number; days: ContributionDay[] }> {
  try {
    const collection = await fetchContributionsCollection(
      username,
      from,
      to,
      CALENDAR_FIELDS,
    );
    const calendar = collection.contributionCalendar as ContributionData;
    return {
      total: calendar.totalContributions,
      days: calendar.weeks.flatMap((w) => w.contributionDays),
    };
  } catch (error) {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (
      !/resource limits/i.test((error as Error).message) ||
      toMs - fromMs < thirtyDays
    ) {
      throw error;
    }
    const midDate = new Date((fromMs + toMs) / 2).toISOString().slice(0, 10);
    const nextDate = new Date(Date.parse(midDate) + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const first = await fetchCalendarRange(
      username,
      from,
      `${midDate}T23:59:59Z`,
    );
    const second = await fetchCalendarRange(
      username,
      `${nextDate}T00:00:00Z`,
      to,
    );
    return {
      total: first.total + second.total,
      days: [...first.days, ...second.days],
    };
  }
}

const CHUNK_MONTHS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function zeroDays(
  fromDate: string,
  toDate: string,
): { total: number; days: ContributionDay[] } {
  const days: ContributionDay[] = [];
  for (let t = Date.parse(fromDate); t <= Date.parse(toDate); t += DAY_MS) {
    days.push({
      date: new Date(t).toISOString().slice(0, 10),
      contributionCount: 0,
      contributionLevel: "NONE",
    });
  }
  return { total: 0, days };
}

// GitHub caches contributionCalendar snapshots keyed by (user, from, to)
// with the time-of-day stripped from BOTH endpoints, for hours. Clamping
// the in-progress chunk's `to` to now therefore cannot freshen it within a
// day — only the date part of the key matters — but it does give the chunk
// a new cache key once per day, which bounds its staleness to roughly a
// day. Same-day freshness for the most recent days comes from the overlay
// query instead (see overlayRange). The lower bound of one day past the
// chunk start keeps the range valid (and the first day fully covered) for
// a chunk that starts within the pre-fetch horizon but after `now`.
export function chunkQueryTo(
  fromDate: string,
  toDate: string,
  nowMs: number,
): string {
  const endMs = Date.parse(`${toDate}T23:59:59Z`);
  const clampedMs = Math.min(
    endMs,
    Math.max(nowMs, Date.parse(`${fromDate}T00:00:00Z`) + DAY_MS),
  );
  return clampedMs === endMs
    ? `${toDate}T23:59:59Z`
    : new Date(clampedMs).toISOString().slice(0, 19) + "Z";
}

// A clamped query only returns days up to the clamp; zero-fill the missing
// tail so chunks always span their full range, like unclamped ones.
export function padTrailingDays(
  result: { total: number; days: ContributionDay[] },
  fromDate: string,
  toDate: string,
): { total: number; days: ContributionDay[] } {
  const last = result.days[result.days.length - 1]?.date;
  const nextMs = last ? Date.parse(last) + DAY_MS : Date.parse(fromDate);
  if (nextMs > Date.parse(toDate)) return result;
  const fill = zeroDays(new Date(nextMs).toISOString().slice(0, 10), toDate);
  return { total: result.total, days: [...result.days, ...fill.days] };
}

// Because the calendar cache key is date-granular, every run after the
// day's first replays that first run's snapshot, freezing today's count.
// The only reliable way to force a fresh computation is a (from, to) date
// pair that has not been queried within the cache TTL. This picks `from` a
// few days back and `to` a pseudo-random number of days into the future
// (future days come back zero-filled and are dropped by the local today
// filter), giving ~900 distinct keys — and both endpoints shift with the
// date, so keys can only collide between runs on the same day, at ~1/900
// odds. Days on/after `cutoff` (UTC yesterday) are fully covered by the
// range for any profile timezone; the days before it may be cut mid-day by
// the range start and must not be trusted.
export function overlayRange(nowMs: number): {
  from: string;
  to: string;
  cutoff: string;
} {
  const day = (offset: number) =>
    new Date(nowMs + offset * DAY_MS).toISOString().slice(0, 10);
  const idx = nowMs % 900;
  return {
    from: `${day(-2 - (idx % 3))}T00:00:00Z`,
    to: `${day(1 + Math.floor(idx / 3))}T00:00:00Z`,
    cutoff: day(-1),
  };
}

// Overwrite the days on/after `cutoff` with the overlay's fresh counts and
// adjust the total by the difference (the API total is the sum of its
// days, so patching both keeps them consistent).
export function applyOverlay(
  data: ContributionData,
  overlayDays: ContributionDay[],
  cutoff: string,
): ContributionData {
  const fresh = new Map(
    overlayDays.filter((d) => d.date >= cutoff).map((d) => [d.date, d]),
  );
  let total = data.totalContributions;
  const weeks = data.weeks.map((week) => ({
    contributionDays: week.contributionDays.map((day) => {
      const patch = fresh.get(day.date);
      if (!patch) return day;
      total += patch.contributionCount - day.contributionCount;
      return { ...patch };
    }),
  }));
  return { totalContributions: total, weeks };
}

// Fetch the year as fixed 2-month chunks, all in parallel: individual
// chunks stay far below the resource limit at any realistic contribution
// volume (and cheap queries are safe to run concurrently — only
// over-the-limit ones ever failed in parallel). Chunks entirely in the
// future are zero-filled locally instead of queried.
async function getContributions(
  username: string,
  year: number,
): Promise<ContributionData> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowMs = Date.now();
  const horizon = new Date(nowMs + 2 * DAY_MS).toISOString().slice(0, 10);

  const chunks = [];
  for (let month = 1; month <= 12; month += CHUNK_MONTHS) {
    const endMonth = Math.min(month + CHUNK_MONTHS - 1, 12);
    const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    chunks.push({
      fromDate: `${year}-${pad(month)}-01`,
      toDate: `${year}-${pad(endMonth)}-${pad(endDay)}`,
    });
  }

  const overlay = overlayRange(nowMs);
  const overlayNeeded = `${year}-12-31` >= overlay.cutoff &&
    `${year}-01-01` <= horizon;
  const overlayPromise = overlayNeeded
    ? fetchCalendarRange(username, overlay.from, overlay.to)
    : null;

  const results = await Promise.all(
    chunks.map(async (c) => {
      if (c.fromDate > horizon) return zeroDays(c.fromDate, c.toDate);
      const result = await fetchCalendarRange(
        username,
        `${c.fromDate}T00:00:00Z`,
        chunkQueryTo(c.fromDate, c.toDate, nowMs),
      );
      return padTrailingDays(result, c.fromDate, c.toDate);
    }),
  );

  const data = {
    totalContributions: results.reduce((s, r) => s + r.total, 0),
    weeks: [{ contributionDays: results.flatMap((r) => r.days) }],
  };
  if (!overlayPromise) return data;
  return applyOverlay(data, (await overlayPromise).days, overlay.cutoff);
}

export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${
    String(now.getDate()).padStart(2, "0")
  }`;
}

export function formatContributionGraph(
  data: ContributionData,
  year: number,
  month?: number,
  today?: string,
): string[] {
  const cutoff = today ?? localToday();
  const allDays: ContributionDay[] = data.weeks
    .flatMap((w) => w.contributionDays)
    .filter((d) => d.date <= cutoff);

  const header = [
    "",
    `📊 ${data.totalContributions} contributions in ${year}`,
    "",
  ];

  if (month !== undefined) {
    const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
    const monthDays = allDays.filter((d) => d.date.startsWith(yearMonth));
    const monthTotal = monthDays.reduce((s, d) => s + d.contributionCount, 0);

    return [
      ...header,
      ...monthDays.map((d) => `${d.date}: ${d.contributionCount}`),
      "",
      `Total: ${monthTotal} contributions in ${yearMonth}`,
      "",
    ];
  }

  const monthTotals = new Map<string, number>();
  for (const day of allDays) {
    const ym = day.date.slice(0, 7);
    monthTotals.set(ym, (monthTotals.get(ym) || 0) + day.contributionCount);
  }

  return [
    ...header,
    ...[...monthTotals.entries()].sort().map(([ym, total]) =>
      `${ym}: ${total}`
    ),
    "",
  ];
}

async function getCurrentUsername(): Promise<string> {
  const { code, stdout, stderr } = await runGh([
    "api",
    "graphql",
    "-f",
    "query=query { viewer { login } }",
    "-q",
    ".data.viewer.login",
  ]);

  if (code !== 0) {
    const detail = new TextDecoder().decode(stderr).trim();
    const isAuthError = /auth login|HTTP 401|Bad credentials|authentication/i
      .test(detail);
    throw new Error(
      withStatusHint(
        [
          isAuthError
            ? "Not logged in to GitHub. Run `gh auth login` first"
            : "Failed to get current user",
          detail,
        ].filter(Boolean).join("\n\n  "),
      ),
    );
  }

  const login = new TextDecoder().decode(stdout).trim();
  if (!login) {
    throw new Error("Failed to get current user (empty response from gh)");
  }
  return login;
}

function fail(message: string): never {
  console.error(`\n  ❌ ${message}`);
  Deno.exit(1);
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["year", "month"],
    boolean: ["help", "version"],
    alias: { h: "help", v: "version" },
  });

  if (args.help) {
    showHelp();
    Deno.exit(0);
  }

  if (args.version) {
    console.log(denoConfig.version);
    Deno.exit(0);
  }

  const now = new Date();
  const year = args.year ? parseInt(args.year, 10) : now.getFullYear();
  const month = args.month
    ? parseInt(args.month, 10)
    : args.year
    ? undefined
    : now.getMonth() + 1;

  if (Number.isNaN(year)) {
    fail(`Invalid --year: ${args.year}`);
  }

  if (month !== undefined && (Number.isNaN(month) || month < 1 || month > 12)) {
    fail(`Invalid --month: ${args.month} (expected 1-12)`);
  }

  let username = (args._ as string[])[0]?.toString();
  if (!username) {
    try {
      username = await getCurrentUsername();
    } catch (error) {
      fail((error as Error).message);
    }
  }

  console.log();
  const spinner = new Spinner(`Fetching contributions for @${username}...`);
  spinner.start();

  try {
    const data = await getContributions(username, year);
    spinner.succeed(`Fetched contributions for @${username}`);
    for (const line of formatContributionGraph(data, year, month)) {
      console.log(line);
    }
  } catch (error) {
    spinner.fail(`Failed to fetch contributions`);
    fail((error as Error).message);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
