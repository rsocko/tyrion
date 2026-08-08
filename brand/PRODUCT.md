# Product Identity — Tyrion

> Product-boundary authority lives in
> [`docs/PRODUCT-BOUNDARY.md`](../docs/PRODUCT-BOUNDARY.md). This document defines
> Tyrion's identity within that boundary; visual decisions live in `DESIGN.md`.

## What it is

Tyrion is Mission Control's household-finance domain and specialist. It is the
recognizable voice behind household-specific finance automation, not a separate
application or assistant shell.

Mission Control is the product users open and Houston is the assistant they ask.
Tyrion supplies finance context, tools, exceptions, and actions. Monarch remains
the financial system of record and comprehensive finance workspace.

## Who it is for

One household. Personal use and open-source at most, never a commercial finance
product. The character reference remains light, family-safe seasoning rather than
product structure.

## Jobs to be done

- **Observe** — synchronize Monarch context and connector health.
- **Explain** — attribute kid spending and show why a rule or policy fired.
- **Reconcile** — connect transactions with obligations and source documents.
- **Escalate** — send actionable exceptions, alerts, tasks, and summaries through
  Mission Control.
- **Assist** — provide permissioned finance tools to Houston.

## Systems it connects to

- **Monarch** — source of truth for accounts, transactions, categorization,
  budgets, recurring activity, and reports.
- **Mission Control** — navigation, attention, tasks, notifications, My Day, and
  Houston.
- **OWL / Document Intelligence** — source documents and specialist document
  operations used in reconciliation.
- **Monarch Bridge** — normalized access, synchronization, health, and write-back.

## Surface model

- Mission Control uses Tyrion identity within the native Finance domain.
- Monarch receives deep links for comprehensive finance workflows.
- `triage-app/` and the mockups remain a debug, validation, and UX-reference
  surface, not a standalone product.
- Houston remains the sole conversational front door.

## Non-negotiables

- **Family-safe.** Character voice stays dry, brief, and PG.
- **Source-honest.** Monarch-sourced facts are labeled `via Monarch`.
- **Exception-oriented.** Tyrion adds household decisions, not duplicate reports.
- **Mission Control-native.** Shared shell, navigation, accessibility, and
  interaction patterns remain authoritative.
- **Status colors are sacred.** Red, amber, green, and blue mean status only.
- **Gold is identity, not status.** Use it sparingly and never as warning semantics.
