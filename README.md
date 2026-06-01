# Linear Reports

A set of scripts to fetch and report on activity from [Linear](https://linear.app) for your team.

## What it does

- **Team Issues Report** – Aggregate view of issues per developer (assigned, created, completed, estimated points, etc.)
- **Developer Activity Report** – Detailed activity for a single developer (comments, reactions, issues created/assigned)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and configure authentication:

   ```bash
   cp .env.example .env
   ```

3. Add your Linear credentials in `.env` (get an API key from **Linear → Settings → API**):
   - `LINEAR_API_KEY` — personal API key (recommended), or
   - `LINEAR_ACCESS_TOKEN` — OAuth 2.0 access token

4. Optionally set defaults in `.env` (see [Environment variables](#environment-variables) below).

## Usage

Both scripts print a summary to the console and save a text report under `reports/`. Use `--export` or `--json` to also write a JSON file.

---

### Team Issues Report (`team_issues_report.js`)

Aggregates issue stats per developer: assigned, created, completed, merged PRs, estimated points, and total handled.

**Basic usage** — uses `TEAM_EMAILS` from `.env`:

```bash
node team_issues_report.js
```

**Specify team members on the command line** (overrides `TEAM_EMAILS`):

```bash
node team_issues_report.js dev1@example.com dev2@example.com
```

**Date range options** (default: last 30 days, or `TEAM_DAYS_BACK` from `.env`):

```bash
# Last N days
node team_issues_report.js --days 60

# Specific calendar month (year defaults to current year)
node team_issues_report.js --month "December 2025"
node team_issues_report.js --month Oct
node team_issues_report.js --month 10/2024

# All time (no date filter)
node team_issues_report.js all
```

**Report on every user in the workspace** (slow; prompts for confirmation):

```bash
node team_issues_report.js --all
node team_issues_report.js --all --month "October 2024"
node team_issues_report.js --all --yes          # skip confirmation (automation/CI)
TEAM_REPORT_ALL_CONFIRM=1 node team_issues_report.js --all
```

**Export JSON in addition to the default text file:**

```bash
node team_issues_report.js --export
# or
node team_issues_report.js --json
```

**Combined example:**

```bash
node team_issues_report.js dev1@example.com dev2@example.com --month "November 2025" --export
```

| Flag | Description |
|------|-------------|
| `[email ...]` | Team member emails (overrides `TEAM_EMAILS`) |
| `--days N` | Look back N days from today |
| `--month MONTH` | Filter to a calendar month (`October`, `Oct`, `10`, `2024-10`, `October 2024`, `10/2024`) |
| `all` | No date filter (all time) |
| `--all` | Include every workspace user instead of a team list |
| `--yes`, `-y` | Skip the `--all` confirmation prompt |
| `--export`, `--json` | Also save a JSON report |

**Output:** `reports/team_issues_report_<date>.txt` (and optionally `.json`). When using `--month`, the filename includes the month slug (e.g. `team_issues_report_december_2025.txt`).

---

### Developer Activity Report (`linear_queries_developer.js`)

Detailed activity for a single developer: comments, reactions, issue interactions, issues created/assigned, and merged PR count.

**Basic usage:**

```bash
node linear_queries_developer.js user@example.com
```

Uses the last 30 days by default. You can also set `USER_EMAIL` in `.env` and run without arguments.

**Custom date range:**

```bash
# Last N days
node linear_queries_developer.js user@example.com 60

# All time (no date filter)
node linear_queries_developer.js user@example.com all
node linear_queries_developer.js user@example.com 0
```

**Include archived issues** (Linear `includeArchived` on issues and comments):

```bash
node linear_queries_developer.js user@example.com --include-archived
# or set INCLUDE_ARCHIVED_ISSUES=true in .env
```

**Export JSON in addition to the default text file:**

```bash
node linear_queries_developer.js user@example.com --export
```

| Argument / flag | Description |
|-----------------|-------------|
| `user@example.com` | Developer email (required unless `USER_EMAIL` is set) |
| `[days]` | Look back N days; use `all` or `0` for no date filter |
| `--include-archived` | Include archived issues and comments |
| `--export`, `--json` | Also save a JSON report |

**Output:** `reports/activity_report_<user>_<date>.txt` (and optionally `.json`).

---

## Environment variables

| Variable | Script | Description |
|----------|--------|-------------|
| `LINEAR_API_KEY` | Both | Personal API key (required unless using access token) |
| `LINEAR_ACCESS_TOKEN` | Both | OAuth 2.0 access token (alternative to API key) |
| `TEAM_EMAILS` | Team report | Comma- or space-separated team emails |
| `TEAM_DAYS_BACK` | Team report | Default lookback in days (default: 30) |
| `TEAM_REPORT_ALL_CONFIRM` | Team report | Set to `1` or `yes` to skip `--all` confirmation in non-interactive environments |
| `DEBUG_PR_METADATA` | Both | Set to `true` to log PR attachment metadata when detecting merged PRs |
| `USER_EMAIL` | Developer report | Default email when not passed on the command line |
| `INCLUDE_ARCHIVED_ISSUES` | Developer report | Set to `true` or `1` to include archived issues |

See `.env.example` for a full template.

## Requirements

- Node.js
- Linear API key or OAuth access token
- Team member emails in `.env` or on the command line (team report only; omit when using `--all`)
