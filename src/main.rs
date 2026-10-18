//! GitHub Contribution CLI
//! Displays your GitHub contribution graph in the terminal

mod spinner;

use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::process::Command;

use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::Value;

use spinner::Spinner;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionDay {
    date: String,
    contribution_count: i64,
    contribution_level: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Week {
    contribution_days: Vec<ContributionDay>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionData {
    total_contributions: i64,
    weeks: Vec<Week>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RangeResult {
    total: i64,
    days: Vec<ContributionDay>,
}

const HELP: &str = "
Usage: gh-contrib [options] [username]

Options:
  --year <YYYY>   Year to display (default: current year)
  --month <MM>    Month to display (default: current month)
  --years         Show yearly totals since the first contribution
  -v, --version   Show version
  -h, --help      Show this help message

Examples:
  gh-contrib
  gh-contrib --year 2025
  gh-contrib --year 2025 --month 6
  gh-contrib --years
  gh-contrib octocat
";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const CHUNK_MONTHS: u32 = 2;

/// Parses a `YYYY-MM-DD` (as UTC midnight) or RFC 3339 timestamp into epoch
/// milliseconds. Every input is produced by this program, so a parse failure
/// is a bug.
fn parse_ms(s: &str) -> i64 {
    if s.len() == 10 {
        NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .unwrap_or_else(|e| panic!("invalid date {s:?}: {e}"))
            .and_hms_opt(0, 0, 0)
            .expect("midnight is a valid time")
            .and_utc()
            .timestamp_millis()
    } else {
        DateTime::parse_from_rfc3339(s)
            .unwrap_or_else(|e| panic!("invalid timestamp {s:?}: {e}"))
            .timestamp_millis()
    }
}

fn utc(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_else(|| panic!("timestamp out of range: {ms}"))
}

fn iso_date(ms: i64) -> String {
    utc(ms).format("%Y-%m-%d").to_string()
}

fn iso_seconds(ms: i64) -> String {
    utc(ms).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

struct GhOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_gh(args: &[&str]) -> Result<GhOutput, String> {
    match Command::new("gh").args(args).output() {
        Ok(out) => Ok(GhOutput {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err("gh command not found. Install GitHub CLI: https://cli.github.com".to_string())
        }
        Err(e) => Err(format!("Failed to run gh: {e}")),
    }
}

fn with_status_hint(message: String) -> String {
    let lower = message.to_lowercase();
    let looks_like_github_outage = lower.contains("invalid character '<'")
        || lower.contains("something went wrong")
        || lower.match_indices("http 5").any(|(i, _)| {
            lower[i + 6..]
                .chars()
                .take(2)
                .filter(char::is_ascii_digit)
                .count()
                == 2
        });
    if looks_like_github_outage {
        format!("{message}\n\n  GitHub may be having issues: https://www.githubstatus.com/")
    } else {
        message
    }
}

/// Queries `contributionsCollection` for `range` (`from`, `to`), or for
/// GitHub's default range (the last year) when it is `None`.
fn fetch_contributions_collection(
    username: &str,
    range: Option<(&str, &str)>,
    fields: &str,
) -> Result<Value, String> {
    let (params, collection_args) = match range {
        Some(_) => (
            ", $from: DateTime!, $to: DateTime!",
            "(from: $from, to: $to)",
        ),
        None => ("", ""),
    };
    let query = format!(
        "
    query($username: String!{params}) {{
      user(login: $username) {{
        contributionsCollection{collection_args} {{
          {fields}
        }}
      }}
    }}
  "
    );

    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
        "-F".to_string(),
        format!("username={username}"),
    ];
    if let Some((from, to)) = range {
        args.extend([
            "-f".to_string(),
            format!("from={from}"),
            "-f".to_string(),
            format!("to={to}"),
        ]);
    }
    let out = run_gh(&args.iter().map(String::as_str).collect::<Vec<_>>())?;

    if !out.success {
        let error_text = out.stderr.trim();
        if error_text.contains("Could not resolve to a User") {
            return Err(format!("User \"{username}\" not found on GitHub"));
        }
        return Err(with_status_hint(format!(
            "Failed to fetch contributions: {error_text}"
        )));
    }

    let mut response: Value = serde_json::from_str(&out.stdout)
        .map_err(|e| format!("Failed to parse gh output as JSON: {e}"))?;
    match response.pointer_mut("/data/user/contributionsCollection") {
        Some(collection) if !collection.is_null() => Ok(collection.take()),
        _ => Err(format!("No contribution data returned for \"{username}\"")),
    }
}

const CALENDAR_FIELDS: &str = "contributionCalendar {
  totalContributions
  weeks {
    contributionDays {
      date
      contributionCount
      contributionLevel
    }
  }
}";

// The compute cost GitHub charges a contributionCalendar query is
// proportional to the number of contributions in the requested range, and
// past roughly 4k contributions the query deterministically fails with
// RESOURCE_LIMITS_EXCEEDED. Bisection here is only a safety net for when a
// single chunk somehow exceeds that; the normal path never triggers it.
fn fetch_calendar_range(username: &str, from: &str, to: &str) -> Result<RangeResult, String> {
    let result = fetch_contributions_collection(username, Some((from, to)), CALENDAR_FIELDS)
        .and_then(|mut collection| {
            serde_json::from_value::<ContributionData>(collection["contributionCalendar"].take())
                .map_err(|e| format!("Unexpected contributionCalendar shape: {e}"))
        });
    let error = match result {
        Ok(calendar) => {
            return Ok(RangeResult {
                total: calendar.total_contributions,
                days: calendar
                    .weeks
                    .into_iter()
                    .flat_map(|w| w.contribution_days)
                    .collect(),
            });
        }
        Err(error) => error,
    };

    let from_ms = parse_ms(from);
    let to_ms = parse_ms(to);
    if !error.to_lowercase().contains("resource limits") || to_ms - from_ms < 30 * DAY_MS {
        return Err(error);
    }
    let mid_ms = parse_ms(&iso_date((from_ms + to_ms) / 2));
    let first = fetch_calendar_range(username, from, &format!("{}T23:59:59Z", iso_date(mid_ms)))?;
    let second = fetch_calendar_range(
        username,
        &format!("{}T00:00:00Z", iso_date(mid_ms + DAY_MS)),
        to,
    )?;
    Ok(RangeResult {
        total: first.total + second.total,
        days: [first.days, second.days].concat(),
    })
}

fn zero_days(from_date: &str, to_date: &str) -> RangeResult {
    let end = parse_ms(to_date);
    let days = (parse_ms(from_date)..=end)
        .step_by(DAY_MS as usize)
        .map(|t| ContributionDay {
            date: iso_date(t),
            contribution_count: 0,
            contribution_level: "NONE".to_string(),
        })
        .collect();
    RangeResult { total: 0, days }
}

// GitHub caches contributionCalendar snapshots keyed by (user, from, to)
// with the time-of-day stripped from BOTH endpoints, for hours. Clamping
// the in-progress chunk's `to` to now therefore cannot freshen it within a
// day — only the date part of the key matters — but it does give the chunk
// a new cache key once per day, which bounds its staleness to roughly a
// day. Same-day freshness for the most recent days comes from the overlay
// query instead (see overlay_range). The lower bound of one day past the
// chunk start keeps the range valid (and the first day fully covered) for
// a chunk that starts within the pre-fetch horizon but after `now`.
pub fn chunk_query_to(from_date: &str, to_date: &str, now_ms: i64) -> String {
    let end_ms = parse_ms(&format!("{to_date}T23:59:59Z"));
    let clamped_ms = end_ms.min(now_ms.max(parse_ms(from_date) + DAY_MS));
    if clamped_ms == end_ms {
        format!("{to_date}T23:59:59Z")
    } else {
        iso_seconds(clamped_ms)
    }
}

// A clamped query only returns days up to the clamp; zero-fill the missing
// tail so chunks always span their full range, like unclamped ones.
pub fn pad_trailing_days(result: RangeResult, from_date: &str, to_date: &str) -> RangeResult {
    let next_ms = match result.days.last() {
        Some(last) => parse_ms(&last.date) + DAY_MS,
        None => parse_ms(from_date),
    };
    if next_ms > parse_ms(to_date) {
        return result;
    }
    let fill = zero_days(&iso_date(next_ms), to_date);
    RangeResult {
        total: result.total,
        days: [result.days, fill.days].concat(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverlayRange {
    from: String,
    to: String,
    cutoff: String,
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
pub fn overlay_range(now_ms: i64) -> OverlayRange {
    let day = |offset: i64| iso_date(now_ms + offset * DAY_MS);
    let idx = now_ms.rem_euclid(900);
    OverlayRange {
        from: format!("{}T00:00:00Z", day(-2 - idx % 3)),
        to: format!("{}T00:00:00Z", day(1 + idx / 3)),
        cutoff: day(-1),
    }
}

// Overwrite the days on/after `cutoff` with the overlay's fresh counts and
// adjust the total by the difference (the API total is the sum of its
// days, so patching both keeps them consistent).
pub fn apply_overlay(
    data: ContributionData,
    overlay_days: Vec<ContributionDay>,
    cutoff: &str,
) -> ContributionData {
    let fresh: HashMap<String, ContributionDay> = overlay_days
        .into_iter()
        .filter(|d| d.date.as_str() >= cutoff)
        .map(|d| (d.date.clone(), d))
        .collect();
    let mut total = data.total_contributions;
    let weeks = data
        .weeks
        .into_iter()
        .map(|week| Week {
            contribution_days: week
                .contribution_days
                .into_iter()
                .map(|day| match fresh.get(&day.date) {
                    Some(patch) => {
                        total += patch.contribution_count - day.contribution_count;
                        patch.clone()
                    }
                    None => day,
                })
                .collect(),
        })
        .collect();
    ContributionData {
        total_contributions: total,
        weeks,
    }
}

// Fetch the year as fixed 2-month chunks, all in parallel: individual
// chunks stay far below the resource limit at any realistic contribution
// volume (and cheap queries are safe to run concurrently — only
// over-the-limit ones ever failed in parallel). Chunks entirely in the
// future are zero-filled locally instead of queried.
fn get_contributions(username: &str, year: i32) -> Result<ContributionData, String> {
    let now_ms = Utc::now().timestamp_millis();
    let horizon = iso_date(now_ms + 2 * DAY_MS);

    let chunks: Vec<(String, String)> = (1..=12)
        .step_by(CHUNK_MONTHS as usize)
        .map(|month| {
            let end_month = (month + CHUNK_MONTHS - 1).min(12);
            let end_day = last_day_of_month(year, end_month);
            (
                format!("{year}-{month:02}-01"),
                format!("{year}-{end_month:02}-{end_day:02}"),
            )
        })
        .collect();

    let overlay = overlay_range(now_ms);
    let overlay_needed =
        format!("{year}-12-31") >= overlay.cutoff && format!("{year}-01-01") <= horizon;

    std::thread::scope(|s| {
        let overlay_handle = overlay_needed
            .then(|| s.spawn(|| fetch_calendar_range(username, &overlay.from, &overlay.to)));

        let handles: Vec<_> = chunks
            .iter()
            .map(|(from_date, to_date)| {
                let horizon = &horizon;
                s.spawn(move || {
                    if from_date.as_str() > horizon.as_str() {
                        return Ok(zero_days(from_date, to_date));
                    }
                    let result = fetch_calendar_range(
                        username,
                        &format!("{from_date}T00:00:00Z"),
                        &chunk_query_to(from_date, to_date, now_ms),
                    )?;
                    Ok(pad_trailing_days(result, from_date, to_date))
                })
            })
            .collect();

        let results = handles
            .into_iter()
            .map(|h| h.join().expect("fetch thread panicked"))
            .collect::<Result<Vec<RangeResult>, String>>()?;

        let data = ContributionData {
            total_contributions: results.iter().map(|r| r.total).sum(),
            weeks: vec![Week {
                contribution_days: results.into_iter().flat_map(|r| r.days).collect(),
            }],
        };
        match overlay_handle {
            None => Ok(data),
            Some(h) => {
                let fresh = h.join().expect("overlay thread panicked")?;
                Ok(apply_overlay(data, fresh.days, &overlay.cutoff))
            }
        }
    })
}

fn fetch_contribution_years(username: &str) -> Result<Vec<i32>, String> {
    let mut collection = fetch_contributions_collection(username, None, "contributionYears")?;
    serde_json::from_value(collection["contributionYears"].take())
        .map_err(|e| format!("Unexpected contributionYears shape: {e}"))
}

// Years are fetched the same way as the single-year view (2-month chunks
// plus the overlay for the current year), so each line matches the header
// of `--year <YYYY>`: GitHub's totals shift by a few contributions
// depending on how the range is split, and a single full-year query would
// disagree with it. Concurrency is capped so a long history does not fork
// a hundred `gh` processes at once.
const YEAR_WORKERS: usize = 8;

fn get_yearly_totals(username: &str, current_year: i32) -> Result<Vec<(i32, i64)>, String> {
    let years = fetch_contribution_years(username)?;
    let Some(&first) = years.iter().min() else {
        return Ok(vec![]);
    };
    let years: Vec<i32> = (first..=current_year.max(first)).collect();

    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new(vec![None; years.len()]);
    std::thread::scope(|s| {
        for _ in 0..YEAR_WORKERS.min(years.len()) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let Some(&year) = years.get(i) else { break };
                    let total = get_contributions(username, year).map(|d| d.total_contributions);
                    results.lock().expect("results lock poisoned")[i] = Some(total);
                }
            });
        }
    });

    years
        .iter()
        .zip(results.into_inner().expect("results lock poisoned"))
        .map(|(&year, total)| Ok((year, total.expect("every year was fetched")?)))
        .collect()
}

pub fn format_yearly_totals(totals: &[(i32, i64)]) -> Vec<String> {
    let sum: i64 = totals.iter().map(|(_, total)| total).sum();
    let range = match (totals.first(), totals.last()) {
        (Some((first, _)), Some((last, _))) if first != last => format!("{first}-{last}"),
        (Some((year, _)), _) => year.to_string(),
        _ => "total".to_string(),
    };
    let mut lines = vec![
        String::new(),
        format!("📊 {sum} contributions in {range}"),
        String::new(),
    ];
    lines.extend(
        totals
            .iter()
            .map(|(year, total)| format!("{year}: {total}")),
    );
    lines.push(String::new());
    lines
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|d| d.pred_opt())
        .unwrap_or_else(|| panic!("invalid year/month: {year}-{month}"))
        .day()
}

pub fn local_today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn format_contribution_graph(
    data: &ContributionData,
    year: i32,
    month: Option<u32>,
    today: &str,
) -> Vec<String> {
    let all_days: Vec<&ContributionDay> = data
        .weeks
        .iter()
        .flat_map(|w| &w.contribution_days)
        .filter(|d| d.date.as_str() <= today)
        .collect();

    let mut lines = vec![
        String::new(),
        format!("📊 {} contributions in {year}", data.total_contributions),
        String::new(),
    ];

    if let Some(month) = month {
        let year_month = format!("{year}-{month:02}");
        let month_days: Vec<_> = all_days
            .iter()
            .filter(|d| d.date.starts_with(&year_month))
            .collect();
        let month_total: i64 = month_days.iter().map(|d| d.contribution_count).sum();

        lines.extend(
            month_days
                .iter()
                .map(|d| format!("{}: {}", d.date, d.contribution_count)),
        );
        lines.push(String::new());
        lines.push(format!(
            "Total: {month_total} contributions in {year_month}"
        ));
        lines.push(String::new());
        return lines;
    }

    let mut month_totals: BTreeMap<&str, i64> = BTreeMap::new();
    for day in &all_days {
        *month_totals.entry(&day.date[..7]).or_insert(0) += day.contribution_count;
    }
    lines.extend(
        month_totals
            .iter()
            .map(|(ym, total)| format!("{ym}: {total}")),
    );
    lines.push(String::new());
    lines
}

fn get_current_username() -> Result<String, String> {
    let out = run_gh(&[
        "api",
        "graphql",
        "-f",
        "query=query { viewer { login } }",
        "-q",
        ".data.viewer.login",
    ])?;

    if !out.success {
        let detail = out.stderr.trim();
        let lower = detail.to_lowercase();
        let is_auth_error = [
            "auth login",
            "http 401",
            "bad credentials",
            "authentication",
        ]
        .iter()
        .any(|needle| lower.contains(needle));
        let headline = if is_auth_error {
            "Not logged in to GitHub. Run `gh auth login` first"
        } else {
            "Failed to get current user"
        };
        let message = if detail.is_empty() {
            headline.to_string()
        } else {
            format!("{headline}\n\n  {detail}")
        };
        return Err(with_status_hint(message));
    }

    let login = out.stdout.trim();
    if login.is_empty() {
        return Err("Failed to get current user (empty response from gh)".to_string());
    }
    Ok(login.to_string())
}

fn fail(message: &str) -> ! {
    eprintln!("\n  ❌ {message}");
    std::process::exit(1);
}

#[derive(Debug, Default, PartialEq)]
struct Args {
    year: Option<String>,
    month: Option<String>,
    years: bool,
    help: bool,
    version: bool,
    positional: Vec<String>,
}

fn parse_args(argv: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut args = Args::default();
    let mut iter = argv.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            args.positional.extend(iter.by_ref());
            break;
        }
        let (flag, inline_value) = match arg.split_once('=') {
            Some((flag, value)) if arg.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (arg.clone(), None),
        };
        match flag.as_str() {
            "-h" | "--help" => args.help = true,
            "-v" | "--version" => args.version = true,
            "--years" => args.years = true,
            "--year" | "--month" => {
                let value = match inline_value {
                    Some(v) => v,
                    None => iter
                        .next()
                        .ok_or_else(|| format!("Missing value for {flag}"))?,
                };
                if flag == "--year" {
                    args.year = Some(value);
                } else {
                    args.month = Some(value);
                }
            }
            _ if flag.starts_with('-') && flag != "-" => {
                return Err(format!("Unknown option: {arg} (see --help)"));
            }
            _ => args.positional.push(arg),
        }
    }
    Ok(args)
}

