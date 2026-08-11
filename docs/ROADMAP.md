# Tyrion Delivery Roadmap

**Last updated:** 2026-08-08

**Product boundary:** [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md)

**Delivery target:** Mission Control's household-finance domain

This is the authoritative Tyrion roadmap. It replaces the standalone finance-app
roadmap and tracks four delivery streams: connector reliability, domain workflows,
automation, and reconciliation. Prototype completeness is not product completion.

## Delivery principles

- Monarch remains the financial system of record.
- Mission Control remains the user-facing action, awareness, and assistant shell.
- Ship exception-oriented workflows before broad summaries or optional automation.
- Write changes back to Monarch rather than creating a competing local truth.
- Deep-link to Monarch and document systems instead of duplicating their full UIs.
- Use `triage-app/` for bounded Tyrion-owned domain configuration, connector
  operations, diagnostics, contract validation, and focused UX experiments.

## Current baseline

| Area | Available baseline | Product gap |
| --- | --- | --- |
| Connector | FastAPI bridge, read endpoints, category write-back, demo/live modes | Contract hardening, incremental sync, retries, health, and write-back auditability |
| Domain logic | Versioned kid policy, attribution, review, re-attribution, authorization, persistence ports, and a secure file adapter | Production persistence/API adapter and Mission Control-native exception workflows |
| Automation | Alert concepts and weekly-summary logic | Durable scheduling, idempotency, notification delivery, and task lifecycle |
| Reconciliation | Bill and document matching designs | Stable cross-system identities, match lifecycle, evidence links, and audit trail |
| UI reference | Mockups and standalone Next.js prototype | Bounded debug mode and migration of useful patterns into Mission Control |

## Milestone 1 — Boundary and connector contract

**Outcome:** Mission Control can depend on a named, observable Monarch connector
without inheriting a second product shell.

