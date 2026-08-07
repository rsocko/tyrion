# Personal Finance Management

Smart assistance to manage, track, and revise personal finances — integrated into Mission Control.

## Overview

A layered system combining:
- **Monarch Money** (source of truth for bank connections, transactions, categorization)
- **Monarch MCP Server** (AI-powered conversational finance queries)
- **Python Bridge Service** (deterministic sync, batch processing, threshold alerts)
- **Mission Control Integration** (unified dashboard, triage inbox, kid tracking, alerts)

## Directory Structure

```
finance-management/
├── docs/
│   ├── DESIGN.md              # Detailed architecture & data models
│   ├── MONARCH-BEST-PRACTICES.md  # Getting the most from Monarch
│   ├── KID-ATTRIBUTION.md    # How kid spending identification works
│   └── API-CONTRACTS.md      # Bridge service API specs
├── brand/
│   ├── DESIGN.md              # TYRION brand & design-system spec
│   ├── PRODUCT.md             # Product identity & positioning
│   ├── tyrion.css             # Shared design-system stylesheet (all mockups link this)
│   ├── brandkit.html          # Brand kit specimen (tokens, type, color, marks)
│   ├── logo-lab.html          # Logo/coin cuts across sizes & finishes
│   └── exploration/           # Naming rounds & identity exploration
├── mockups/
│   ├── dashboard.html         # Finance dashboard mockup
│   ├── triage-inbox.html      # Transaction triage inbox
│   ├── kid-spending.html      # Per-kid spending view
│   ├── bills-calendar.html    # Upcoming bills calendar
│   ├── ai-finance-chat.html   # AI finance chat interface
│   └── bill-reconciliation.html  # Bill/payment reconciliation
└── monarch-bridge/
    ├── README.md              # Bridge service setup & usage
    ├── requirements.txt       # Python dependencies
    ├── main.py               # FastAPI service entry point
    └── config.example.env    # Example configuration
```

## Key Features

1. **Per-Kid Spending Tracking** — Attribute charges to each of 3 kids via card/merchant rules
2. **Triage Inbox** — Quick approve/reassign/flag transactions one-by-one
3. **Threshold Alerts** — Notify when a kid's spending exceeds configurable limits
4. **AI Finance Chat** — Natural language queries powered by Monarch MCP
5. **Weekly Summaries** — Spending overview with category breakdowns
6. **Subscription Audit** — Surface duplicate/forgotten recurring charges
7. **Cash Flow Forecasting** — Project future balance based on patterns

## Brand &amp; Design System

The product identity is **TYRION** — a household finance agent + UI. All mockups share a
single design system:

- `brand/DESIGN.md` — visual spec: color tokens, typography, logo/coin cuts, motion, degradation rules
- `brand/tyrion.css` — the shared stylesheet every mockup links (`../brand/tyrion.css`)
- `brand/brandkit.html` / `brand/logo-lab.html` — interactive specimens
- `brand/exploration/` — naming rounds and identity rationale

TYRION is **loosely coupled** to Mission Control, OWL (Document Intelligence), and Monarch:
those appear only as neutral source tags/actions, never as a parent badge in TYRION's own chrome.

## Related Sessions

- `Task alert aggregation system` — Mission Control (the parent app this integrates into)
- `Paperless action queue review` — Receipt/statement matching potential integration
