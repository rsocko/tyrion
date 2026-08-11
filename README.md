# Tyrion

Tyrion is Mission Control's household-finance domain and specialist. It observes
Monarch, applies household-specific attribution and policies, reconciles money
with documents, and brings exceptions and decisions into Mission Control.

**Monarch is the financial system of record. Mission Control is the user-facing
action, awareness, and assistant shell.**

The authoritative architecture decision is
[`docs/PRODUCT-BOUNDARY.md`](docs/PRODUCT-BOUNDARY.md), and delivery is tracked in
[`docs/ROADMAP.md`](docs/ROADMAP.md). Repository examples and fixtures are governed
by the [`synthetic-data and public-disclosure certification`](docs/SYNTHETIC-DATA-CERTIFICATION.md).

Tyrion is an independent project and is not affiliated with, endorsed by,
sponsored by, or supported by Monarch Money, Inc. The connector uses an
unofficial community client against a private upstream interface. Review the
documented [terms risk and dated owner acceptance](docs/LICENSING-AND-PROVENANCE.md#monarch-terms-and-affiliation).
Live mode remains opt-in for personal, non-commercial use; the client license
does not authorize access to Monarch's service.

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
| `finance-insights/` | Tyrion-private insight detection, lifecycle persistence, and permissioned Houston finance inquiry tools |
| `kid-engine/` | Private Tyrion-internal household policy, attribution, review, and re-attribution logic |
| `docs/` | Active boundary, roadmap, contracts, and historical design references |
| `triage-app/` | Bounded Tyrion domain configuration, Monarch connector operations, and contract-validation console |
| `mockups/` | UX and visual references; not deployment architecture |
| `brand/` | Tyrion identity assets adapted within Mission Control's design system |

Production may deploy Tyrion-owned kid, rule, limit, policy, and connector
configuration alongside connector reachability, authentication, logout, and bounded
sync/recheck in `triage-app/`. It must not grow into an independent ledger,
dashboard, generic transaction review product, reporting suite, bills application,
or assistant shell.

## Terminology

- **Tyrion** — Mission Control's household-finance domain and specialist
- **Finance** — functional navigation label and `/finance` route namespace
- **Monarch** — upstream financial system of record
- **Monarch connector** — Mission Control connector capability
- **Monarch Bridge** — service mediating Monarch API access

Legacy identifiers such as `finance`, `finance-manager`, and `monarch-money` may
remain for compatibility but are not separate product names.

## Origin and provenance

Tyrion was extracted from a private predecessor experiment. The public repository
does not link to that repository's internal paths, revisions, issues, or pull
requests. Stabilization of the extracted baseline is recorded in
[`rsocko/tyrion#5`](https://github.com/rsocko/tyrion/pull/5).

## License

Original Tyrion content is available under the [MIT License](LICENSE).
Dependencies, hosted fonts, base images, and third-party names retain their own
terms; see [third-party notices](THIRD-PARTY-NOTICES.md) and the
[licensing and provenance review](docs/LICENSING-AND-PROVENANCE.md).