fn main() {
    let args = parse_args(std::env::args().skip(1)).unwrap_or_else(|e| fail(&e));

    if args.help {
        println!("{HELP}");
        return;
    }

    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    if args.years && (args.year.is_some() || args.month.is_some()) {
        fail("--years cannot be combined with --year or --month");
    }

    let now = Local::now();
    let year = match &args.year {
        Some(y) => y
            .parse::<i32>()
            .unwrap_or_else(|_| fail(&format!("Invalid --year: {y}"))),
        None => now.year(),
    };
    let month = match (&args.month, &args.year) {
        (Some(m), _) => match m.parse::<u32>() {
            Ok(n) if (1..=12).contains(&n) => Some(n),
            _ => fail(&format!("Invalid --month: {m} (expected 1-12)")),
        },
        (None, Some(_)) => None,
        (None, None) => Some(now.month()),
    };

    let username = match args.positional.first() {
        Some(u) => u.clone(),
        None => get_current_username().unwrap_or_else(|e| fail(&e)),
    };

    println!();
    let mut spinner = Spinner::new(format!("Fetching contributions for @{username}..."));
    spinner.start();

    let lines = if args.years {
        get_yearly_totals(&username, year).map(|totals| format_yearly_totals(&totals))
    } else {
        get_contributions(&username, year)
            .map(|data| format_contribution_graph(&data, year, month, &local_today()))
    };
    match lines {
        Ok(lines) => {
            spinner.succeed(&format!("Fetched contributions for @{username}"));
            for line in lines {
                println!("{line}");
            }
        }
        Err(e) => {
            spinner.fail("Failed to fetch contributions");
            fail(&e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, count: i64, level: &str) -> ContributionDay {
        ContributionDay {
            date: date.to_string(),
            contribution_count: count,
            contribution_level: level.to_string(),
        }
    }

    fn make_data(days: &[(&str, i64)], total: Option<i64>) -> ContributionData {
        ContributionData {
            total_contributions: total.unwrap_or_else(|| days.iter().map(|d| d.1).sum()),
            weeks: vec![Week {
                contribution_days: days.iter().map(|(d, c)| day(d, *c, "NONE")).collect(),
            }],
        }
    }

    fn has(lines: &[String], line: &str) -> bool {
        lines.iter().any(|l| l == line)
    }

    #[test]
    fn month_view_shows_daily_breakdown() {
        let data = make_data(
            &[("2025-06-01", 3), ("2025-06-02", 0), ("2025-06-03", 5)],
            None,
        );
        let lines = format_contribution_graph(&data, 2025, Some(6), "2025-12-31");
        assert!(has(&lines, "2025-06-01: 3"));
        assert!(has(&lines, "2025-06-02: 0"));
        assert!(has(&lines, "2025-06-03: 5"));
        assert!(has(&lines, "Total: 8 contributions in 2025-06"));
    }

    #[test]
    fn year_view_shows_monthly_totals() {
        let data = make_data(
            &[("2025-01-15", 10), ("2025-01-20", 5), ("2025-03-01", 7)],
            None,
        );
        let lines = format_contribution_graph(&data, 2025, None, "2025-12-31");
        assert!(has(&lines, "2025-01: 15"));
        assert!(has(&lines, "2025-03: 7"));
        // Should not include February (no data)
        assert!(!lines.iter().any(|l| l.starts_with("2025-02")));
    }

    #[test]
    fn filters_out_days_after_today() {
        let data = make_data(
            &[("2025-06-01", 3), ("2025-06-02", 5), ("2025-06-03", 2)],
            None,
        );
        let lines = format_contribution_graph(&data, 2025, Some(6), "2025-06-02");
        assert!(has(&lines, "2025-06-01: 3"));
        assert!(has(&lines, "2025-06-02: 5"));
        assert!(!lines.iter().any(|l| l.starts_with("2025-06-03")));
        assert!(has(&lines, "Total: 8 contributions in 2025-06"));
    }

    #[test]
    fn year_view_filters_future_months() {
        let data = make_data(
            &[("2025-01-10", 10), ("2025-06-15", 5), ("2025-12-01", 99)],
            Some(114),
        );
        let lines = format_contribution_graph(&data, 2025, None, "2025-06-30");
        assert!(has(&lines, "2025-01: 10"));
        assert!(has(&lines, "2025-06: 5"));
        assert!(!lines.iter().any(|l| l.starts_with("2025-12")));
    }

    #[test]
    fn header_shows_total_contributions_from_api() {
        let data = make_data(&[("2025-01-01", 1)], Some(999));
        let lines = format_contribution_graph(&data, 2025, Some(1), "2025-12-31");
        assert!(has(&lines, "📊 999 contributions in 2025"));
    }

    #[test]
    fn yearly_view_lists_each_year_with_the_overall_total() {
        let lines = format_yearly_totals(&[(2024, 10), (2025, 0), (2026, 5)]);
        assert!(has(&lines, "📊 15 contributions in 2024-2026"));
        assert!(has(&lines, "2024: 10"));
        assert!(has(&lines, "2025: 0"));
        assert!(has(&lines, "2026: 5"));
    }

    #[test]
    fn chunk_query_to_keeps_month_end_for_past_chunk() {
        let now = parse_ms("2026-08-05T04:00:00Z");
        assert_eq!(
            chunk_query_to("2026-05-01", "2026-06-30", now),
            "2026-06-30T23:59:59Z"
        );
    }

    #[test]
    fn chunk_query_to_clamps_in_progress_chunk_to_now() {
        let now = parse_ms("2026-08-05T04:56:07Z");
        assert_eq!(
            chunk_query_to("2026-07-01", "2026-08-31", now),
            "2026-08-05T04:56:07Z"
        );
    }

    #[test]
    fn chunk_query_to_covers_first_day_of_chunk_starting_after_now() {
        let now = parse_ms("2026-06-30T20:00:00Z");
        assert_eq!(
            chunk_query_to("2026-07-01", "2026-08-31", now),
            "2026-07-02T00:00:00Z"
        );
    }

    #[test]
    fn pad_trailing_days_zero_fills_uncovered_days() {
        let result = pad_trailing_days(
            RangeResult {
                total: 8,
                days: vec![day("2026-07-01", 8, "NONE")],
            },
            "2026-07-01",
            "2026-07-04",
        );
        assert_eq!(result.total, 8);
        assert_eq!(
            result
                .days
                .iter()
                .map(|d| format!("{}:{}", d.date, d.contribution_count))
                .collect::<Vec<_>>(),
            [
                "2026-07-01:8",
                "2026-07-02:0",
                "2026-07-03:0",
                "2026-07-04:0"
            ]
        );
    }

    #[test]
    fn pad_trailing_days_leaves_fully_covered_chunk_unchanged() {
        let days = vec![day("2026-07-03", 2, "NONE"), day("2026-07-04", 1, "NONE")];
        let result = pad_trailing_days(
            RangeResult {
                total: 3,
                days: days.clone(),
            },
            "2026-07-03",
            "2026-07-04",
        );
        assert_eq!(result.days, days);
    }

    #[test]
    fn pad_trailing_days_fills_whole_range_when_nothing_returned() {
        let result = pad_trailing_days(
            RangeResult {
                total: 0,
                days: vec![],
            },
            "2026-07-01",
            "2026-07-03",
        );
        assert_eq!(
            result
                .days
                .iter()
                .map(|d| d.date.as_str())
                .collect::<Vec<_>>(),
            ["2026-07-01", "2026-07-02", "2026-07-03"]
        );
    }

    #[test]
    fn overlay_range_spans_cutoff_for_any_timezone_and_stays_under_a_year() {
        for iso in ["2026-08-11T02:57:00Z", "2026-12-31T23:59:59Z"] {
            let now_ms = parse_ms(iso);
            let OverlayRange { from, to, cutoff } = overlay_range(now_ms);
            // `from` at least 2 days back covers the cutoff day fully even at UTC-12
            assert!(parse_ms(&from) <= now_ms - 2 * DAY_MS);
            assert_eq!(&from[10..], "T00:00:00Z");
            assert!(parse_ms(&to) > now_ms);
            assert!(parse_ms(&to) - parse_ms(&from) < 365 * DAY_MS);
            assert_eq!(cutoff, iso_date(now_ms - DAY_MS));
        }
    }

    #[test]
    fn overlay_range_varies_date_pair_across_close_run_times() {
        let base = parse_ms("2026-08-11T02:57:00Z");
        let keys: std::collections::HashSet<_> = (0..5)
            .map(|s| {
                let r = overlay_range(base + s * 1000);
                format!("{}|{}", r.from, r.to)
            })
            .collect();
        assert!(keys.len() > 1);
    }

    #[test]
    fn apply_overlay_patches_days_on_or_after_cutoff_and_adjusts_total() {
        let data = make_data(
            &[("2026-08-09", 30), ("2026-08-10", 99), ("2026-08-11", 37)],
            None,
        );
        let overlay_days = vec![
            // before cutoff: possibly cut mid-day by the range start — ignored
            day("2026-08-09", 1, "NONE"),
            day("2026-08-10", 99, "FOURTH_QUARTILE"),
            day("2026-08-11", 51, "SECOND_QUARTILE"),
            // future zero-fill days not present in the fetched year are ignored
            day("2026-08-12", 0, "NONE"),
        ];

        let result = apply_overlay(data, overlay_days, "2026-08-10");
        let days = &result.weeks[0].contribution_days;

        assert_eq!(
            days.iter()
                .map(|d| d.contribution_count)
                .collect::<Vec<_>>(),
            [30, 99, 51]
        );
        assert_eq!(days[2].contribution_level, "SECOND_QUARTILE");
        assert_eq!(result.total_contributions, 30 + 99 + 51);
    }

    #[test]
    fn last_day_of_month_handles_leap_years_and_december() {
        assert_eq!(last_day_of_month(2024, 2), 29);
        assert_eq!(last_day_of_month(2025, 2), 28);
        assert_eq!(last_day_of_month(2025, 12), 31);
    }

    #[test]
    fn status_hint_matches_5xx_and_html_responses_only() {
        assert!(with_status_hint("HTTP 502: Bad Gateway".into()).contains("githubstatus"));
        assert!(with_status_hint("invalid character '<' looking".into()).contains("githubstatus"));
        assert!(!with_status_hint("HTTP 404: Not Found".into()).contains("githubstatus"));
        assert!(!with_status_hint("HTTP 5xx".into()).contains("githubstatus"));
    }

    #[test]
    fn parse_args_accepts_both_value_styles_and_rejects_unknown_flags() {
        let parse = |v: &[&str]| parse_args(v.iter().map(|s| s.to_string()));
        assert_eq!(
            parse(&["--year", "2025", "--month=6", "octocat"]).unwrap(),
            Args {
                year: Some("2025".into()),
                month: Some("6".into()),
                positional: vec!["octocat".into()],
                ..Args::default()
            }
        );
        assert!(parse(&["-h"]).unwrap().help);
        assert!(parse(&["--version"]).unwrap().version);
        assert!(parse(&["--years"]).unwrap().years);
        assert!(parse(&["--year"]).is_err());
        assert!(parse(&["--dashboard"]).is_err());
    }
}
