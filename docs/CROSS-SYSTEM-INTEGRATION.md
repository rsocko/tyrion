# Cross-System Integration: Finance × Paperless × Mission Control

> **Historical design reference — implementation plan superseded.** Use
> [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md) for system ownership and
> [`ROADMAP.md`](./ROADMAP.md) for active reconciliation delivery. The matching
> concepts below remain useful, but any UI belongs in Mission Control, source
> records remain in Monarch and OWL/Document Intelligence, and the standalone
> prototype is only a debug and UX-reference surface.

## Overview

This document describes how the **Personal Finance Management** system integrates with:
1. **Statement Tracking** — Identifies recurring statements in Paperless-ngx and detects missing ones
2. **Paperless Action Queue** — Surfaces actionable documents (bills to pay, forms to respond to)
3. **Medical EOB & Bill Matching** — Links EOBs to bills, tracks payment status, prevents double-payment
4. **Mission Control** — Unified task/alert hub that ties everything together

The key insight: **Paperless tells you what you OWE; Monarch tells you what you PAID.** Connecting them gives you confidence that every bill is paid, on time, exactly once.

---

## Integration Architecture

```
┌─────────────────────────── MISSION CONTROL ───────────────────────────────┐
│                                                                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐    │
│  │ Task List   │  │ Alert Feed  │  │ Finance UI  │  │ AI Assistant │    │
│  │             │  │             │  │             │  │              │    │
│  │ "Pay PSE&G" │  │ "Bill due   │  │ Dashboard   │  │ "Was my      │    │
│  │ "Review EOB"│  │  in 3 days" │  │ Triage      │  │  electric    │    │
│  │             │  │ "Duplicate  │  │ Kid Spend   │  │  bill paid?" │    │
│  │             │  │  bill found"│  │             │  │              │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘    │
│         │                │                │                 │            │
│  ┌──────┴────────────────┴────────────────┴─────────────────┴──────────┐ │
│  │                    Unified Data Layer (SQLite/Drizzle)                │ │
│  │  tasks | alerts | finance_txns | bills | eobs | matches | statements │ │
│  └───────────────────────────┬──────────────────────────────────────────┘ │
└──────────────────────────────┼────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
┌─────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────────┐
│ Monarch Bridge   │ │ Paperless-ngx   │ │ Matching Engine      │
│ (transactions)   │ │ (documents)     │ │ (correlation)        │
│                  │ │                 │ │                      │
│ • What you PAID  │ │ • What you OWE  │ │ • Bill ↔ Transaction │
│ • When you paid  │ │ • Due dates     │ │ • EOB ↔ Bill         │
│ • Categories     │ │ • Amounts       │ │ • Statement ↔ Period │
│ • Recurring      │ │ • Vendors       │ │ • Confidence scores  │
└─────────┬────────┘ └────────┬────────┘ └────────┬────────────┘
          │                    │                    │
          ▼                    ▼                    │
   Monarch Money         Paperless-ngx             │
   (bank/card data)      (scanned docs)     ◄──────┘
```

---

## Integration Point 1: Bill-to-Transaction Matching

### The Problem
You have a bill in Paperless (extracted: amount=$185, due=Jun 22, vendor="PSE&G"). Did you pay it? When? Monarch has the transaction. But today you'd have to manually cross-check.

### The Solution

```
Paperless Bill                    Monarch Transaction
─────────────                    ───────────────────
Vendor: PSE&G                    Merchant: PSEG PAYMENT
Amount Due: $185.00              Amount: -$185.00
Due Date: Jun 22, 2026           Date: Jun 20, 2026
Account #: 12-345-6789           Card: Checking ...2341
                                 Category: Utilities
         │                              │
         └──────────┬───────────────────┘
                    │
           ┌────────▼────────┐
           │ MATCH ENGINE    │
           │                 │
           │ Vendor: 92%     │  (PSE&G ↔ PSEG PAYMENT)
           │ Amount: 100%    │  ($185.00 = $185.00)
           │ Date: in window │  (paid 2 days before due)
           │                 │
           │ Confidence: HIGH│
           │ Status: ✅ PAID │
           └─────────────────┘
```

### Matching Algorithm

```typescript
interface BillMatch {
  billId: string;           // Paperless document ID
  transactionId: string;    // Monarch transaction ID
  confidence: 'high' | 'medium' | 'low';
  matchFactors: {
    vendorSimilarity: number;    // 0-1 (fuzzy string match)
    amountMatch: 'exact' | 'close' | 'different';
    dateProximity: number;       // days between due date and payment
    accountMatch: boolean;       // same payment account?
  };
  status: 'paid' | 'likely_paid' | 'unpaid' | 'overdue' | 'needs_review';
}
```

