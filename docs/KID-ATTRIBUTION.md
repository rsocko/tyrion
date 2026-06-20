# Kid Attribution — How It Works

## Overview

Monarch Money doesn't know *who* made a purchase — only which account/card was used. Our kid attribution engine uses rules to automatically assign transactions to the correct child.

## Attribution Methods (Priority Order)

### 1. Card Rules (Highest Confidence)

If a kid has their own debit card or a dedicated credit card:

```
Card Last-4: 4521 → Jake (confidence: definite)
Card Last-4: 7890 → Emma (confidence: definite)
```

Transactions on these cards are **automatically assigned** with no triage needed.

### 2. Shared Card + Merchant Rules

For charges on shared family cards, merchant patterns identify the likely kid:

```
Merchant contains "ROBLOX" → Jake (confidence: definite)
Merchant contains "SEPHORA" → Emma (confidence: likely)
Merchant contains "STEAM" or "EPIC GAMES" → Jake (confidence: likely)
Merchant contains "SCHOOL LUNCH - WESTVIEW" → Sophie (confidence: definite)
```

- `definite` = auto-assigned, no triage needed
- `likely` = auto-assigned but queued for quick confirmation in triage

### 3. Historical Pattern Matching (ML-Lite)

After 30+ transactions, the system learns patterns:

```
If merchant "CHICK-FIL-A" has been assigned to Jake 8/10 times:
  → Suggest Jake (confidence: likely)
  → Queue for confirmation
```

This kicks in only after enough data and never auto-assigns with "definite" confidence.

### 4. Unassigned (Triage Required)

Any transaction that doesn't match rules or patterns:
- Shows up in the triage inbox
- User picks: assign to kid, confirm as parent expense, or flag

---

## Setting Up Kid Profiles

### In Mission Control: Settings → Finance → Kids

For each child, configure:

```yaml
Kid: Jake
  Color: blue
  Cards:
    - Chase Debit ...4521 (definite - his own card)
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
  Cards:
    - Amex ...7890 (definite - her authorized user card)
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
  Cards: (none - uses parent cards)
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
- **Flag** → Marks for discussion (creates a task: "Talk to Jake about $14 Chick-fil-A")

---

## Improving Rules Over Time

The system suggests new rules based on your triage decisions:

```
"You've assigned CHIPOTLE to Jake 5 times this month. 
 Create a merchant rule? [Yes - definite] [Yes - likely] [No]"
```

This feedback loop means the triage inbox gets smaller over time as rules get more comprehensive.
