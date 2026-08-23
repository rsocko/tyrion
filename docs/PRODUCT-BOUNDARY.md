# Tyrion Product Boundary

**Status:** Accepted and authoritative  
**Adopted:** 2026-08-08  
**Supersedes:** Standalone-product direction in `README.md`, `docs/DESIGN.md`,
`docs/CROSS-SYSTEM-INTEGRATION.md`, `docs/ROADMAP.md`, and `brand/PRODUCT.md`

## Decision

**Tyrion is Mission Control's household-finance domain and specialist.**

Mission Control is the user-facing shell for cross-domain awareness, action, and
conversation. Monarch is the financial system of record and the comprehensive
finance workspace. Tyrion connects the two: it applies household-specific policy,
automation, attribution, and reconciliation, then surfaces only the exceptions and
decisions that belong in Mission Control.

Tyrion owns its money-domain configuration: kid profiles, attribution rules, limits,
policy, connector setup, and policy versioning. A bounded Tyrion UI may host those
administrative workflows alongside connector operations. Mission Control consumes
the resulting contracts and remains the shell for insights, exceptions, review,
notifications, and actions.

The Next.js code in `triage-app/` is the current bounded Tyrion operations and
configuration host, contract-validation harness, and UX reference. It may grow to
support the Tyrion-owned configuration above, but it is not a ledger, dashboard,
reporting product, broad transaction browser, or separate assistant shell.

## System ownership

| System | Owns | Does not own |
| --- | --- | --- |
| **Monarch** | Accounts, transactions, categories, budgets, recurring transactions, reports, goals, forecasts, investments, and ordinary receipt matching | Household-specific attribution, cross-system work prioritization, or Mission Control tasks |
| **Mission Control** | Finance attention surfaces, exception review and actions, notifications, tasks, My Day, Houston, navigation, authentication, and shared interaction patterns | Tyrion policy CRUD, connector setup, a replacement ledger, budget manager, report suite, bills app, or second finance assistant |
| **Tyrion domain** | Kid/profile configuration, card and merchant rules, limits, policy versions, per-kid attribution, exception detection, decision summaries, finance tools, and reconciliation orchestration | Authoritative copies of Monarch data or a general-purpose finance application |
| **Tyrion attribution service** | Protected, household-scoped batch evaluation of privacy-safe normalized attribution facts against the current Tyrion policy | Bridge transport, browser access, raw transaction/account records, or executable engine distribution to consumers |
| **Monarch Bridge** | Authenticated Monarch access, deterministic synchronization, normalized contracts, write-back, health, and observability | Product navigation, task ownership, broad reporting UI, or an assistant shell |
| **Tyrion operations/configuration UI** | Tyrion-owned kid, rule, limit, policy, and connector configuration; connector reachability; authentication setup/status; logout; bounded sync/recheck; contract validation | Daily finance attention, ordinary transactions, accounts, budgets, bills, generic triage, dashboards, reporting, or chat |

## Production Tyrion UI boundary

The foreseeable production deployment is one trusted, single-household homelab. It is
not a public SaaS, multi-user, or multi-tenant service. The operations UI has no
directly published container port; its browser routes are reachable only through the
homelab ingress and its `trusted-private-networks` middleware. Within that boundary,
Tyrion uses one fixed local-operator actor and one fixed household scope rather than
accepting browser identity, household, or permission claims.

`https://tyrion.socko.us` may host the bounded Tyrion configuration and Monarch
connector operations UI. Connector browser calls use only allowlisted Next.js
`/api/bridge/...` routes. The bridge service token remains server-only, and the
bridge remains privately routed with its own session storage and protected contract.
Policy configuration uses a Tyrion-owned authenticated API and persistence boundary;
it never stores or proxies reusable Monarch session material.