**Matching Logic:**
1. For each bill in Paperless with extracted `amount` + `vendor`:
   - Search Monarch transactions ±30 days of bill due date
   - Filter by amount (exact match, or within 5% for partial/rounded payments)
   - Score vendor name similarity (fuzzy match: "PSE&G" ↔ "PSEG PAYMENT")
   - Score account match (same payment source expected?)
2. Assign confidence:
   - **HIGH**: Vendor ≥85% match AND amount exact AND date ≤ due date
   - **MEDIUM**: Vendor ≥70% OR amount exact with reasonable date
   - **LOW**: Partial matches needing human review
3. Mark status:
   - `paid` (high confidence match found, paid on/before due)
   - `likely_paid` (medium confidence, suggest confirmation)
   - `unpaid` (no match found, before due date)
   - `overdue` (no match found, past due date)

### "Show Matches" UI

When confidence isn't HIGH, show the user candidate matches:

```
┌───────────────────────────────────────────────────────────────────┐
│  📄 PSE&G Electric Bill                                           │
│  Amount Due: $185.00  •  Due: Jun 22, 2026                       │
│  Status: ⚡ LIKELY PAID (medium confidence)                       │
│                                                                   │
│  ─── Candidate Matches ──────────────────────────────────────── │
│                                                                   │
│  ✅ Best Match (87% confidence)                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ PSEG PAYMENT     -$185.00    Jun 20    Checking ...2341     │ │
│  │ Vendor: 92% • Amount: exact • 2 days before due             │ │
│  │                              [✓ Confirm Match]  [✗ Not This] │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Other possible matches:                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ PSEG BUDGET BILL  -$185.00    Jun 18    Checking ...2341    │ │
│  │ Vendor: 88% • Amount: exact • 4 days before due             │ │
│  │                              [✓ This One]       [✗ No]       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  [Mark as Unpaid]  [Link Different Transaction]  [Dismiss]        │
└───────────────────────────────────────────────────────────────────┘
```

---

## Integration Point 2: Paperless Action Queue → Mission Control → Finance

### Flow: Bill Arrives → Action Created → Payment Tracked

```
1. Bill uploaded to Paperless-ngx (scan or email import)
                    │
                    ▼
2. Paperless Action Queue Agent processes document:
   - Classifies as: BILL / PAY
   - Extracts: vendor, amount, due date, account number
   - Creates action recommendation: "Pay PSE&G $185 by Jun 22"
                    │
                    ▼
3. Action Queue surfaces in Mission Control as a TASK:
   - Task: "Pay PSE&G Electric — $185 due Jun 22"
   - Priority: based on days until due
   - Source: Paperless Action Queue
   - Linked document: Paperless doc #1234
                    │
                    ▼
4. User pays the bill (manually or auto-pay)
                    │
                    ▼
5. Monarch syncs the payment transaction:
   - "PSEG PAYMENT" -$185.00 on Jun 20
                    │
                    ▼
6. Matching Engine correlates:
   - Bill (Paperless) ↔ Transaction (Monarch) = PAID
   - Auto-completes the Mission Control task
   - Updates Paperless custom field: payment_status = "paid"
   - Updates Paperless tags: removes "payment-pending", adds "paid"
```

### Task Auto-Resolution

When a bill's matching transaction is found in Monarch:
- The Mission Control task is **auto-completed** (with note: "Matched to transaction $X on date Y")
- If the task was already completed manually, the match serves as **verification**
- The Paperless document gets updated metadata

---

## Integration Point 3: Medical Bill Deduplication & Payment Tracking

### The Problem
Medical billing is uniquely terrible:
- Same bill arrives 2-3 times (different formatting, slightly different dates)
- EOB arrives separately, amount may differ from bill
- You might accidentally pay the same bill twice
- Patient responsibility amount from EOB is the TRUE amount owed

