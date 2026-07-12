#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * GitHub Contribution CLI
 * Displays your GitHub contribution graph in the terminal
 */

import { parseArgs } from "@std/cli/parse-args";
import { Spinner } from "./spinner.ts";
import { DASHBOARD_TEMPLATE } from "./dashboard_template.ts";
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

export interface DashboardData {
  username: string;
  year: number;
  prevYear: number;
  generatedAt: string;
  asOfIndex: number;
  current: { counts: number[]; restricted?: number };
  previous: { counts: number[] };
}

function showHelp(): void {
  console.log(`
Usage: gh-contrib [options] [username]

Options:
  --year <YYYY>   Year to display (default: current year)
  --month <MM>    Month to display (default: current month)
  --dashboard     Open an HTML dashboard for the year in your browser
  -v, --version   Show version
  -h, --help      Show this help message

Examples:
  gh-contrib
  gh-contrib --year 2025
  gh-contrib --year 2025 --month 6
  gh-contrib --dashboard
  gh-contrib octocat
`);
}

async function getContributions(
  username: string,
  year: number,
): Promise<ContributionData> {
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;

  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
              }
            }
          }
        }
      }
    }
  `;

  const cmd = new Deno.Command("gh", {
    args: [
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
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr);
    throw new Error(`Failed to fetch contributions: ${errorText}`);
  }

  const response = JSON.parse(new TextDecoder().decode(stdout));
  const collection = response.data.user.contributionsCollection;
  return {
    ...collection.contributionCalendar,
    restrictedContributions: collection.restrictedContributionsCount,
  };
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

export function toDailyCounts(data: ContributionData): ContributionDay[] {
  return data.weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildDashboardData(
  current: ContributionData,
  previous: ContributionData,
  opts: { username: string; year: number; today?: string },
): DashboardData {
  const cutoff = opts.today ?? localToday();
  const days = toDailyCounts(current);
  let asOfIndex = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i].date <= cutoff) asOfIndex = i;
  }
  return {
    username: opts.username,
    year: opts.year,
    prevYear: opts.year - 1,
    generatedAt: cutoff,
    asOfIndex,
    current: {
      counts: days.map((d) => d.contributionCount),
      restricted: current.restrictedContributions,
    },
    previous: {
      counts: toDailyCounts(previous).map((d) => d.contributionCount),
    },
  };
}

export function renderDashboardHtml(
  template: string,
  data: DashboardData,
): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return template
    .replace("__DATA__", JSON.stringify(data).replaceAll("</", "<\\/"))
    .replaceAll("{{YEAR}}", String(data.year))
    .replaceAll("{{PREV}}", String(data.prevYear))
    .replaceAll("{{USER}}", esc(data.username))
    .replaceAll("{{GENERATED}}", esc(data.generatedAt));
}

async function openInBrowser(path: string): Promise<void> {
  const [cmd, ...cmdArgs] = Deno.build.os === "darwin"
    ? ["open", path]
    : Deno.build.os === "windows"
    ? ["cmd", "/c", "start", "", path]
    : ["xdg-open", path];
  await new Deno.Command(cmd, { args: cmdArgs }).output();
}

async function getCurrentUsername(): Promise<string> {
  const cmd = new Deno.Command("gh", {
    args: ["api", "user", "-q", ".login"],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout } = await cmd.output();

  if (code !== 0) {
    throw new Error(
      "Failed to get current user. Make sure you're logged in with `gh auth login`",
    );
  }

  return new TextDecoder().decode(stdout).trim();
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["year", "month"],
    boolean: ["help", "version", "dashboard"],
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

  const username = (args._ as string[])[0]?.toString() ||
    (await getCurrentUsername());

  console.log();
  const spinner = new Spinner(`Fetching contributions for @${username}...`);
  spinner.start();

  try {
    if (args.dashboard) {
      const [current, previous] = await Promise.all([
        getContributions(username, year),
        getContributions(username, year - 1),
      ]);
      spinner.succeed(`Fetched contributions for @${username}`);
      const data = buildDashboardData(current, previous, { username, year });
      const outPath = await Deno.makeTempFile({
        prefix: "gh-contrib-",
        suffix: ".html",
      });
      await Deno.writeTextFile(
        outPath,
        renderDashboardHtml(DASHBOARD_TEMPLATE, data),
      );
      await openInBrowser(outPath);
      console.log(`\n  📊 ${year} dashboard for @${username}: ${outPath}`);
    } else {
      const data = await getContributions(username, year);
      spinner.succeed(`Fetched contributions for @${username}`);
      for (const line of formatContributionGraph(data, year, month)) {
        console.log(line);
      }
    }
  } catch (error) {
    spinner.fail(`Failed to fetch contributions`);
    console.error(`\n  ❌ Error: ${(error as Error).message}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
