# Tyrion

Tyrion is Mission Control's household-finance domain and specialist. It observes
Monarch, applies household-specific attribution and policies, reconciles money
with documents, and brings exceptions and decisions into Mission Control.

**Monarch is the financial system of record. Mission Control is the user-facing
action, awareness, and assistant shell.**

The authoritative architecture decision is
[`docs/PRODUCT-BOUNDARY.md`](docs/PRODUCT-BOUNDARY.md), and delivery is tracked in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Product scope

Tyrion owns:

- Per-kid transaction attribution and spending policies
- Ambiguity, anomaly, reconciliation, and write-back exceptions
- Decision-oriented household summaries
- Finance notifications and follow-up tasks in Mission Control
- Permissioned finance tools for Houston
- Cross-system reconciliation with OWL/Document Intelligence

Tyrion does not replace Monarch's transaction ledger, categorization, budgets,
recurring management, reports, goals, forecasts, investments, or ordinary receipt
matching. Those workflows should deep-link to Monarch.

## Repository layout

| Path | Role |
| --- | --- |
| `monarch-bridge/` | Monarch authentication, normalized API access, synchronization, and write-back |
| `kid-engine/` | Household attribution, policy, and suggestion logic |
| `docs/` | Active boundary, roadmap, contracts, and historical design references |
| `triage-app/` | Bounded Monarch connector operations and contract-validation console |
| `mockups/` | UX and visual references; not deployment architecture |
| `brand/` | Tyrion identity assets adapted within Mission Control's design system |

Production deploys only the connector reachability, authentication, logout, and
bounded sync/recheck surface from `triage-app/`. It must not grow into an independent
dashboard, generic transaction review product, bills application, or assistant shell.

## Terminology

- **Tyrion** — Mission Control's household-finance domain and specialist
- **Finance** — functional navigation label and `/finance` route namespace
- **Monarch** — upstream financial system of record
- **Monarch connector** — Mission Control connector capability
- **Monarch Bridge** — service mediating Monarch API access

Legacy identifiers such as `finance`, `finance-manager`, and `monarch-money` may
remain for compatibility but are not separate product names.

## Origin and provenance

Tyrion was extracted from the private
[`rsocko/ideation/experiments/personal-automation/finance-management`](https://github.com/rsocko/ideation/tree/27147420c236f0c50582ee39fee02a4a446bd218/experiments/personal-automation/finance-management)
experiment at source cut `27147420c236f0c50582ee39fee02a4a446bd218`. The
baseline includes branding work from
[`rsocko/ideation#1117`](https://github.com/rsocko/ideation/pull/1117), migration
tracking in
[`rsocko/ideation#1119`](https://github.com/rsocko/ideation/issues/1119), and
stabilization in
[`rsocko/tyrion#5`](https://github.com/rsocko/tyrion/pull/5).
