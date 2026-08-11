import { assert, assertEquals } from "@std/assert";
import {
  applyOverlay,
  chunkQueryTo,
  type ContributionData,
  formatContributionGraph,
  overlayRange,
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

Deno.test("overlayRange spans cutoff for any timezone and stays under a year", () => {
  for (const iso of ["2026-08-11T02:57:00Z", "2026-12-31T23:59:59Z"]) {
    const nowMs = Date.parse(iso);
    const { from, to, cutoff } = overlayRange(nowMs);
    // `from` at least 2 days back covers the cutoff day fully even at UTC-12
    assert(Date.parse(from) <= nowMs - 2 * 24 * 60 * 60 * 1000);
    assertEquals(from.slice(10), "T00:00:00Z");
    assert(Date.parse(to) > nowMs);
    assert(Date.parse(to) - Date.parse(from) < 365 * 24 * 60 * 60 * 1000);
    assertEquals(
      cutoff,
      new Date(nowMs - 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10),
    );
  }
});

Deno.test("overlayRange varies the date pair across close run times", () => {
  const base = Date.parse("2026-08-11T02:57:00Z");
  const keys = new Set(
    [0, 1, 2, 3, 4].map((s) => {
      const r = overlayRange(base + s * 1000);
      return `${r.from}|${r.to}`;
    }),
  );
  assert(keys.size > 1);
});

Deno.test("applyOverlay patches days on/after cutoff and adjusts the total", () => {
  const data = makeData([
    { date: "2026-08-09", count: 30 },
    { date: "2026-08-10", count: 99 },
    { date: "2026-08-11", count: 37 },
  ]);
  const overlayDays = [
    // before cutoff: possibly cut mid-day by the range start — ignored
    { date: "2026-08-09", contributionCount: 1, contributionLevel: "NONE" },
    {
      date: "2026-08-10",
      contributionCount: 99,
      contributionLevel: "FOURTH_QUARTILE",
    },
    {
      date: "2026-08-11",
      contributionCount: 51,
      contributionLevel: "SECOND_QUARTILE",
    },
    // future zero-fill days not present in the fetched year are ignored
    { date: "2026-08-12", contributionCount: 0, contributionLevel: "NONE" },
  ];

  const result = applyOverlay(data, overlayDays, "2026-08-10");
  const days = result.weeks[0].contributionDays;

  assertEquals(days.map((d) => d.contributionCount), [30, 99, 51]);
  assertEquals(days[2].contributionLevel, "SECOND_QUARTILE");
  assertEquals(result.totalContributions, 30 + 99 + 51);
});
