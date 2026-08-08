# Tyrion UI and Product Boundary Review

> **Decision input, not the active specification.** The accepted and authoritative
> product decision is [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md); delivery is
> tracked in [`ROADMAP.md`](./ROADMAP.md). Its later clarification assigns kid,
> attribution-rule, limit, policy, and connector configuration to Tyrion; any
> recommendation below that assigns this CRUD or persistence to Mission Control is
> superseded. Mission Control still owns attention, exception review, notifications,
> and actions.

**Reviewed:** August 7, 2026  
**Scope:** Historical Tyrion design documents, mockups, and prototype UI now preserved in this repository; the current Mission Control implementation reviewed in `rsocko/mission-control`; OWL/Document Intelligence precedent; and current Monarch capabilities.

> **Provenance:** The Tyrion artifacts discussed below originated in
> `rsocko/ideation/experiments/personal-automation/finance-management` and were later
> extracted into this repository. Tyrion artifact paths are now repository-relative.
> Mission Control implementation paths are external references relative to the
> `rsocko/mission-control` repository as it existed when this review was performed.

## Executive recommendation

Tyrion should be a **branded finance domain and specialist agent inside Mission Control**, not a separate general-purpose finance application.

Mission Control should own the daily attention and action surfaces:

- Household-finance exceptions
- Per-kid attribution and limits
- Cross-system reconciliation
- Alerts and weekly decision-oriented summaries
- Follow-up tasks
- Finance questions through Houston

Monarch should remain the system of record and full finance workspace for:

- Accounts and transactions
- Ordinary transaction review and categorization
- Budgets
- Recurring transactions
- Reports
- Net worth and investments
- Goals
- Forecasting
- Receipt scanning and ordinary receipt-to-transaction matching

If Tyrion eventually needs a separate UI, it should be a narrow administrative or diagnostic console, analogous to the specialist Document Hub behind OWL. It should not reproduce another dashboard, bills application, or chat shell.

## Why the existing artifacts appear contradictory

The historical Tyrion artifact set contains two distinct product directions.

### Original architecture: finance UI in Mission Control

[`docs/DESIGN.md`](./DESIGN.md) defines a hybrid architecture in which:

- `/finance`
- `/finance/triage`
- `/finance/kids`
- `/finance/bills`

are Mission Control routes that share Mission Control's application shell, authentication, database, and components. Only the Monarch Bridge and MCP server run separately.

The document is explicit about the rationale:

- Finance UI belongs in Mission Control to reuse the design system, auth, and layout.
- Finance alerts belong in Mission Control's unified notification system.
- Finance actions belong in its task system.
- Finance summaries belong in My Day.
- Finance tools belong in its AI assistant.

This is the clearest architectural statement and appears to be the original intended boundary.

### Later direction: Tyrion as a standalone product

Later historical artifacts describe Tyrion as the product a user opens:

- [`brand/PRODUCT.md`](../brand/PRODUCT.md) calls Tyrion both an agent and a UI.
- [`README.md`](../README.md) describes a loosely coupled Tyrion product identity.
- The [`mockups`](../mockups/) provide a complete application experience.
- [`triage-app`](../triage-app/) implements its own Dashboard, Triage, Kids, Bills, Ask, Settings, navigation, data-source controls, and branded shell.

This direction gives Tyrion a strong identity, but it expands the product into areas already served by Mission Control or Monarch.

### Conclusion

The standalone prototype is best understood as a useful UX and branding exploration, not proof that Tyrion needs its own deployed application. Its distinctive workflows can be carried into Mission Control without preserving its redundant shell.

## Current Mission Control fit

Mission Control is already the correct aggregation and action shell. It currently provides:

- Unified tasks and detail panels
- Notification inbox and provider-specific actions
- A general triage framework
- My Day
- Dashboard and KPI patterns
- Connector infrastructure
- Houston chat and tool registration
- Domain navigation, including Document Intelligence

Current desktop navigation includes a **Domains** section with `/doc-intelligence`, making `/finance` a natural peer route.

Mission Control does not yet expose a coherent finance product surface:

- No `/finance` page exists.
- No finance navigation item exists.
- Finance notification actions currently target a missing `/finance` route.
- There is no transaction, budget, bill, or kid-management UI.
- Houston can find finance notifications but cannot query finance data.
- Finance naming is inconsistent across `finance-manager`, `finance`, `monarch-money`, "Finance Manager," "Finance," and "Monarch Money."

### Finance capabilities already present in Mission Control

The Mission Control implementation reviewed for this analysis already contains substantial backend groundwork:

