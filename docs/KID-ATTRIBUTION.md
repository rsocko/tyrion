# Kid Attribution — How It Works

## Overview

Monarch does not expose physical-card or authorized-user identity. It identifies the
Monarch account associated with a transaction. Tyrion rules therefore mean: when
Monarch account A is used, attribute the transaction to household member X.

## Attribution Methods (Priority Order)

### 1. Manual Decisions and Specific Rules

Per-transaction manual decisions always win. Specific merchant rules are evaluated
next and can override every account default, including child and Parent/shared.

### 2. Account Defaults

Tyrion lists normalized Bridge accounts and stores each selected account's exact
Bridge Account DTO `id`. Operators choose one fallback:

- **Child** — definite attribution to one active child.
- **Parent/shared** — resolved parent/shared result with no attribution review.
- **Rule-based** — no account fallback; continue to history, then no-match review.

Account defaults are not ownership and do not prove which physical card or person
initiated a charge.

### 3. Shared Account + Merchant Rules

For charges on shared family accounts, merchant patterns identify the likely kid:

```
Merchant contains "ROBLOX" → Jake (confidence: definite)
Merchant contains "SEPHORA" → Emma (confidence: likely)
Merchant contains "STEAM" or "EPIC GAMES" → Jake (confidence: likely)
Merchant contains "SCHOOL LUNCH - WESTVIEW" → Sophie (confidence: definite)
```

- `definite` = auto-assigned, no triage needed
- `likely` = auto-assigned but queued for quick confirmation in triage

### 4. Historical Pattern Matching (ML-Lite)

After 30+ transactions, the system learns patterns:

```
If merchant "CHICK-FIL-A" has been assigned to Jake 8/10 times:
  → Suggest Jake (confidence: likely)
  → Queue for confirmation
```

This kicks in only after enough data and never auto-assigns with "definite" confidence.

### 5. Unassigned (Triage Required)

Any transaction that doesn't match rules or patterns:
- Shows up in the triage inbox
- User picks: assign to kid, confirm as parent expense, or flag

---

## Setting Up Kid Profiles

### In Tyrion configuration: Kids and policy

Tyrion owns the durable profile, rule, limit, and policy version. Mission Control
shows resulting status and review actions, and links to this configuration surface.
For each child, configure:

```yaml
Kid: Jake
  Color: blue
  Accounts:
    - Jake checking account reference (definite)
  Merchants:
    - "ROBLOX" (definite)
    - "STEAM" (definite)
    - "EPIC GAMES" (definite)
    - "GAMESTOP" (likely)
    - "FIVE BELOW" (likely)
  Thresholds:
    Daily: $30
    Weekly: $100
    Monthly: $300

Kid: Emma
  Color: purple
  Accounts:
    - Emma spending account reference (definite)
  Merchants:
    - "SEPHORA" (likely)
    - "ULTA" (likely)
    - "SHEIN" (likely)
    - "STARBUCKS" (likely)  # she goes daily
  Thresholds:
    Daily: $25
    Weekly: $80
    Monthly: $250

Kid: Sophie
  Color: green
  Accounts: (none - uses shared parent accounts)
  Merchants:
    - "SCHOOL LUNCH - WESTVIEW" (definite)
    - "SCHOLASTIC" (definite)
    - "CLAIRE'S" (likely)
  Thresholds:
    Daily: $15
    Weekly: $50
    Monthly: $150
```

---

## How Thresholds Work

### Check Frequency
The alert engine runs every 15 minutes and computes rolling totals:

- **Daily**: Resets at midnight local time
- **Weekly**: Monday through Sunday
- **Monthly**: Calendar month

### Alert Escalation

| Condition | Alert Severity | Example |
|-----------|---------------|---------|
| 80% of limit | low (heads-up) | "Jake at $80/$100 weekly limit" |
| 100% of limit | medium | "Jake exceeded $100 weekly limit ($112 spent)" |
| 150% of limit | high | "Jake significantly over limit: $150/$100 weekly" |

### Where Alerts Appear
1. **Mission Control Alert Feed** — alongside all other alerts
2. **Finance Dashboard** — kid cards show red/yellow when approaching/exceeding
3. **Optional**: Email digest (configurable per kid)

---

## Triage Workflow

When transactions need human review:

```
┌─────────────────────────────────────────┐
│  🏷️  CHICK-FIL-A - $14.32              │
│  Chase Sapphire ...9876  •  Jun 18      │
│                                         │
│  Suggested: Jake (pattern: 8/10 times)  │
│                                         │
│  [✓ Jake] [Emma] [Sophie] [Mine] [Flag] │
└─────────────────────────────────────────┘
```

Actions:
- **Assign to kid** → Updates attribution + adds to kid's spending total
- **Mine** → Marks as parent expense, removes from kid tracking
- **Unassign** → Records an explicit manual unassignment
- **Resolve** → Confirms the current suggested kid
- **Defer** → Keeps the exception open for review at a bounded future time
- **Open in Monarch** → Deep-links ordinary transaction editing to the system of record

---

## Improving Rules Over Time

The system suggests new rules based on your triage decisions:

```
"You've assigned CHIPOTLE to Jake 5 times this month. 
 Create a merchant rule? [Yes - definite] [Yes - likely] [No]"
```

This feedback loop means the triage inbox gets smaller over time as rules get more comprehensive.
