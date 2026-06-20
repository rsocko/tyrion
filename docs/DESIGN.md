# Finance Management — Design Document

## 1. Integration Architecture: Hybrid Approach

The finance module uses a **hybrid** integration with Mission Control:

### What lives IN Mission Control (as new pages/routes):
- `/finance` — Dashboard with spending overview, per-kid breakdown
- `/finance/triage` — Transaction triage inbox
- `/finance/kids` — Per-kid spending detail views
- `/finance/bills` — Upcoming bills calendar
- Shared SQLite database (new finance tables alongside existing task/alert tables)
- Shared UI components (shadcn/ui, Tailwind)

### What runs as a SEPARATE service:
- **Monarch Bridge** (FastAPI Python) — handles Monarch API communication, scheduled sync
- **MCP Server** (`monarch-money-mcp-enhanced`) — powers AI chat queries

### What FEEDS INTO Mission Control's existing systems:
- **Alerts**: "Jake exceeded $50 daily limit" → appears in MC's unified alert feed
- **Tasks**: "Review 15 uncategorized transactions" → appears as an actionable task in MC's task list
- **My Day**: Weekly spending summary → shows in the Today/My Day view
- **AI Assistant**: Monarch MCP tools available in MC's `/ai` chat page

```
┌─────────────────────────── MISSION CONTROL ───────────────────────────────┐
│                                                                            │
│  EXISTING SYSTEMS          │  NEW FINANCE PAGES                           │
│  ┌──────────────────┐      │  ┌──────────────────────────────────────┐   │
│  │ Unified Task List │◄────────│  "Review 15 uncategorized txns"      │   │
│  │ Alert Feed        │◄────────│  "Jake exceeded weekly limit"        │   │
│  │ My Day / Today    │◄────────│  "Weekly spending: $2,340 (-12%)"    │   │
│  │ AI Assistant      │◄────────│  Monarch MCP tools (chat w/ finances)│   │
│  └──────────────────┘      │  └──────────────────────────────────────┘   │
│                             │  ┌──────────────────────────────────────┐   │
│                             │  │ /finance        — Dashboard          │   │
│                             │  │ /finance/triage — Triage Inbox       │   │
│                             │  │ /finance/kids   — Per-Kid Views      │   │
│                             │  │ /finance/bills  — Bills Calendar     │   │
│                             │  └──────────────────┬───────────────────┘   │
└────────────────────────────────────────────────────┼──────────────────────┘
                                                     │
                              ┌───────────────────────┼───────────────────┐
                              │                       │                   │
                    ┌─────────▼──────┐     ┌─────────▼──────┐            │
                    │ Monarch Bridge │     │  MCP Server    │            │
                    │  (FastAPI)     │     │  (enhanced)    │            │
                    │  Port 8100     │     │  stdio/SSE     │            │
                    └───────┬────────┘     └───────┬────────┘            │
                            └──────────┬───────────┘                     │
                                       │                                 │
                             ┌─────────▼─────────┐                       │
                             │   MONARCH MONEY   │                       │
                             │  (GraphQL API)    │                       │
                             └───────────────────┘                       │
                                                                         │
                    ┌─────────────────────────────────────┐              │
                    │ Alert Engine (node-cron in MC)       │──────────────┘
                    │ - Threshold checks every 15 min     │
                    │ - Weekly summary generation          │
                    │ - Subscription audit (monthly)       │
                    └─────────────────────────────────────┘
```

### Why Hybrid?
| Concern | Decision | Rationale |
|---------|----------|-----------|
| Finance UI | IN Mission Control | Reuses existing design system, auth, layout; one app to run |
| Alerts | FEED into MC alert system | Appears alongside GitHub, Outlook, etc. — unified awareness |
| Tasks | FEED into MC task system | "Review transactions" is actionable just like any other task |
| Monarch API access | SEPARATE service | Python ecosystem is mature; isolates auth/session concerns |
| AI queries | MCP Server (separate) | Standard protocol; plugs into MC's existing AI layer |

## 2. Data Models

### 2.1 Transactions (synced from Monarch)