- Finance transaction storage
- Kid profiles and limits
- Card and merchant attribution rules
- Automatic kid attribution during sync
- Transaction filtering APIs
- Category and kid assignment APIs
- Summary and weekly-summary computation
- Threshold, budget, anomaly, and duplicate-subscription checks
- Finance notification provider

The largest gap is not a separate frontend application. It is the missing native finance domain UI and incomplete last-mile wiring.

## What Monarch already provides

The earlier Tyrion capability comparison understates Monarch's current product.

As of this review, Monarch provides:

- Connected accounts and transaction aggregation
- Machine-assisted categorization
- Custom categories and groups
- Transaction rules
- Transaction review workflows
- Bulk transaction editing
- Category and Flex budgeting
- Budget actual and remaining views
- Recurring transaction detection
- Reports for cash flow, spending, and income
- Net worth and investment tracking
- Goal planning and transaction linking
- Multiple-scenario forecasting
- Receipt scanning and transaction matching
- Receipt-derived notes and transaction splitting
- Account sync health and refresh progress

Consequently, Tyrion should not duplicate Monarch merely to give the data a different visual treatment.

## Capability-by-capability boundary

| Capability | Monarch | Mission Control | Tyrion recommendation |
| --- | --- | --- | --- |
| Accounts and balances | System of record and full UI | At most summary context | Do not duplicate |
| General transaction ledger | Full filtering and editing | Not needed | Deep-link to Monarch |
| Ordinary categorization | Categories, review, rules, bulk edits | Only actionable exceptions | Do not build a second generic review inbox |
| Budgets | Category and Flex budgeting | Alerts or compact status only | Do not build budget management |
| Reports | Cash flow, spending, income | Decision-oriented digest only | Do not reproduce charts and reports |
| Net worth and investments | Full native product | Not needed | Do not duplicate |
| Recurring transactions | Native detection and management | Surface actionable exceptions | Do not build a generic bills calendar |
| Forecasting | Multi-scenario forecasting | Optional alert or linked context | Drop Tyrion forecasting |
| Goals | Native planning and reconciliation | Optional related task | Drop Tyrion goal UI |
| Receipts | Scan, match, annotate, split | Cross-system failures only | Let Monarch handle ordinary receipts |
| Per-kid attribution | Not a first-class household model | Native domain workflow | Core Tyrion capability |
| Kid spending limits | Not the required household policy model | Alerts and configuration | Core Tyrion capability |
| Attribution ambiguity | Limited by generic transaction model | Exception review | Core Tyrion capability |
| Cross-system reconciliation | Does not own OWL/Paperless records | Unified action workflow | Core Tyrion capability |
| Weekly household digest | Finance reporting exists | Unified awareness and action | Tyrion should summarize decisions, not clone reports |
| Finance chat | Finance features are product-specific | Houston is the assistant shell | Add Tyrion tools to Houston |

## Tyrion's defensible product scope

Tyrion is most valuable as **household finance automation and exception management**, rather than as another personal finance manager.

### Core capabilities

1. **Per-kid attribution**
    - Identify which child a transaction belongs to.
    - Explain whether attribution came from a card, merchant rule, history, or manual decision.
    - Request review only when confidence is insufficient.

2. **Household spending policies**
    - Daily, weekly, or monthly per-kid limits.
    - Escalation when a threshold is reached or exceeded.
    - Clear distinction between informational status and an action requiring attention.

3. **Exception-only finance review**
    - Unknown kid ownership.
    - Conflicting rules.
    - Suspected duplicates or anomalies.
    - Failed categorization write-back.
    - Reconciliation failures.

4. **Cross-system reconciliation**
    - Match Monarch transactions to bills, statements, EOBs, and receipts available through OWL/Document Intelligence.
    - Surface missing, duplicate, late, or unmatched items.
    - Preserve links to the authoritative source systems.

5. **Unified alerts and follow-up**
    - Deliver Tyrion notifications through Mission Control.
    - Create normal Mission Control tasks when an issue requires follow-up.
    - Put only appropriate, scheduled work into My Day.

6. **Decision-oriented summaries**
    - Explain what changed, what needs attention, and why.
    - Link to Monarch for broad analysis.
    - Avoid recreating Monarch's report suite.

7. **Finance tools for Houston**
    - Read-only summaries, transaction search, kid totals, pending exceptions, and upcoming obligations.
    - Permissioned category and kid-assignment actions.
    - Clear confirmation for mutations.

## Recommended information architecture

Add **Tyrion / Finance** under Mission Control's Domains navigation as `/finance`.

### `/finance` — Overview

