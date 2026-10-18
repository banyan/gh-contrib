# gh-contrib

> A CLI tool that displays GitHub contribution history in the terminal using the
> `gh` CLI.

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) (authenticated)

## Installation

### As a gh extension

```bash
gh extension install banyan/gh-contrib
```

Releases ship precompiled binaries for macOS, Linux and Windows, so no
toolchain is needed. Then use it as:

```bash
gh contrib
```

### As a standalone CLI

```bash
cargo install --git https://github.com/banyan/gh-contrib
```

## Update

### As a gh extension

```bash
gh extension upgrade gh-contrib
```

### As a standalone CLI

```bash
cargo install --force --git https://github.com/banyan/gh-contrib
```

## Usage

```bash
gh contrib                              # Show current month's contributions
gh contrib --year 2025                  # Show all of 2025
gh contrib --year 2025 --month 6        # Show June 2025
gh contrib --years                      # Show yearly totals since the first contribution
gh contrib octocat                      # Show contributions for a specific user
gh contrib --help                       # Show help
```

### Options

```
--year <YYYY>   Year to display (default: current year)
--month <MM>    Month to display (default: current month)
--years         Show yearly totals since the first contribution
-h, --help      Show help message
```

> [!NOTE]
> The HTML dashboard (`--dashboard`) moved into
> [banyan/errands](https://github.com/banyan/errands), which rebuilds it daily
> and serves it at dashboard.mi.nu/gh-contrib.

## Development

Requires [Rust](https://rustup.rs/).

```bash
# Run locally
cargo run -- --year 2025

# Run tests
cargo test
```

### Releasing

Bump `version` in `Cargo.toml`, commit, then push a `v<version>` tag. The
Release workflow builds the binaries and publishes the GitHub release that
`gh extension install` / `upgrade` pick up.

> [!NOTE]
> Versions up to 0.5.1 were written in Deno and published to JSR as
> `@banyan/gh-contrib`. Deno's development ends in 2027, so 0.6.0 is a Rust
> rewrite with the same output; the JSR package is no longer updated.

## License

MIT License - see [LICENSE](LICENSE) file for details.