```typescript
interface FinanceTransaction {
  id: string;                    // Monarch transaction ID
  date: string;                  // ISO date
  amount: number;                // Negative = expense, positive = income
  merchantName: string;
  originalCategory: string;      // Monarch's auto-assigned category
  confirmedCategory?: string;    // User-confirmed category (after triage)
  accountId: string;
  accountName: string;
  cardLast4?: string;            // Last 4 digits of card used

  // Kid attribution
  assignedKidId?: string;
  kidAssignmentMethod: 'auto_card' | 'auto_merchant' | 'manual' | 'unassigned';

  // Triage status
  triageStatus: 'pending' | 'confirmed' | 'reassigned' | 'flagged';
  flagReason?: string;

  // Metadata
  isRecurring: boolean;
  notes?: string;
  tags: string[];
  syncedAt: string;
}
```

### 2.2 Kid Profiles

```typescript
interface KidProfile {
  id: string;
  name: string;
  color: string;                 // For UI charts
  avatar?: string;

  // Attribution rules
  cardRules: CardRule[];
  merchantRules: MerchantRule[];

  // Thresholds
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;

  // Stats (computed)
  currentMonthSpend: number;
  currentWeekSpend: number;
}

interface CardRule {
  cardLast4: string;
  accountId: string;
  confidence: 'definite' | 'likely';  // definite = kid's own card
}

interface MerchantRule {
  merchantPattern: string;       // regex or substring match
  kidId: string;
  confidence: 'definite' | 'likely';
}
```

### 2.3 Alert Configuration

```typescript
interface FinanceAlertConfig {
  id: string;
  type: 'kid_threshold' | 'anomaly' | 'subscription_duplicate' | 'budget_exceeded' | 'bill_upcoming';

  // For kid_threshold
  kidId?: string;
  period: 'daily' | 'weekly' | 'monthly';
  thresholdAmount: number;

  // For anomaly
  zScoreThreshold?: number;      // How many std devs to flag

  // General
  enabled: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
  notifyVia: ('mission_control' | 'email' | 'push')[];
}
```

### 2.4 Drizzle Schema (SQLite)

```typescript
// New tables added to Mission Control's existing schema

export const financeTransactions = sqliteTable('finance_transactions', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  amount: real('amount').notNull(),
  merchantName: text('merchant_name').notNull(),
  originalCategory: text('original_category'),
  confirmedCategory: text('confirmed_category'),
  accountId: text('account_id').notNull(),
  accountName: text('account_name'),
  cardLast4: text('card_last4'),
  assignedKidId: text('assigned_kid_id').references(() => kidProfiles.id),
  kidAssignmentMethod: text('kid_assignment_method').default('unassigned'),
  triageStatus: text('triage_status').default('pending'),
  flagReason: text('flag_reason'),
  isRecurring: integer('is_recurring', { mode: 'boolean' }).default(false),
  notes: text('notes'),
  tags: text('tags', { mode: 'json' }),
  syncedAt: text('synced_at').notNull(),
  monarchUpdatedAt: text('monarch_updated_at'),
});

export const kidProfiles = sqliteTable('kid_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  avatar: text('avatar'),
  dailyLimit: real('daily_limit'),
  weeklyLimit: real('weekly_limit'),
  monthlyLimit: real('monthly_limit'),
  createdAt: text('created_at').notNull(),
});

export const kidCardRules = sqliteTable('kid_card_rules', {
  id: text('id').primaryKey(),
  kidId: text('kid_id').references(() => kidProfiles.id).notNull(),
  cardLast4: text('card_last4').notNull(),
  accountId: text('account_id').notNull(),
  confidence: text('confidence').default('likely'),
});

export const kidMerchantRules = sqliteTable('kid_merchant_rules', {
  id: text('id').primaryKey(),
  kidId: text('kid_id').references(() => kidProfiles.id).notNull(),
  merchantPattern: text('merchant_pattern').notNull(),
  confidence: text('confidence').default('likely'),
});

export const financeAlertConfigs = sqliteTable('finance_alert_configs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  kidId: text('kid_id').references(() => kidProfiles.id),
  period: text('period'),
  thresholdAmount: real('threshold_amount'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  severity: text('severity').default('medium'),
  notifyVia: text('notify_via', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
});
```

## 3. Monarch Bridge Service API