This should be an attention dashboard, not a comprehensive financial dashboard.

Show:

- Items requiring review
- Per-kid limit status
- Important upcoming obligations
- Recent Tyrion alerts
- Sync health
- Compact weekly household summary

Do not show:

- Net worth
- Investment performance
- Full budget tables
- General spending reports
- Full account balances
- A replacement transaction ledger

### `/finance/review` — Exceptions

Use Mission Control's established master-detail interaction pattern.

Include only:

- Ambiguous kid attribution
- Flagged anomalies
- Reconciliation mismatches
- Failed write-backs
- Other cases requiring human judgment

Ordinary Monarch transaction review should remain in Monarch.

### `/finance/kids` — Household attribution

Provide:

- Per-kid current totals and limits
- Recent attributed activity
- Card and merchant rules
- Confidence and explanation
- Correction and unassignment workflows

This is the clearest Tyrion-specific native UI.

### `/finance/reconciliation` — Cross-system matching

Provide:

- Expected versus posted obligations
- Monarch transaction links
- OWL/Paperless source-document links
- Match confidence
- Missing, duplicate, and unresolved states
- Audit history where necessary

This workflow should coordinate systems without trying to become the source of truth for either.

### `/finance/settings` — Policy and integration

Provide:

- Kid profiles
- Attribution rules
- Thresholds
- Alert policies
- Connector and sync health
- Links to advanced diagnostics if a separate console is eventually created

### Existing Mission Control surfaces

Reuse:

- `/notifications` for Tyrion alerts and digests
- Mission Control tasks for actionable follow-up
- `/today` for explicitly selected or scheduled finance work
- `/ai` for Houston conversations backed by Tyrion tools
- Connector settings for Monarch credentials and sync configuration

## OWL as the integration precedent

The current runtime uses the functional label **Document Intelligence**, even if OWL is the underlying product identity.

The implemented boundary is:

### Native in Mission Control

- Document action queue
- Triage entries
- Notifications
- Structured metadata
- Completion and defer actions

### Kept in specialist systems

- Original document browsing
- OCR and source detail
- Paperless workflows
- Document Hub administration
- Deep diagnostic or specialist views

This is the right precedent for Tyrion:

> Mission Control presents what requires awareness or action. The specialist systems retain deep domain exploration and administration.

For Tyrion, Monarch is the primary specialist product, while a future Tyrion admin console would exist only for automation-specific diagnostics that Monarch cannot provide.

## Branding implications

### Recommended hierarchy

1. **Mission Control** — application shell and navigation
2. **Tyrion** — finance domain and household-finance specialist
3. **Monarch** — upstream financial data source and management workspace

### Recommended labels

- Navigation: **Finance** or **Tyrion**
- Page title: **Tyrion · Household Finance**
- Notification source: **TYRION**
- Provenance: **via Monarch**
- Assistant phrasing: Houston may identify Tyrion as its finance specialist

The best navigation choice depends on whether discoverability or character branding is primary. A useful compromise is functional navigation labeled **Finance**, with Tyrion identity inside the page.

### Visual treatment inside Mission Control

Carry forward:

- Coin mark
- Restrained gold identity accent
- Selective serif display headings
- Tabular financial figures
- Dry, brief, family-safe voice

Keep Mission Control authoritative for:

- App shell
- Navigation
- Layout and spacing
- Component behavior
- Body typography
- Status colors
- Accessibility conventions

Gold should remain a brand color, not a warning or selection color. It should not override Mission Control semantics.

### Avoid

- A separate Tyrion sidebar and application shell
- A second general-purpose assistant
- Full charcoal, parchment, and gold reskinning of Mission Control
- Game of Thrones references that reduce clarity
- Presenting Monarch-sourced facts as though Tyrion owns the underlying data
- Multiple public names for the same connector or notification source

## Houston versus a separate Tyrion chat

Houston should remain the single conversational front door in Mission Control.

Tyrion should appear as:

- A finance tool provider
- A specialist capability
- A recognizable source of derived household insights

It should not add another general chat page. A separate "Ask Tyrion" experience would fragment assistant identity and duplicate Mission Control's established AI shell.

Houston needs finance-specific tools before this is useful:

- Get household finance summary
- Search transactions
- Get pending finance exceptions
- Get per-kid spending
- Get budget and recurring-obligation context
- Assign a transaction to a kid
- Update a transaction category

Read-only tools should come first. Mutating tools should require explicit confirmation and preserve Monarch as the source of truth.

## Disposition of the standalone prototype

### Preserve as design reference

