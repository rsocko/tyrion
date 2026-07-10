# Personal Finance Manager — Phased Roadmap

**Last Updated:** 2026-07-10  
**Overall Status:** ~42% Complete (Early Prototype)  
**Target:** Homelab Beta by end of Phase 3

---

## Current State Summary

| Layer | Component | Status | Completion |
|-------|-----------|--------|------------|
| Design | Docs + Mockups | ✅ Excellent | 100% |
| Backend | Kid Engine (TypeScript) | ✅ Production-ready | 85% |
| Backend | Monarch Bridge (Python) | ⚠️ Merge conflicts + untested live | 65% |
| Frontend | Triage App (Next.js) | ⚠️ UI exists, no persistence | 50% |
| Infrastructure | DB / Auth / Deploy | ❌ Not started | 0% |
| Features | Alerts / Chat / Paperless | ❌ Design only | 0–10% |

---

## Phase 1 — Stabilize Core (Weeks 1–2)

> **Goal:** Get all existing code compiling and connected end-to-end with persistence.

| # | Task | Component | Priority | Effort |
|---|------|-----------|----------|--------|
| 1.1 | Resolve merge conflicts in `monarch-bridge/main.py` | Bridge | P0 | 1h |
| 1.2 | Implement SQLite schema + Drizzle ORM (transactions, kids, rules, alerts) | Triage App | P0 | 3–4h |
| 1.3 | Create `/api/bridge/[...path]` proxy route in Next.js | Triage App | P0 | 1h |
| 1.4 | Wire Bridge `/sync` to Triage — trigger sync from UI | Integration | P0 | 2h |
| 1.5 | Persist triage edits (kid assignment, category confirm) to DB | Triage App | P0 | 3h |
| 1.6 | Build `/settings` page — kid profiles CRUD | Triage App | P1 | 3h |
| 1.7 | Import Kid Engine into Triage as dependency | Integration | P1 | 1h |
| 1.8 | Add error boundaries + loading states to all pages | Triage App | P1 | 2h |

**Exit Criteria:** Triage edits persist across page reloads; Bridge ↔ Triage connected in demo mode; settings page renders kid profiles.

---

## Phase 2 — Complete Data Flow & Live Mode (Weeks 3–4)

> **Goal:** Full live data integration with Monarch; kid attribution running in real-time.

| # | Task | Component | Priority | Effort |
|---|------|-----------|----------|--------|
| 2.1 | Test Monarch Bridge in live mode with real credentials | Bridge | P0 | 2h |
| 2.2 | Wire live data toggle through all pages (dashboard, triage, kids, bills) | Triage App | P0 | 3h |
| 2.3 | Run Kid Engine attribution on incoming transactions (post-sync) | Integration | P0 | 2h |
| 2.4 | Implement threshold alert engine (node-cron or Bridge cron) | Kid Engine / Bridge | P1 | 3h |
| 2.5 | Build alert notification delivery (Mission Control integration or email) | Integration | P1 | 2h |
| 2.6 | Add rule suggestion UI — accept/reject suggested kid rules | Triage App | P1 | 2h |
| 2.7 | Implement re-sync trigger after triage edits | Integration | P2 | 1h |
| 2.8 | Add structured logging (Pino for Node, structlog for Python) | All | P2 | 2h |

**Exit Criteria:** Live Monarch data flows through Bridge → Triage → DB → Kid Engine → Alerts. Threshold notifications fire on configured limits.

---

## Phase 3 — Homelab Beta Deployment (Weeks 5–6)

> **Goal:** Deploy to homelab infrastructure; usable daily by the family.

| # | Task | Component | Priority | Effort |
|---|------|-----------|----------|--------|
| 3.1 | Create Dockerfiles — Bridge (Python) + Triage (Node) | Infra | P0 | 2h |
| 3.2 | Docker Compose stack (Bridge + Triage + SQLite volume) | Infra | P0 | 1h |
| 3.3 | Secrets management — encrypted `.env` or Docker secrets | Infra | P0 | 1h |
| 3.4 | Add basic auth or Authentik SSO integration | Infra | P0 | 2–3h |
| 3.5 | Implement CI pipeline (GitHub Actions — lint, test, build) | Infra | P1 | 2h |
| 3.6 | Scheduled sync job (cron — sync Monarch every 4h) | Bridge | P1 | 1h |
| 3.7 | Health check endpoint monitoring (Uptime Kuma or similar) | Infra | P2 | 1h |
| 3.8 | Write setup guide + troubleshooting doc | Docs | P1 | 2h |
| 3.9 | Add component tests (Vitest for React) + Bridge integration tests | Testing | P1 | 3h |

