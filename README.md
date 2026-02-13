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

2. Copy `.env.example` to `.env` and add your Linear API key:

   ```bash
   cp .env.example .env
   ```

3. Add your Linear API key in `.env` (get it from Linear → Settings → API).

## Usage

### Team report

```bash
node team_issues_report.js
```

Uses `TEAM_EMAILS` from `.env`, or pass emails as arguments. Use `--month "December 2025"` for a specific month, or `--all` for all users.

### Developer report

```bash
node linear_queries_developer.js user@example.com
```

Pass the developer’s email. Optionally add a number of days (e.g. `60`) or `all` for no date filter.

## Requirements

- Node.js
- Linear API key
- Team member emails (optional if using `--all`)
