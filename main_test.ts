import { assertEquals } from "@std/assert";
import {
  chunkQueryTo,
  type ContributionData,
  formatContributionGraph,
  padTrailingDays,
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

Deno.test("chunkQueryTo keeps the month-end `to` for a past chunk", () => {
  const now = Date.parse("2026-08-05T04:00:00Z");
  assertEquals(
    chunkQueryTo("2026-05-01", "2026-06-30", now),
    "2026-06-30T23:59:59Z",
  );
});

Deno.test("chunkQueryTo clamps the in-progress chunk to now", () => {
  const now = Date.parse("2026-08-05T04:56:07Z");
  assertEquals(
    chunkQueryTo("2026-07-01", "2026-08-31", now),
    "2026-08-05T04:56:07Z",
  );
});

Deno.test("chunkQueryTo covers the first day of a chunk starting after now", () => {
  const now = Date.parse("2026-06-30T20:00:00Z");
  assertEquals(
    chunkQueryTo("2026-07-01", "2026-08-31", now),
    "2026-07-02T00:00:00Z",
  );
});

Deno.test("padTrailingDays zero-fills days the clamped query did not cover", () => {
  const result = padTrailingDays(
    {
      total: 8,
      days: [
        { date: "2026-07-01", contributionCount: 8, contributionLevel: "NONE" },
      ],
    },
    "2026-07-01",
    "2026-07-04",
  );
  assertEquals(result.total, 8);
  assertEquals(
    result.days.map((d) => `${d.date}:${d.contributionCount}`),
    ["2026-07-01:8", "2026-07-02:0", "2026-07-03:0", "2026-07-04:0"],
  );
});

Deno.test("padTrailingDays leaves a fully covered chunk unchanged", () => {
  const days = [
    { date: "2026-07-03", contributionCount: 2, contributionLevel: "NONE" },
    { date: "2026-07-04", contributionCount: 1, contributionLevel: "NONE" },
  ];
  const result = padTrailingDays(
    { total: 3, days },
    "2026-07-03",
    "2026-07-04",
  );
  assertEquals(result.days, days);
});

Deno.test("padTrailingDays fills the whole range when nothing was returned", () => {
  const result = padTrailingDays(
    { total: 0, days: [] },
    "2026-07-01",
    "2026-07-03",
  );
  assertEquals(
    result.days.map((d) => d.date),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
});