### Base URL: `http://localhost:8100`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/transactions` | Fetch transactions (query params: start_date, end_date, account_id, category) |
| GET | `/transactions/:id` | Single transaction details |
| PATCH | `/transactions/:id/category` | Update category (writes back to Monarch) |
| GET | `/categories` | List all categories |
| GET | `/accounts` | List connected accounts |
| GET | `/recurring` | List recurring transactions |
| GET | `/cashflow` | Cash flow summary (income vs expenses) |
| GET | `/budgets` | Budget status per category |

### Authentication Flow
```
1. First run: interactive login (email + password + optional MFA)
2. Session token cached locally (~/.monarch_session)
3. Bridge auto-refreshes session on expiry
4. MCP server uses same session for AI queries
```

## 4. Connector Interface Implementation

```typescript
// lib/connectors/monarch-money/index.ts

import { IConnector, ConnectorConfig, SyncResult } from '@/types';

export class MonarchConnector implements IConnector {
  type = 'monarch-money';
  
  capabilities = {
    read: true,
    write: true,        // category reassignment
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,        // accounts as "lists"
    tags: true,         // categories as tags
    tagWriteBack: true, // write category changes back
  };

  async sync(config: ConnectorConfig): Promise<SyncResult> {
    // 1. Fetch transactions from bridge since last sync
    // 2. Apply kid attribution rules
    // 3. Upsert into financeTransactions table
    // 4. Check thresholds, generate alerts if exceeded
    // 5. Return sync stats
  }

  async writeBack(transactionId: string, updates: Partial<FinanceTransaction>): Promise<void> {
    // PATCH to bridge → bridge writes to Monarch
  }
}
```

## 5. Kid Attribution Algorithm

```
For each new transaction:
  1. Check cardLast4 against kidCardRules
     → If definite match: assign kid, method = 'auto_card'
     → If likely match: assign kid, method = 'auto_card', queue for triage

  2. Check merchantName against kidMerchantRules
     → If definite match: assign kid, method = 'auto_merchant'
     → If likely match: suggest kid, queue for triage

  3. If no rules match:
     → Check ML suggestion (if merchant appears 3+ times for same kid historically)
     → Otherwise: triageStatus = 'pending', kidAssignmentMethod = 'unassigned'
```

## 6. Alert Engine

Runs on `node-cron` schedule (every 15 minutes):

```typescript
async function checkThresholds() {
  const kids = await db.select().from(kidProfiles);
  
  for (const kid of kids) {
    const todaySpend = await getKidSpend(kid.id, 'today');
    const weekSpend = await getKidSpend(kid.id, 'this_week');
    const monthSpend = await getKidSpend(kid.id, 'this_month');
    
    if (kid.dailyLimit && todaySpend > kid.dailyLimit) {
      await createAlert({
        type: 'kid_threshold',
        title: `${kid.name} exceeded daily limit`,
        body: `$${todaySpend.toFixed(2)} spent today (limit: $${kid.dailyLimit})`,
        severity: todaySpend > kid.dailyLimit * 1.5 ? 'high' : 'medium',
      });
    }
    // Similar for weekly/monthly...
  }
}
```

## 7. MCP Integration for AI Chat

Configure in Mission Control's AI provider layer:

```typescript
// lib/ai/monarch-mcp.ts
export const monarchMcpConfig = {
  server: 'monarch-money-mcp-enhanced',
  transport: 'stdio',  // or SSE for remote
  auth: {
    email: process.env.MONARCH_EMAIL,
    password: process.env.MONARCH_PASSWORD,
  },
  tools: [
    'get_transactions',
    'get_cashflow',
    'get_budgets',
    'get_accounts',
    'update_transaction_category',
    'get_recurring_transactions',
  ],
};
```

Example queries the AI can handle:
- "What did Jake spend this week?"
- "Show me all uncategorized transactions over $50"
- "How's my grocery budget looking?"
- "What subscriptions am I paying for?"
- "Move that DoorDash charge to dining out"

## 8. Sync Schedule

| Job | Frequency | Purpose |
|-----|-----------|---------|
| Full transaction sync | Every 4 hours | Pull new transactions from Monarch |
| Threshold check | Every 15 minutes | Check kid spending against limits |
| Weekly summary generation | Sunday 8 AM | Create weekly spending report |
| Subscription audit | Monthly (1st) | Flag duplicate/forgotten subscriptions |
| Cash flow forecast | Daily 6 AM | Update balance projection |