**Exit Criteria:** `docker compose up` brings up the full stack on homelab. Auth protects the UI. Monarch syncs on schedule. Family can triage transactions daily.

### 🏠 Homelab Readiness Decision

**When to deploy to homelab: End of Phase 3 (~Week 6)**

The system reaches beta when:
- ✅ Live Monarch data syncs reliably
- ✅ Triage edits persist and kid attribution runs
- ✅ Alerts fire for threshold breaches
- ✅ Docker Compose stack deploys cleanly
- ✅ Basic auth or SSO protects the interface
- ✅ Health monitoring is active

**Not required for beta:**
- AI Chat, Paperless integration, weekly summaries (Phase 4+)
- Migration tooling, advanced ML attribution
- Multi-user RBAC (single-family use case)

---

## Phase 4 — Advanced Features (Weeks 7–10)

> **Goal:** Add the remaining designed features; polish for daily use.

| # | Task | Component | Priority | Effort |
|---|------|-----------|----------|--------|
| 4.1 | AI Finance Chat — connect MCP server, implement chat UI | Triage App | P1 | 4h |
| 4.2 | Weekly spending summaries — email or Mission Control digest | Integration | P1 | 3h |
| 4.3 | Subscription audit — detect duplicate/forgotten recurring charges | Bridge + UI | P2 | 3h |
| 4.4 | Cash flow forecasting — project future balance from patterns | Bridge + UI | P2 | 4h |
| 4.5 | Paperless bill reconciliation — bill-to-transaction matching | Integration | P2 | 5h |
| 4.6 | Bill reconciliation UI (from mockup) | Triage App | P2 | 3h |
| 4.7 | E2E tests (Playwright) | Testing | P2 | 3h |

---

## Phase 5 — Production Hardening (Weeks 11+)

> **Goal:** Long-term stability, observability, and automation.

| # | Task | Component | Priority | Effort |
|---|------|-----------|----------|--------|
| 5.1 | Database backup automation (SQLite → S3/NAS) | Infra | P1 | 1h |
| 5.2 | Log aggregation (Loki or similar) | Infra | P2 | 2h |
| 5.3 | Rate limiting on Bridge API | Bridge | P2 | 1h |
| 5.4 | Monarch API change detection / alerting | Bridge | P2 | 2h |
| 5.5 | Mobile-responsive polish | Triage App | P2 | 3h |
| 5.6 | Advanced kid attribution (ML patterns, location data) | Kid Engine | P3 | 5h |
| 5.7 | Multi-account household support | All | P3 | 5h |

---

## Known Technical Debt

| Issue | Severity | Location |
|-------|----------|----------|
| Merge conflicts in `main.py` (lines 275–408) | 🔴 HIGH | `monarch-bridge/main.py` |
| No persistence layer — triage edits lost on reload | 🔴 HIGH | `triage-app/` |
| No error handling when Bridge is offline | 🟡 MEDIUM | `triage-app/src/lib/bridge-client.ts` |
| No Python lock file (`poetry.lock` / `Pipfile.lock`) | 🟡 MEDIUM | `monarch-bridge/` |
| Next.js 14 → 15 upgrade available | 🟢 LOW | `triage-app/package.json` |
| No frontend tests | 🟡 MEDIUM | `triage-app/` |
| `monarchmoneycommunity` pinned loosely (`>=0.3.0`) | 🟡 MEDIUM | `monarch-bridge/requirements.txt` |

---

## Feature Coverage Map

| Feature (from README) | Designed | Engine | UI | Live Data | Status |
|------------------------|----------|--------|----|-----------|--------|
| Per-Kid Spending | ✅ | ✅ | ⚠️ Mock | ❌ | 70% |
| Triage Inbox | ✅ | N/A | ⚠️ No persist | ❌ | 60% |
| Threshold Alerts | ✅ | ✅ | ❌ | ❌ | 40% |
| AI Finance Chat | ✅ | N/A | ❌ Stub | ❌ | 10% |
| Weekly Summaries | ✅ | ❌ | ❌ | ❌ | 0% |
| Subscription Audit | ✅ | ❌ | ❌ | ❌ | 0% |
| Cash Flow Forecasting | ✅ | ❌ | ❌ | ❌ | 0% |
| Paperless Integration | ✅ | ❌ | ❌ | ❌ | 0% |
