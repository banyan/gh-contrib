# gh-contrib

> A CLI tool that displays GitHub contribution history in the terminal using the
> `gh` CLI.

## Prerequisites

- [Deno](https://deno.land/)
- [GitHub CLI (`gh`)](https://cli.github.com/) (authenticated)

## Installation

### As a gh extension

```bash
gh extension install banyan/gh-contrib
```

Then use it as:

```bash
gh contrib
```

### As a standalone CLI

```bash
deno install -g --allow-run --allow-env jsr:@banyan/gh-contrib
```

## Update

### As a gh extension

```bash
gh extension upgrade gh-contrib
```

### As a standalone CLI

```bash
deno install -grf jsr:@banyan/gh-contrib
```

## Usage

```bash
gh contrib                              # Show current month's contributions
gh contrib --year 2025                  # Show all of 2025
gh contrib --year 2025 --month 6        # Show June 2025
gh contrib --dashboard                  # Open an HTML dashboard in your browser
gh contrib octocat                      # Show contributions for a specific user
gh contrib --help                       # Show help
```

### Options

```
--year <YYYY>   Year to display (default: current year)
--month <MM>    Month to display (default: current month)
--dashboard     Open an HTML dashboard for the year in your browser
-h, --help      Show help message
```

### Dashboard

`--dashboard` renders the year as a self-contained HTML page (no external
assets, light/dark aware) and opens it in your browser: isometric / flat
contribution calendar, cumulative pace vs the previous year, 7-day rolling
average, monthly and weekday breakdowns, distribution stats, and milestone pace.
Combine with `--year` or a username as usual.

## Development

```bash
# Run locally
deno task dev

# Run tests
deno task test
```

The dashboard is edited in `dashboard.html` and shipped as the generated
`dashboard_template.ts` (so it works from both the gh extension checkout and the
JSR package). After editing `dashboard.html`, regenerate it:

```bash
deno task template
```

## License

MIT License - see [LICENSE](LICENSE) file for details.
