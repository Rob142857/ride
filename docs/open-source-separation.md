# Open Source and Deployment Separation

Repository: `https://github.com/Rob142857/ride`

## Goal

Keep product code open source while reducing operational exposure (accounts, cost controls, incident playbooks, and environment-specific automation).

## Recommended Model

Use two repositories:

1. Public product repo (`ride`)
2. Private operations repo (`ride-ops-private`)

## Keep in Public Repo (`ride`)

- App source code (`public/`, `api/`)
- Database schema and migrations (`api/schema.sql`, `api/migrations/`)
- Non-secret deployment templates (`wrangler.toml`, sample env docs)
- User and developer docs
- CI checks that do not require production credentials

## Keep in Private Repo (`ride-ops-private`)

- Cloudflare account IDs not intended for public visibility
- Environment-specific wrangler files if they contain sensitive details
- OAuth app management notes and admin contacts
- Incident runbooks, abuse response playbooks, and moderation SOPs
- Cost dashboards, budget alert thresholds, and billing exports
- Internal monitoring and alert routing setup

## Practical Next Steps

1. Add `.env.example` and `docs/secrets.md` in `ride` (public placeholders only).
2. Remove any production account identifiers from public docs when possible.
3. Store production runbooks and operational scripts in `ride-ops-private`.
4. Keep deploy automation in public repo, but load secrets from CI/CD secret stores.
5. Maintain a small `docs/ops-handoff.md` in public repo that links to private owner-only procedures.

## Optional Monorepo Layout (Future)

If you want stronger modularity later, migrate to:

- `apps/web` (Pages frontend)
- `apps/worker` (Cloudflare Worker API)
- `packages/sdk` (dev-facing API client)
- `packages/shared` (shared types/utils)

This can be done incrementally without changing runtime behavior first.
