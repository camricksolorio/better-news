<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Better News

A news aggregator that ingests RSS feeds from a spread of outlets (left,
center, right, international, business/tech — see `feeds.config.ts`) into a
single feed, so a reader sees more than one editorial voice on the same
story. Longer-term goal: cluster articles across outlets about the same
event (Ground News-style).

## Feature and dev work

All feature/dev work is documented under `docs/<feature-name>/` as `prd.md`,
`tdd.md`, and `plan.md`. Read `docs/AGENTS.md` for the conventions before
starting or planning any work.

## Stack

- **Next.js 16 (App Router)**, React 19, Tailwind v4 — `app/page.tsx` is the
  only real page; it's a server component that reads straight from the DB.
- **Postgres via Supabase**, accessed with **Drizzle ORM** (`db/schema.ts`,
  `db/index.ts`). One table: `feed_items`, deduped by `guid`.
- **pnpm** workspace (see `pnpm-workspace.yaml`) — use `pnpm`, not `npm`/`yarn`.
- Deployed on **Vercel**, project `better-news`
  (`better-news-pearl.vercel.app`), auto-deploys `main` on push.

## How ingestion works

- `feeds.config.ts` — flat list of `{ id, label, url }` RSS sources. Add or
  remove sources here; nothing else needs to change to pick them up.
- `lib/rss.ts` — `parseRssFeed(xml)` handles RSS 2.0, RSS 1.0/RDF, and Atom.
  Not every feed on the internet fits one of these — check the actual XML
  shape before assuming a new source will parse.
- `app/api/ingest/route.ts` — fetches every source in `FEED_SOURCES`
  concurrently, parses it, and upserts into `feed_items` by `guid`. Requires
  `Authorization: Bearer $CRON_SECRET` if `CRON_SECRET` is set (it always is
  in production; unset it's open, which is only meant for local dev).
- `.github/workflows/*.yml` — GitHub Actions cron hits `/api/ingest` every 6
  hours (Vercel's Hobby plan only allows daily cron). Also runnable manually
  from the Actions tab, or with `gh workflow run`.
- **Adding a source to `feeds.config.ts` does not backfill history** — it
  only takes effect the next time `/api/ingest` runs. After deploying a
  config change, either wait for the next cron tick or trigger ingest
  manually (see below) if you want to see it show up immediately.

## Local setup

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL (Supabase pooler connection string)
pnpm dev
```

`CRON_SECRET` in `.env` is optional locally — `/api/ingest` is unauthenticated
if it's unset. Set it if you want to test the auth path.

DB schema changes: edit `db/schema.ts`, then `pnpm db:generate` (writes a
migration) and `pnpm db:push` (applies it) — see `package.json` scripts.

## Interacting with this repo as an agent

**GitHub — use the `gh` CLI**, not raw git-over-HTTPS or the web UI, for
anything involving PRs, issues, or Actions:

```bash
gh pr create ...
gh pr view ...
gh run list --workflow "Ingest feeds"
gh workflow run "Ingest feeds"   # manually trigger ingestion instead of waiting for cron
```

**Vercel — use the Vercel MCP tools**, not a `.vercel/project.json` file
(this repo doesn't have one linked locally, and doesn't need one for MCP
access). Useful lookups:

- `list_projects` (search "better-news") → project ID
- `list_deployments` (by `projectId`) → recent deploys, build state, which
  commit is live in production
- `list_project_domains` (by `idOrName`) → the actual production hostname
  to hit (`better-news-pearl.vercel.app`) — deployment-specific URLs like
  `better-news-<hash>-<team>.vercel.app` are behind Vercel SSO and will
  redirect instead of serving the app directly.

Vercel is configured to auto-deploy the latest commit on `main` — pushing
to `main` is enough to ship, no manual deploy step needed. That only
updates the deployed code, though; it does not run ingestion, so a
`feeds.config.ts` change still needs a manual trigger or a cron tick before
new sources show up (see above).

To manually trigger a production ingest run (e.g. right after deploying a
`feeds.config.ts` change, without waiting for the next cron tick):

```bash
curl -s "https://better-news-pearl.vercel.app/api/ingest" \
  -H "Authorization: Bearer $CRON_SECRET"
```

`CRON_SECRET` is in the local `.env` (not committed) and set as a secret on
both the GitHub Actions workflow and the Vercel project — treat it like any
other credential, don't print it or commit it.
