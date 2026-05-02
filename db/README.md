# db/ — Calendry database migrations

Migrations are managed with [sqlever](https://github.com/NikolayS/sqlever) (Sqitch-compatible, with static analysis). Each change has a `deploy/`, `revert/`, and `verify/` script.

## Running migrations

```bash
# Start Postgres (dev compose)
docker compose -f ops/docker-compose.yml up -d postgres

# Deploy all pending changes
cd db
sqlever deploy "postgresql://postgres:postgres@localhost:5432/postgres"

# Verify deployed changes
sqlever verify "postgresql://postgres:postgres@localhost:5432/postgres"

# Static analysis — must show zero blocking findings
sqlever analyze

# Roll back all changes (test revert path)
sqlever revert "postgresql://postgres:postgres@localhost:5432/postgres" --to @HEAD^
```

## Migration order

| Change name         | Description                                              |
|---------------------|----------------------------------------------------------|
| `extensions`        | pgcrypto, btree_gist, pg_cron                            |
| `pgque`             | Vendor pgque job-queue engine (requires extensions)      |
| `providers`         | Provider accounts                                        |
| `availability_rules`| Weekly windows + exclusion constraint                    |
| `manual_blackouts`  | Provider-created busy blocks                             |
| `bookings`          | Booking state machine                                    |
| `sync_channels`     | Google watch channel registry                            |
| `busy_blocks`       | Materialized busy-block cache                            |
| `idempotency_keys`  | Deduplication store for external side effects            |
| `email_outbox`      | Transactional email outbox                               |

## Vendored pgque

`db/pgque.sql` is a verbatim copy of `sql/pgque.sql` from [NikolayS/pgque](https://github.com/NikolayS/pgque), prepended with a version-pin comment.

**Current pin:** commit `7366982ef0d8f837d69b296236cce6e08eb74ba1` (2026-05-01), version `1.0.0-dev` (no stable tag existed at vendor time).

### Refresh procedure

When a new pgque tag or commit is available:

```bash
# 1. Clone (or pull) upstream
git clone https://github.com/NikolayS/pgque.git /tmp/pgque_refresh
# or: git -C /tmp/pgque_refresh pull

# 2. (Optional) check out a specific tag
# git -C /tmp/pgque_refresh checkout v1.0.0

# 3. Copy the SQL file
cp /tmp/pgque_refresh/sql/pgque.sql db/pgque.sql

# 4. Update the pin comment at the top of db/pgque.sql:
#    -- Pin: commit <hash> (<date>)
#    -- Version: <tag or "HEAD of main">

# 5. Commit
git add db/pgque.sql
git commit -m "chore(db): refresh pgque vendor to <tag/commit>"
```

> The `pgque` sqlever migration runs `\i pgque.sql` — it re-sources the file
> on every deploy (but pgque itself uses `CREATE … IF NOT EXISTS` everywhere,
> so re-running is a no-op on an already-installed DB).
