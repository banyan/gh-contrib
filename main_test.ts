import { assertEquals } from "jsr:@std/assert";
import {
  type ContributionData,
  formatContributionGraph,
} from "./main.ts";

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
