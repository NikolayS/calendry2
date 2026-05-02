# Calendry — Self-Host Guide

> **Status:** placeholder. Full guide lands in Sprint 3 (#10).
> Sections marked _TODO_ are expanded by the Writer track.

## Prerequisites

- Docker + Docker Compose v2
- A domain you control (for SSL and Google OAuth callbacks)
- A Google Cloud project with Calendar API enabled (see `docs/oauth-setup.md`)
- A [Resend](https://resend.com) API key (or a generic SMTP relay — see below)
- Cloudflare account (recommended for DNS + SSL — see below)

## Quick start

```bash
cp .env.example .env.local
# Edit .env.local — fill in every required variable (see variable reference below)
docker compose -f ops/docker-compose.yml up -d
```

The stack starts:

| Service    | Default port | Notes                     |
|------------|-------------|---------------------------|
| web        | 3000        | Next.js booking + admin   |
| worker     | —           | Bun pgque consumer        |
| postgres   | 5432        | Postgres 18 (internal)    |
| postgrest  | 3001        | PostgREST API (internal)  |
| gotrue     | 9999        | Supabase GoTrue auth      |
| realtime   | 4000        | Supabase Realtime         |
| studio     | 3002        | Supabase Studio UI        |

## Cloudflare DNS + SSL

> _TODO: expand in Sprint 3 (#10). The Writer track owns this section._

Key steps (outline):

1. Add your domain to Cloudflare.
2. Set DNS A record pointing to your server IP. Enable Cloudflare proxy.
3. In Cloudflare SSL/TLS settings, set mode to **Full (strict)**.
4. Configure `NEXT_PUBLIC_URL` and `GOTRUE_SITE_URL` in `.env.local` to use your
   `https://` domain.
5. Update your Google OAuth client's authorized redirect URIs to match
   `https://<your-domain>/api/auth/callback/google`.

## Environment variable reference

See `.env.example` for the full list with descriptions.
All variables without a default **must** be set before the stack will start.

## Running migrations

```bash
# Requires sqlever (https://github.com/NikolayS/sqlever)
sqlever deploy --plan db/sqitch.plan
```

Migrations land in Sprint 0/Backend (#6).

## Bring your own SMTP

Set `EMAIL_DRIVER=smtp` and fill the `SMTP_*` variables in `.env.local`.
The worker checks relay connectivity at startup and exits loudly if unreachable.

## Updating

```bash
docker compose -f ops/docker-compose.yml pull
docker compose -f ops/docker-compose.yml up -d
sqlever deploy --plan db/sqitch.plan  # run any new migrations
```

## Troubleshooting

See `docs/troubleshooting.md` (placeholder — Sprint 3).
