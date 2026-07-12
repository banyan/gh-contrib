import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDashboardData,
  type ContributionData,
  formatContributionGraph,
  renderDashboardHtml,
  toDailyCounts,
} from "./main.ts";
import { DASHBOARD_TEMPLATE } from "./dashboard_template.ts";

function makeData(
  days: { date: string; count: number }[],
  total?: number,
): ContributionData {
  const computedTotal = total ??
    days.reduce((sum, d) => sum + d.count, 0);
  return {
    totalContributions: computedTotal,
    weeks: [
      {
        contributionDays: days.map((d) => ({
          date: d.date,
          contributionCount: d.count,
          contributionLevel: "NONE",
        })),
      },
    ],
  };
}

Deno.test("month view shows daily breakdown", () => {
  const data = makeData([
    { date: "2025-06-01", count: 3 },
    { date: "2025-06-02", count: 0 },
    { date: "2025-06-03", count: 5 },
  ]);

  const lines = formatContributionGraph(data, 2025, 6, "2025-12-31");

  assertEquals(lines.includes("2025-06-01: 3"), true);
  assertEquals(lines.includes("2025-06-02: 0"), true);
  assertEquals(lines.includes("2025-06-03: 5"), true);
  assertEquals(lines.includes("Total: 8 contributions in 2025-06"), true);
});

Deno.test("year view shows monthly totals", () => {
  const data = makeData([
    { date: "2025-01-15", count: 10 },
    { date: "2025-01-20", count: 5 },
    { date: "2025-03-01", count: 7 },
  ]);

  const lines = formatContributionGraph(data, 2025, undefined, "2025-12-31");

  assertEquals(lines.includes("2025-01: 15"), true);
  assertEquals(lines.includes("2025-03: 7"), true);
  // Should not include February (no data)
  assertEquals(lines.includes("2025-02"), false);
});

Deno.test("filters out days after today", () => {
  const data = makeData([
    { date: "2025-06-01", count: 3 },
    { date: "2025-06-02", count: 5 },
    { date: "2025-06-03", count: 2 },
  ]);

  const lines = formatContributionGraph(data, 2025, 6, "2025-06-02");

  assertEquals(lines.includes("2025-06-01: 3"), true);
  assertEquals(lines.includes("2025-06-02: 5"), true);
  assertEquals(lines.includes("2025-06-03"), false);
  assertEquals(lines.includes("Total: 8 contributions in 2025-06"), true);
});

Deno.test("year view filters future months", () => {
  const data = makeData(
    [
      { date: "2025-01-10", count: 10 },
      { date: "2025-06-15", count: 5 },
      { date: "2025-12-01", count: 99 },
    ],
    114,
  );

  const lines = formatContributionGraph(data, 2025, undefined, "2025-06-30");

  assertEquals(lines.includes("2025-01: 10"), true);
  assertEquals(lines.includes("2025-06: 5"), true);
  assertEquals(lines.includes("2025-12"), false);
});

Deno.test("header shows total contributions from API", () => {
  const data = makeData(
    [{ date: "2025-01-01", count: 1 }],
    999,
  );

  const lines = formatContributionGraph(data, 2025, 1, "2025-12-31");

  assertEquals(
    lines.includes("📊 999 contributions in 2025"),
    true,
  );
});

Deno.test("toDailyCounts sorts days across weeks by date", () => {
  const data: ContributionData = {
    totalContributions: 3,
    weeks: [
      {
        contributionDays: [
          {
            date: "2025-01-08",
            contributionCount: 2,
            contributionLevel: "NONE",
          },
        ],
      },
      {
        contributionDays: [
          {
            date: "2025-01-01",
            contributionCount: 1,
            contributionLevel: "NONE",
          },
        ],
      },
    ],
  };

  assertEquals(toDailyCounts(data).map((d) => d.date), [
    "2025-01-01",
    "2025-01-08",
  ]);
});

Deno.test("buildDashboardData computes asOfIndex from the cutoff date", () => {
  const current = makeData([
    { date: "2025-06-01", count: 3 },
    { date: "2025-06-02", count: 5 },
    { date: "2025-06-03", count: 2 },
  ]);
  current.restrictedContributions = 7;
  const previous = makeData([{ date: "2024-06-01", count: 1 }]);

  const d = buildDashboardData(current, previous, {
    username: "octocat",
    year: 2025,
    today: "2025-06-02",
  });

  assertEquals(d.asOfIndex, 1);
  assertEquals(d.year, 2025);
  assertEquals(d.prevYear, 2024);
  assertEquals(d.current.counts, [3, 5, 2]);
  assertEquals(d.current.restricted, 7);
  assertEquals(d.previous.counts, [1]);
});

Deno.test("buildDashboardData covers the whole year for a past cutoff", () => {
  const current = makeData([
    { date: "2024-01-01", count: 1 },
    { date: "2024-12-31", count: 2 },
  ]);
  const previous = makeData([]);

  const d = buildDashboardData(current, previous, {
    username: "octocat",
    year: 2024,
    today: "2025-06-02",
  });

  assertEquals(d.asOfIndex, 1);
});

Deno.test("renderDashboardHtml injects data and resolves all tokens", () => {
  const current = makeData([{ date: "2025-01-01", count: 4 }]);
  const previous = makeData([{ date: "2024-01-01", count: 9 }]);
  const d = buildDashboardData(current, previous, {
    username: "octocat",
    year: 2025,
    today: "2025-01-01",
  });

  const html = renderDashboardHtml(DASHBOARD_TEMPLATE, d);

  assertStringIncludes(html, '"asOfIndex":0');
  assertStringIncludes(html, '"username":"octocat"');
  assertStringIncludes(html, "gh contrib — octocat 2025");
  assertEquals(html.includes("__DATA__"), false);
  assertEquals(html.includes("{{"), false);
});

Deno.test("dashboard_template.ts is in sync with dashboard.html", async () => {
  const html = await Deno.readTextFile(
    new URL("./dashboard.html", import.meta.url),
  );
  assertEquals(DASHBOARD_TEMPLATE, html);
});