Mission Control server and worker processes may call the separately allowlisted
`https://tyrion.socko.us/api/connector/v1` gateway with the existing server-only
finance-manager bearer credential. This is an accepted backend transport exception to
the otherwise private bridge boundary, not a browser or product surface. The gateway
exposes only bounded Bridge v1 health, contract, transaction read/detail/split/category
mutation, account, category-group, category, tag, recurring, budget, and sync
operations, plus the read-only Finance Insights document-expectation projection for
OWL. It authenticates every request, rejects browser-originated requests, and does not
expose auth setup, logout, session state, raw upstream routes, arbitrary passthrough,
cash flow, OpenAPI/docs, policy, or attribution operations. The raw
Monarch Bridge, its reusable session material, and its auth/session setup remain
private.

Mission Control calls Tyrion's protected versioned batch attribution API over the
private service network. It must not install, copy, or execute `kid-engine`; that
module remains internal to Tyrion. The attribution route is not a Monarch Bridge
endpoint and is explicitly excluded from the public `tyrion.socko.us` router. It
accepts the fixed private Docker authority only, rejects any different forwarded
authority, and uses the existing server-only bridge/finance-manager token as its
bearer credential.

The production browser route tree and `/api/bridge/...` proxy allowlist must prevent
access to transactions, accounts, categories, recurring items, cash flow, budgets,
bills, broad kid-spending dashboards, chat, generic triage, or other finance product
pages. The bearer-protected `/api/connector/v1` backend gateway is the sole narrow
exception for Mission Control connector transport. Configuration-only kid,
attribution-rule, limit, policy, and connector routes are otherwise permitted.
Mission Control remains the day-to-day shell, and Monarch remains the comprehensive
finance workspace.

## Supported Mission Control surfaces

- `/finance` presents an attention overview: pending exceptions, per-kid policy
  status, reconciliation issues, sync health, and decision-oriented summaries.
- `/finance/review` handles only ambiguity, anomalies, reconciliation mismatches,
  and failed write-backs that require human judgment.
- `/finance/kids` may summarize per-kid status and link to Tyrion configuration;
  profile, rule, limit, and policy CRUD remains Tyrion-owned.
- `/finance/reconciliation` coordinates Monarch transactions with documents and
  obligations owned by OWL/Document Intelligence or other source systems.
- `/finance/settings` shows connector health and links to Tyrion-owned policy and
  connector configuration.
- Mission Control notifications, tasks, and My Day carry finance awareness and
  follow-up through existing cross-domain workflows. The deterministic routing,
  deduplication, settlement, and safe-action policy is defined in
  [`FINANCE-NOTIFICATION-ROUTING.md`](./FINANCE-NOTIFICATION-ROUTING.md).
- Houston remains the only assistant shell. Tyrion contributes permissioned
  finance tools; mutations require confirmation and write through to Monarch.

## Deep-link rather than duplicate

Mission Control must link to Monarch for full transaction review, categorization,
budgeting, recurring-transaction management, reporting, accounts, investments,
goals, and forecasting. It must link to the relevant document system for original
documents and specialist document operations.

Tyrion must not expand into:

- A comprehensive finance dashboard
- A generic transaction triage inbox
- A budget-management or reporting suite
- A generic bills calendar
- A second conversational assistant
- An independently deployed household-finance product application

## Terminology

Use these names in product copy and active documentation:

| Term | Meaning |
| --- | --- |
| **Tyrion** | The Mission Control household-finance domain and specialist |
| **Finance** | The functional Mission Control navigation label and route namespace |
| **Monarch** | The upstream financial system of record |
| **Monarch connector** | Mission Control's connector capability for Tyrion |
| **Monarch Bridge** | The service that mediates Monarch API access |
| **Tyrion operations/configuration UI** | The bounded `triage-app/` domain configuration, connector setup, validation, and UX-reference surface |

Existing identifiers such as `finance`, `finance-manager`, and `monarch-money` may
remain where compatibility requires them. Do not expose them as competing product
names. New external copy should use **Tyrion**, **Finance**, or **Monarch connector**
according to the meanings above.

## Change test

A proposed capability belongs in Tyrion only when it adds household-specific
automation, exception handling, reconciliation, or cross-domain action that
Monarch does not already provide. If Monarch already provides the complete
workflow, Mission Control should surface concise context and deep-link to it.

The analysis supporting this decision remains in
[`TYRION-UI-ARCHITECTURE-REVIEW.md`](./TYRION-UI-ARCHITECTURE-REVIEW.md).
