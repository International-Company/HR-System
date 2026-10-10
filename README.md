# HRMS — Integrated Multi-Company HR Management System

Arabic (RTL) / English (LTR) HR system for a group of companies. Deployed on Railway with PostgreSQL.

**Status:** Phase 1 (Foundation) implemented. See [docs/07-delivery/progress-tracker.md](docs/07-delivery/progress-tracker.md).
The planning package (requirements, architecture, security, roadmap) is in [docs/](docs/README.md).

## Repository layout

```
apps/api        NestJS API + background worker (TypeScript, PostgreSQL via Drizzle)
  migrations/   Forward-only SQL migrations (source of truth for the schema)
  test/         API tests (run on embedded PostgreSQL or a real server)
apps/web        React + Mantine PWA (Arabic/English)
packages/shared Permission catalogue, settings definitions, validation schemas, API types
docs/           Planning package, decisions, operations guides
railway/        Railway config-as-code for the web and worker services
Dockerfile      One image for both services
```

## Deploying

Owner's step-by-step guide (Arabic): [docs/08-operations/railway-setup-guide-ar.md](docs/08-operations/railway-setup-guide-ar.md).
Technical reference: [docs/08-operations/railway-deployment.md](docs/08-operations/railway-deployment.md).

## Development (optional, nothing installed system-wide)

Requires Node.js 24. All tools are project-local npm packages; the database is embedded (PGlite).

```bash
npm ci
cp .env.example .env           # then fill SESSION_SECRET and DATA_ENCRYPTION_KEY
npm run build
npm run seed -- --relax-mfa    # demo data; prints the demo password
npm run dev:api                # http://localhost:3000 (serves the built web app)
npm run dev:web                # optional: Vite dev server on :5173 with hot reload
```

## Quality gates

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) also runs the API suite against real PostgreSQL 17 and 18, a backup → restore test, a secret scan, a dependency audit and a container build.
