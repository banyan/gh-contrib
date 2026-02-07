# gh-contrib

>A CLI tool that displays GitHub contribution history in the terminal using the `gh` CLI.

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

## Usage

```bash
gh contrib                              # Show current month's contributions
gh contrib --year 2025                  # Show all of 2025
gh contrib --year 2025 --month 6        # Show June 2025
gh contrib octocat                      # Show contributions for a specific user
gh contrib --help                       # Show help
```

### Options

```
--year <YYYY>   Year to display (default: current year)
--month <MM>    Month to display (default: current month)
-h, --help      Show help message
```

## Development

```bash
# Run locally
deno run --allow-run --allow-env main.ts

# Run tests
deno test
```

## License

MIT License - see [LICENSE](LICENSE) file for details.