**GitHub tracking:** [#11](https://github.com/rsocko/tyrion/issues/11),
[#12](https://github.com/rsocko/tyrion/issues/12),
[#14](https://github.com/rsocko/tyrion/issues/14),
[#15](https://github.com/rsocko/tyrion/issues/15),
[#16](https://github.com/rsocko/tyrion/issues/16), and
[#19](https://github.com/rsocko/tyrion/issues/19).

- [x] Adopt the Tyrion/Mission Control/Monarch product boundary.
- [x] Preserve the standalone UI as a debug and validation surface.
- [ ] Publish versioned bridge schemas for transactions, accounts, categories,
  recurring items, budgets, health, and mutations.
- [ ] Define stable source IDs, cursor semantics, timestamps, deletion behavior,
  and provenance (`via Monarch`).
- [ ] Add incremental and full-sync behavior with idempotent upserts.
- [ ] Specify retryable versus terminal failures and surface connector health.
- [ ] Record every mutation attempt and resulting Monarch state.
- [ ] Normalize product copy while documenting compatibility identifiers.

**Exit criteria:** A fixture-backed connector contract is versioned and tested;
repeated syncs are safe; failures and write-backs are observable; Mission Control
can identify Tyrion data as Monarch-sourced.

## Milestone 2 — Native Tyrion domain

**Outcome:** Mission Control presents household-finance exceptions and policy
without reproducing Monarch's workspace.

**GitHub tracking:** [#13](https://github.com/rsocko/tyrion/issues/13) and
[#18](https://github.com/rsocko/tyrion/issues/18).

- [ ] Register **Finance** navigation with Tyrion identity and `/finance` routes.
- [ ] Build an attention overview for pending exceptions, kid-limit status,
  reconciliation issues, sync health, and compact summaries.
- [ ] Build exception-only review for ambiguous attribution, anomalies,
  reconciliation mismatches, and failed write-backs.
- [ ] Build the bounded Tyrion configuration UI for kid profiles, card and merchant
  rules, limits, policy versions, and controlled re-attribution.
- [x] Add Mission Control attribution explanations, correction, unassignment, and
  exception actions against Tyrion's versioned domain contract.
- [ ] Repair finance notification actions and deep-link ordinary workflows to
  Monarch.
- [ ] Apply Mission Control auth, accessibility, responsive layout, and shared
  master-detail patterns.

**Exit criteria:** A user can resolve every supported Tyrion exception from Mission
Control or follow an explicit deep link to its authoritative system. No generic
ledger, budget manager, bills app, or separate chat is introduced.

## Milestone 3 — Durable automation

**Outcome:** Tyrion turns finance signals into trustworthy Mission Control
awareness and action.

**GitHub tracking:** [#17](https://github.com/rsocko/tyrion/issues/17),
[#20](https://github.com/rsocko/tyrion/issues/20),
[#22](https://github.com/rsocko/tyrion/issues/22),
[#23](https://github.com/rsocko/tyrion/issues/23), and
[#24](https://github.com/rsocko/tyrion/issues/24).

- [ ] Run threshold, anomaly, duplicate, sync-health, and summary jobs on durable
  schedules.
- [ ] Detect unusual recurring-bill amounts using rolling and seasonally comparable
  baselines, combined dollar/percentage thresholds, and available usage or
  billing-period evidence ([#22](https://github.com/rsocko/tyrion/issues/22)).
- [ ] Detect month-over-month category and merchant variance using equivalent
  elapsed periods, minimum samples, material-dollar thresholds, and explainable
  transaction contributors
  ([#24](https://github.com/rsocko/tyrion/issues/24)).
- [ ] Detect unusually large individual transactions against explicit household
  rules and adaptive account, category, and merchant baselines while suppressing
  expected transfers and obligations
  ([#23](https://github.com/rsocko/tyrion/issues/23)).
- [ ] Make generated notifications and tasks deterministic and idempotent.
- [ ] Distinguish informational signals from work requiring follow-up.
- [ ] Reconcile task state when Monarch or a source document resolves the issue.
- [ ] Deliver a weekly decision summary focused on changes and required actions.
- [ ] Add read-only Tyrion tools to Houston for summaries, transaction search,
  kid totals, pending exceptions, and obligations, following the
  [Monarch data-access and Houston tools design](./MONARCH-DATA-ACCESS-AND-HOUSTON-TOOLS.md).
- [ ] Add confirmed category and kid-assignment mutations only after read tooling
  and audit behavior are stable.

**Exit criteria:** Re-running jobs creates no duplicates; source changes settle
open work predictably; Houston reports provenance and asks for confirmation before
mutations.

## Milestone 4 — Cross-system reconciliation

**Outcome:** Mission Control coordinates financial obligations across Monarch and
OWL/Document Intelligence while each source retains authority.

**GitHub tracking:** [#6](https://github.com/rsocko/tyrion/issues/6),
[#9](https://github.com/rsocko/tyrion/issues/9), and
[#21](https://github.com/rsocko/tyrion/issues/21).

- [ ] Define obligation, document, transaction, candidate-match, and resolution
  identities.
- [ ] Match bills, statements, EOBs, and receipts to Monarch transactions with
  explainable confidence.
- [ ] Reconcile OWL bills and credit-card statements with Monarch to detect high
  bill or statement totals, amount mismatches, missing payments, and unusually
  large statement contributors
  ([#21](https://github.com/rsocko/tyrion/issues/21)).
- [ ] Surface missing, duplicate, late, unmatched, and conflicting records as
  exceptions.
- [ ] Preserve deep links to Monarch transactions and original source documents.
- [ ] Add manual confirm, reject, rematch, defer, and reopen actions with history.
- [ ] Auto-resolve related notifications and tasks when authoritative evidence
  confirms completion.

**Exit criteria:** Every reconciliation decision is explainable and auditable;
users can reach both source records; Tyrion does not become a document or
transaction system of record.

## Milestone 5 — Operational hardening

**Outcome:** The connector and domain are safe for unattended household use.

**GitHub tracking:** [#11](https://github.com/rsocko/tyrion/issues/11),
[#12](https://github.com/rsocko/tyrion/issues/12),
[#19](https://github.com/rsocko/tyrion/issues/19), and
[#25](https://github.com/rsocko/tyrion/issues/25).

- [ ] Protect credentials and sensitive payloads at rest and in transit.
- [ ] Add structured logs, metrics, traces, redaction, and retention policy.
- [ ] Monitor sync freshness, job success, queue depth, mutation failures, and
  contract drift.
- [ ] Add backup and recovery for Tyrion-owned policy and audit data.
- [ ] Exercise expired sessions, Monarch outages, partial syncs, conflicting
  updates, and recovery procedures.
- [ ] Document setup, diagnostics, incident response, and connector upgrade steps.

**Exit criteria:** Operators can detect, diagnose, and recover from connector and
automation failures without using the product UI as a hidden source of truth.

## Explicitly out of scope

- Expanding the standalone app into a deployable product
- Full account, transaction, budget, report, net-worth, investment, goal, or
  forecasting experiences
- Ordinary transaction review or receipt matching already handled by Monarch
- A generic bills calendar
- A Tyrion-specific chat shell separate from Houston
- Cosmetic parity work on frozen prototype screens unless needed for a validated
  Mission Control interaction

## Roadmap governance

Roadmap items must name the owning system, preserve source provenance, and pass the
change test in [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md). New work that
duplicates Monarch or Mission Control requires an explicit revision to the product
boundary before it can enter this roadmap.