- Transaction-card and focused-review interactions
- Kid chips and attribution cues
- Rule-suggestion concepts
- Tyrion identity assets
- Empty, loading, and error-state concepts
- Reconciliation mockup concepts

### Retire or freeze as product surfaces

- Generic finance dashboard
- Budget-versus-actual dashboard
- Generic bills calendar
- Cash-flow projection
- Separate finance chat
- Independent app navigation and settings shell

The prototype can remain valuable as a visual reference while no longer defining the deployment architecture.

## Recommended implementation sequence

1. **Establish the product boundary**
    - Adopt Tyrion as the Mission Control finance domain and specialist.
    - Record Monarch as the source of truth.
    - Stop expanding redundant standalone screens.

2. **Normalize identity**
    - Standardize `finance-manager`, `finance`, and `monarch-money` presentation.
    - Add a shared Tyrion icon and source label.
    - Use "via Monarch" for provenance.

3. **Create the native domain**
    - Add `/finance`.
    - Add desktop and mobile navigation.
    - Start with attention overview and exception review.

4. **Fix existing last-mile gaps**
    - Repair notification links targeting the missing route.
    - Start the finance notification scheduler.
    - Ensure scheduled checks persist notifications.
    - Materialize the weekly summary as a real digest.

5. **Build Tyrion-specific workflows**
    - Kid profile and rule management.
    - Attribution explanations and corrections.
    - Exception-only review.
    - Cross-system reconciliation.

6. **Extend Houston**
    - Add read-only finance tools.
    - Add carefully confirmed write actions.

7. **Deep-link instead of duplicating**
    - Link to Monarch for full transaction, budget, recurring, report, account, goal, and forecast workflows.
    - Link to OWL/Paperless for original documents and specialist document operations.

## Final product statement

**Tyrion is Mission Control's household-finance specialist.**

It observes Monarch, applies household-specific attribution and policies, reconciles money with documents, and brings exceptions and decisions into Mission Control. Monarch remains where finances are comprehensively managed; Mission Control remains where cross-domain work is prioritized and completed.

This preserves Tyrion's distinctive identity without creating a second-rate copy of Monarch or a second application shell beside Mission Control.

## Sources reviewed

### Historical Tyrion artifacts

These artifacts were reviewed in their original Ideation location and are now preserved
at the following paths in this repository:

- [`README.md`](../README.md)
- [`docs/DESIGN.md`](./DESIGN.md)
- [`docs/CROSS-SYSTEM-INTEGRATION.md`](./CROSS-SYSTEM-INTEGRATION.md)
- [`docs/MONARCH-BEST-PRACTICES.md`](./MONARCH-BEST-PRACTICES.md)
- [`docs/ROADMAP.md`](./ROADMAP.md)
- [`brand/PRODUCT.md`](../brand/PRODUCT.md)
- [`brand/DESIGN.md`](../brand/DESIGN.md)
- [`mockups/*.html`](../mockups/)
- [`triage-app/src/app/*`](../triage-app/src/app/)
- [`triage-app/src/components/layout/Sidebar.tsx`](../triage-app/src/components/layout/Sidebar.tsx)

### Mission Control implementation

Reviewed from the external `rsocko/mission-control` repository as it existed on August 7,
2026. These paths are relative to that repository, not to Tyrion:

- `src/components/layout/NavRail.tsx`
- `src/components/layout/MobileBottomNav.tsx`
- `src/components/layout/MobileDrawer.tsx`
- `src/app/page.tsx`
- `src/app/today/page.tsx`
- `src/app/notifications/page.tsx`
- `src/app/triage/page.tsx`
- `src/app/doc-intelligence/page.tsx`
- `src/app/ai/page.tsx`
- `src/app/api/ai/route.ts`
- `src/lib/ai/tools/index.ts`
- `src/lib/connectors/*`
- `src/lib/notifications/providers/*`
- `src/lib/finance-notifications/*`
- `src/db/finance-schema.ts`

### Monarch references

- [Monarch](https://www.monarch.com/)
- [Tracking](https://www.monarch.com/features/tracking)
- [Budgeting](https://www.monarch.com/features/budgeting)
- [Planning](https://www.monarch.com/features/planning)
- [Creating Your Budget in Monarch](https://help.monarch.com/hc/en-us/articles/360048883631-Creating-Your-Budget-in-Monarch)
- [Default Categories](https://help.monarch.com/hc/en-us/articles/360048883851-Default-Categories)
- [June 2026 Product Update](https://www.monarch.com/blog/june-product-update)

External capabilities reflect the publicly documented product as reviewed on August 7, 2026 and may change over time.