### Enhanced Medical Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                    MEDICAL BILL LIFECYCLE                           │
│                                                                    │
│  ┌─────────┐    ┌──────────┐    ┌────────────┐    ┌───────────┐  │
│  │ Bill #1 │    │ Bill #2  │    │   EOB      │    │ Monarch   │  │
│  │ (orig)  │    │ (resend) │    │ (insurance)│    │ (payment) │  │
│  │ $450    │    │ $450     │    │ You owe:   │    │ -$312     │  │
│  │ Dr.Smith│    │ Dr.Smith │    │ $312       │    │ DR SMITH  │  │
│  └────┬────┘    └────┬─────┘    └─────┬──────┘    └─────┬─────┘  │
│       │              │                │                  │        │
│       └──────┬───────┘                │                  │        │
│              │                        │                  │        │
│       ┌──────▼──────┐         ┌──────▼──────┐           │        │
│       │ DEDUP       │         │ EOB MATCH   │           │        │
│       │ Engine      │         │ Engine      │           │        │
│       │             │         │             │           │        │
│       │ Same bill!  │         │ Patient owes│           │        │
│       │ Merge →     │         │ $312 (not   │           │        │
│       │ keep #1     │         │ $450!)      │           │        │
│       └──────┬──────┘         └──────┬──────┘           │        │
│              │                       │                   │        │
│              └───────────┬───────────┘                   │        │
│                          │                               │        │
│                   ┌──────▼──────┐                        │        │
│                   │ TRUE AMOUNT │                        │        │
│                   │ OWED: $312  │◄───────────────────────┘        │
│                   │             │                                  │
│                   │ Status:PAID │  (Monarch txn matches!)         │
│                   └─────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Deduplication Strategy

```typescript
interface MedicalBillCluster {
  id: string;
  documents: PaperlessDocument[];   // All copies of this bill
  primaryDocument: PaperlessDocument; // The "canonical" one
  
  // Extracted from document(s)
  provider: string;
  dateOfService: string;
  billedAmount: number;
  
  // From EOB matching
  eobDocument?: PaperlessDocument;
  insurancePaid?: number;
  patientResponsibility?: number;   // TRUE amount owed
  
  // From Monarch matching
  matchedTransaction?: FinanceTransaction;
  paymentStatus: 'unpaid' | 'paid' | 'partial' | 'overpaid' | 'disputed';
  
  // Safety flags
  duplicateWarning: boolean;        // "You may have already paid this"
  amountMismatch: boolean;          // Bill says $450, EOB says you owe $312
}
```

### Dedup Matching Factors

Two medical bills are considered duplicates if:
1. Same provider (fuzzy match ≥85%)
2. Same date of service (exact or ±1 day)
3. Same billed amount (exact)
4. Same patient name

**Alert scenarios:**
- "⚠️ This looks like a duplicate of bill #1234 from May 15. Don't pay twice!"
- "⚠️ Bill says $450 but EOB says your responsibility is $312. Pay the EOB amount."
- "⚠️ You already paid Dr. Smith $450 on Jun 5, but EOB says you only owed $312. Overpaid by $138."

### UI: Medical Bill Cluster View

```
┌───────────────────────────────────────────────────────────────────┐
│  🏥 Dr. Smith — Office Visit (Mar 15, 2026)                      │
│                                                                   │
│  ┌─ Documents ─────────────────────────────────────────────────┐ │
│  │ 📄 Bill (Mar 20)        $450.00    [View in Paperless]      │ │
│  │ 📄 Bill (Apr 5) ⚠️DUPE  $450.00    [View in Paperless]      │ │
│  │ 📄 EOB (Apr 12)         Insurance paid: $138                │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─ Payment Summary ──────────────────────────────────────────┐  │
│  │  Billed:                 $450.00                           │  │
│  │  Insurance Paid:         $138.00                           │  │
│  │  Your Responsibility:    $312.00  (from EOB)               │  │
│  │  ─────────────────────────────────                         │  │
│  │  You Paid:               $312.00  ✅                        │  │
│  │  Matched Transaction:    "DR SMITH OFFICE" Jun 1, Chase    │  │
│  │  Status:                 ✅ PAID IN FULL                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  [Mark Resolved]  [Dispute Amount]  [View All Transactions]       │
└───────────────────────────────────────────────────────────────────┘
```

---

## Integration Point 4: Statement Tracking → Finance Verification

### The Problem
The Statement Tracking system knows your recurring bills and their expected schedule. But does it know if they were actually PAID?

### The Solution: Bidirectional Verification

```
Statement Tracker says:              Monarch Finance says:
"PSE&G bill expected monthly"        "PSEG PAYMENT every ~30 days"
"Last bill: May 2026 ($178)"         "Last payment: May 20 ($178)"
"Next expected: Jun 2026"            "Next recurring: ~Jun 20"
                │                              │
                └──────────┬───────────────────┘
                           │
                    ┌──────▼──────┐
                    │ CORRELATION │
                    │             │
                    │ Statement   │
                    │ received? ✅│  (Paperless has Jun bill)
                    │ Amount: $185│
                    │             │
                    │ Payment     │
                    │ made? ✅    │  (Monarch has PSEG $185)
                    │             │
                    │ On time? ✅ │  (paid 2 days before due)
                    │             │
                    │ FULLY       │
                    │ RECONCILED  │
                    └─────────────┘
```

### Reconciliation States

| Statement | Bill in Paperless | Transaction in Monarch | Status |
|-----------|------------------|----------------------|--------|
| Expected | ✅ Found | ✅ Found (matches) | ✅ Fully Reconciled |
| Expected | ✅ Found | ❌ Not found | ⚠️ Unpaid — Action needed |
| Expected | ❌ Missing | ✅ Payment found | ℹ️ Paid (bill not captured) |
| Expected | ❌ Missing | ❌ Not found | 🚨 Missing + Unpaid |
| Unexpected | ✅ Found | ✅ Found | ℹ️ One-off bill, paid |
| Unexpected | ✅ Found | ❌ Not found | ⚠️ New bill, needs payment |

---

## Unified Alert Generation

All systems feed alerts into Mission Control's alert system:

### Finance Alerts (from Monarch layer)
- Kid spending threshold exceeded
- Budget category over limit
- Anomalous transaction detected
- New subscription detected

### Bill Payment Alerts (from Bill-to-Transaction matching)
- "PSE&G bill due in 3 days — not yet paid"
- "Mortgage payment confirmed — matched to transaction"
- "Water bill OVERDUE — no matching payment found"

### Medical Alerts (from EOB matching)
- "Duplicate medical bill detected — don't pay twice"
- "EOB arrived — your responsibility is $312 (bill says $450)"
- "Dr. Smith bill unpaid for 45 days"
- "Potential overpayment: you paid $450 but EOB says $312"

### Statement Alerts (from Statement Tracking)
- "Expected Verizon statement hasn't arrived"
- "Car insurance bill 15 days overdue — no payment found"

### Task Generation

Alerts auto-create tasks in Mission Control when action is needed:

```typescript
// Example: Bill needs payment
createTask({
  title: "Pay PSE&G Electric — $185",
  description: "Due Jun 22. Bill in Paperless doc #1234.",
  priority: daysUntilDue <= 3 ? 'high' : 'medium',
  dueDate: "2026-06-22",
  source: 'finance-bill-matching',
  metadata: {
    paperlessDocId: 1234,
    amount: 185.00,
    vendor: "PSE&G",
    autoResolveOnPayment: true,  // Complete task when Monarch finds matching txn
  },
  tags: ['finance', 'bill-payment'],
});
```

---

## Data Flow Summary

```
┌──────────────┐     ┌───────────────┐     ┌─────────────────┐
│  Paperless   │     │   Matching    │     │  Mission        │
│  Action      │────▶│   Engine      │────▶│  Control        │
│  Queue       │     │               │     │                 │
│              │     │ Bill↔Txn      │     │ Tasks           │
│ "New bill    │     │ EOB↔Bill      │     │ Alerts          │
│  detected,   │     │ Dedup check   │     │ Auto-complete   │
│  $185 due    │     │ Confidence    │     │ when paid       │
│  Jun 22"     │     │ scoring       │     │                 │
└──────────────┘     └───────┬───────┘     └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Monarch        │
                    │  Finance        │
                    │                 │
                    │ "Found matching │
                    │  PSEG PAYMENT   │
                    │  $185 on Jun 20"│
                    └─────────────────┘
```

---

## Historical Implementation Plan (Superseded)

> The phase mapping below is retained for provenance only. Use
> [`ROADMAP.md`](./ROADMAP.md) for active sequencing and scope.

### Phase 2.5: Bill-to-Transaction Matching (after Monarch connector built)
1. Build vendor name normalization library (PSE&G ↔ PSEG PAYMENT, etc.)
2. Implement fuzzy matching algorithm with confidence scoring
3. Create "Show Matches" UI component (reusable for medical too)
4. Wire bill status back to Paperless custom fields via API
5. Add reconciliation dashboard section to Finance UI

### Phase 3.5: Paperless Action Queue Integration
1. Connect Paperless Action Queue's "PAY" actions to Finance bill tracking
2. Auto-create Mission Control tasks from bill actions
3. Implement task auto-completion when matching transaction found
4. Build the full bill lifecycle view (received → due → paid → reconciled)

### Phase 4.5: Medical Bill Enhancement  
1. Integrate Medical EOB matching engine with Finance layer
2. Add deduplication detection (same bill arriving multiple times)
3. Build cluster view UI for medical bill groups
4. Add "true amount owed" logic (EOB patient responsibility overrides bill amount)
5. Double-payment prevention alerts
6. Connect payment verification to Monarch transactions

### Phase 5.5: Statement Reconciliation
1. Connect Statement Tracker's recurring bill schedule to Finance
2. Implement bidirectional verification (expected → received → paid)
3. Surface "missing + unpaid" as highest priority alerts
4. Add reconciliation status to the bills calendar view

---

## New Mockup: Bill Payment Verification View

This would be a new page or section in the Finance UI: `/finance/bills/reconciliation`

Shows every known bill (from Paperless + Statement Tracker) with payment status from Monarch:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Bill Payment Reconciliation — June 2026                             │
│                                                                     │
│ Filter: [All] [Unpaid] [Needs Review] [Overdue]                     │
│                                                                     │
│ ───────────────────────────────────────────────────────────────     │
│ ✅ PAID                                                              │
│                                                                     │
│ Mortgage (Chase)        $2,450    Due Jun 25   Paid Jun 23  HIGH    │
│ Internet (Verizon)      $89       Due Jun 28   Paid Jun 26  HIGH    │
│ Cell Phone (T-Mobile)   $185      Due Jul 2    Paid Jun 30  HIGH    │
│                                                                     │
│ ───────────────────────────────────────────────────────────────     │
│ ⚡ LIKELY PAID (confirm)                                             │
│                                                                     │
│ Electric (PSE&G)        $185      Due Jun 22   [Show Matches →]     │
│   └─ Best match: PSEG PAYMENT $185 on Jun 20 (87% confidence)      │
│                                                                     │
│ ───────────────────────────────────────────────────────────────     │
│ 🚨 UNPAID / ACTION NEEDED                                           │
│                                                                     │
│ Water/Sewer             $210      Due Jul 5    ⏰ 15 days            │
│ Dr. Smith (medical)     $312      Due Jun 30   ⚠️ 10 days           │
│   └─ EOB confirms: you owe $312 (billed was $450)                  │
│   └─ ⚠️ Duplicate bill detected (Apr 5 copy) — don't pay twice     │
│                                                                     │
│ ───────────────────────────────────────────────────────────────     │
│ ❓ MISSING STATEMENT                                                 │
│                                                                     │
│ Car Insurance (Prog.)   ~$312     Expected Jul 1  Not yet received  │
│   └─ Based on recurring pattern from Statement Tracker              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Vendor Name Normalization

A critical piece for matching bills to transactions:

```typescript
// Vendor alias mapping (built over time, user-confirmable)
const vendorAliases: Record<string, string[]> = {
  "PSE&G": ["PSEG PAYMENT", "PSEG ELECTRIC", "PUBLIC SERVICE ELEC"],
  "Verizon": ["VERIZON WIRELESS", "VZ WIRELESS", "VERIZON FIO"],
  "T-Mobile": ["TMOBILE", "T-MOBILE PAYMENT", "T-MOBI"],
  "Progressive": ["PROGRESSIVE INS", "PROG INSURANCE", "PROGRESSIVE CASUALTY"],
  "Dr. Smith": ["DR SMITH OFFICE", "SMITH MEDICAL", "JOHN SMITH MD"],
  // ... grows over time via user confirmations
};

function matchVendor(paperlessVendor: string, monarchMerchant: string): number {
  // 1. Check alias table for known mappings
  // 2. Fuzzy string similarity (Levenshtein / Jaro-Winkler)
  // 3. Token overlap (split on spaces, compare word sets)
  // Returns 0-1 confidence score
}
```

The system **learns** aliases over time:
- When user confirms a match, store the Paperless vendor ↔ Monarch merchant mapping
- Next time same pair appears, it's an automatic HIGH confidence match

---

## Privacy & Security Notes

- All matching happens locally (self-hosted)
- Medical data (PHI) never leaves the homelab
- Monarch session material is owned only by the bridge and stored outside the repository;
  callers use the protected bridge contract, and login inputs are never committed
- Paperless API tokens scoped to minimum needed permissions
- Audit log for all automatic actions (matches, status changes, task completions)
