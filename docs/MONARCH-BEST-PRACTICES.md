# Getting the Most from Monarch Money

A practical guide to setting up and maintaining Monarch Money so the automated finance layer works well.

This is independent interoperability guidance, not Monarch Money documentation or
endorsement. Product labels and behavior can change; verify current instructions in
Monarch's own interface. Opt-in live connector use is subject to the dated owner
risk acceptance in
[`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md#monarch-terms-and-affiliation).

## Initial Setup Checklist

### 1. Connect All Accounts (Priority: Do This First)
- [ ] All checking accounts
- [ ] All savings accounts
- [ ] All credit cards (especially the ones kids use)
- [ ] Investment/retirement accounts (401k, IRA, brokerage)
- [ ] Mortgage / loan accounts
- [ ] Any PayPal, Venmo, or other payment services

**Tip**: Monarch uses Plaid for connections. If a bank isn't supported, you can add it as a "manual" account and upload statements.

### 2. Name Your Accounts Clearly
Rename accounts in Monarch to something recognizable:
- "Chase Sapphire (Ryan)" not "CHASE CREDIT CARD ...4521"
- "Amex Blue Cash (Family)" not "AMERICAN EXPRESS ...1234"
- "Jake's Debit Card" if a kid has their own card

### 3. Set Up Categories (The Foundation)

Monarch auto-categorizes, but you should:

#### Customize Your Category List
Keep it manageable. Recommended top-level categories:

| Category | Examples |
|----------|----------|
| Housing | Mortgage, property tax, HOA, home repair |
| Utilities | Electric, gas, water, internet, phone |
| Groceries | Supermarket, Costco, Instacart |
| Dining Out | Restaurants, fast food, DoorDash, UberEats |
| Transportation | Gas, tolls, parking, car maintenance |
| Kids - Activities | Sports, lessons, camps |
| Kids - School | Tuition, supplies, lunch accounts |
| Kids - Entertainment | Games, movies, streaming |
| Healthcare | Doctor, dental, pharmacy, insurance premiums |
| Subscriptions | Streaming, SaaS, memberships |
| Shopping | Amazon, clothing, electronics |
| Personal Care | Haircuts, gym, wellness |
| Gifts & Donations | Birthday gifts, charity |
| Travel | Hotels, flights, vacation spending |
| Income | Salary, side income, refunds |
| Transfers | Between accounts (exclude from spending) |

#### Create Rules for Recurring Merchants
In Monarch: Settings → Rules → Create Rule
- "If merchant contains 'NETFLIX' → Category: Subscriptions"
- "If merchant contains 'SHELL' or 'EXXON' → Category: Transportation"
- "If merchant contains 'COSTCO' → Category: Groceries"

**Do this for your top 20 merchants** — it'll auto-categorize 80%+ of transactions.

### 4. Set Up Budgets

Start simple — don't over-budget initially:
- Set budgets for 5-8 categories you want to control
- Use Monarch's "Average Spending" insight to set realistic starting budgets
- Adjust monthly based on actuals

**Recommended starting budgets:**
- Groceries, Dining Out, Shopping, Kids categories, Subscriptions

### 5. Mark Recurring Transactions

Monarch auto-detects some, but review and confirm:
- All subscriptions (streaming, software, gym)
- All bills (utilities, insurance, loan payments)
- Regular income (salary, side gig)

This powers the "upcoming bills" feature and cash flow forecasting.

---

## Weekly Maintenance (5 minutes)

Once the automated layer is running, your weekly Monarch interaction is minimal:

### In Our Triage Inbox (Mission Control):
1. Review flagged/uncategorized transactions (aim for <15 per week)
2. Confirm or reassign categories
3. Assign any unattributed kid charges

### In Monarch Directly (only if needed):
1. Check for failed bank connections (Settings → Accounts)
2. Review any "split transaction" needs (e.g., Costco trip = groceries + household)

---

## Monthly Review (15 minutes)

1. **Budget check**: Are any categories consistently over? Adjust budgets or behavior
2. **Kid spending review**: Use the per-kid view to have informed conversations
3. **Subscription audit**: Review recurring charges — cancel anything unused
4. **Category cleanup**: Batch-reassign any miscategorized transactions you missed

---

## What Monarch Does vs. What Our Layer Does

| Capability | Monarch | Our Layer |
|-----------|---------|-----------|
| Bank connections & sync | ✅ Primary | ❌ Uses Monarch's |
| Auto-categorization | ✅ ML-based | ✅ Triage corrections feed back |
| Budget tracking | ✅ Native UI | ✅ Surfaces in MC dashboard |
| Recurring detection | ✅ Auto-detects | ✅ Pulls for bills calendar |
| Net worth tracking | ✅ Use Monarch | ❌ Not duplicated |
| Investment performance | ✅ Use Monarch | ❌ Not duplicated |
| Per-kid spending | ❌ Not supported | ✅ Our primary add |
| Threshold alerts | ❌ Not supported | ✅ Our primary add |
| Triage inbox UX | ❌ Not supported | ✅ Our primary add |
| AI finance chat | ❌ Limited | ✅ MCP-powered in MC |
| Cross-system alerts | ❌ Siloed | ✅ Unified in MC |

---

## Tips for Power Users

1. **Use Monarch's "Notes" field** — We sync notes, so anything you annotate there is visible in our layer
2. **Don't fight the auto-categorizer** — Set rules instead of manually re-categorizing the same merchant repeatedly
3. **Use account groups** — Group "Ryan's Cards" vs "Family Cards" for cleaner views
4. **Check "Recurring" monthly** — New subscriptions sometimes aren't auto-detected for 2-3 months
5. **Exclude internal transfers** — Mark account-to-account transfers so they don't skew spending totals
