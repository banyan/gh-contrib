#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * GitHub Contribution CLI
 * Displays your GitHub contribution graph in the terminal
 */

import { parseArgs } from "@std/cli/parse-args";
import { Spinner } from "./spinner.ts";

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
}

function showHelp(): void {
  console.log(`
Usage: gh-contrib [options] [username]

Options:
  --year <YYYY>   Year to display (default: current year)
  --month <MM>    Month to display (default: current month)
  -h, --help      Show this help message

Examples:
  gh-contrib
  gh-contrib --year 2025
  gh-contrib --year 2025 --month 6
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
  return response.data.user.contributionsCollection.contributionCalendar;
}

export function formatContributionGraph(
  data: ContributionData,
  year: number,
  month?: number,
  today?: string,
): string[] {
  const cutoff = today ?? new Date().toISOString().slice(0, 10);
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
    ...[...monthTotals.entries()].sort().map(([ym, total]) => `${ym}: ${total}`),
    "",
  ];
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
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (args.help) {
    showHelp();
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
    const data = await getContributions(username, year);
    spinner.succeed(`Fetched contributions for @${username}`);
    for (const line of formatContributionGraph(data, year, month)) {
      console.log(line);
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
