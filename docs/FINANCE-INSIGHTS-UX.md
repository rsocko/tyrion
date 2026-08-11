# Finance Insights UX

**Status:** Approved design for issues #22, #23, and #24
**Artifacts:** [`finance-insights-overview.html`](../mockups/finance-insights-overview.html) and [`finance-insight-notification-detail.html`](../mockups/finance-insight-notification-detail.html)
**Delivery plan:** [`FINANCE-INSIGHTS-DELIVERY-PLAN.md`](./FINANCE-INSIGHTS-DELIVERY-PLAN.md)

This proposal follows [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md). The HTML files
are static review artifacts with invented data, not routes or production UI.

## Ownership

| System | Responsibility |
| --- | --- |
| Tyrion | Detector rules, seasonal/adaptive baselines, exclusions, baseline sufficiency, confidence, explanations, contributor selection, stable source occurrence lifecycle, and suppression policy |
| Mission Control | `/finance` attention and spending-insight groups; notification rendering, dedupe, grouping, read/dismiss/snooze disposition; safe navigation; provenance display; and shared responsive/accessibility patterns |
| Monarch | Authoritative transactions, categories, recurring items, and reports; full review, categorization, recurring management, and reporting open there through deep links |
| Monarch Bridge | Sole Monarch session owner and normalized Bridge v1 transport; no insight product navigation or raw upstream response exposure |
| OWL or another document system | Optional bill amount, usage, billing-period, and source-document evidence; original documents remain in their source system |
| Tyrion operations/configuration UI | Future Tyrion-owned threshold and suppression-policy configuration may live here, but daily insight cards and notification/detail screens do not |

No Bridge v1 DTO change is proposed. A future insight API should be a separate,
versioned Tyrion domain contract built from synchronized Bridge DTOs. It must return
normalized summaries and bounded evidence, not raw Monarch or community-client
responses. Mission Control should retain only the operational context and opaque
references needed for attention, notification disposition, deduplication, grouping,
and confirmed actions.

## Surface model

1. **Compact summary:** Dashboard and notifications show the insight type, observed
   value, expected value or range, confidence, baseline sufficiency, and freshness.
   They link to detail rather than embedding charts or transaction lists.
2. **Finance information architecture:** `/finance` remains the durable attention
   home: **Needs attention -> Spending insights** (Recurring changes, Large
   transactions, Month-over-month changes) **-> existing digest/health/alerts ->
   Continue in Monarch**. It is not a ledger or generic transaction inbox.
3. **Notification/detail context:** Finance notifications and an insight detail
   context explain the triggering rule, comparable history, exclusions, contributor
   set, provenance, freshness, and available dispositions. `/finance/review` remains
   attribution-specific; anomaly disposition must not reuse attribution-resolution
   semantics.
4. **Native workflow:** Each detail deep-links to the relevant Monarch transaction,
   recurring item, category report, or other authoritative source. Link targets should
   be constructed from an allowlisted integration mapping, not arbitrary URLs supplied
   by upstream data.
5. **Configuration:** Detector thresholds, approved merchants, and durable suppression
   policy are Tyrion-owned settings. Mission Control may link to that configuration and
   may collect a confirmed action through a protected Tyrion domain API.

Finance remains `notificationOnly`: insights do not create ordinary Mission Control
tasks. Notifications are the mature event-delivery surface across dashboard, desktop,
and mobile.

## Information hierarchy

Every insight carries:

- A concise statement of what changed and why it matters.
- Current value, baseline or expected range, absolute variance, and percentage
  variance when mathematically meaningful.
- Baseline period, equivalent-period treatment, sample count, exclusions, and
  contributor summary.
- **Baseline sufficiency** (`insufficient`, `limited`, or `sufficient`) separately
  from **confidence** (`low`, `medium`, or `high`). Confidence should be a labeled,
  explained conclusion unless the model has calibrated numeric probabilities.
- Source freshness and coverage, Bridge provenance, Tyrion detector/method version,
  policy version, source generation, and evaluation time.
- Stable insight and occurrence identity, source lifecycle, Mission Control delivery
  disposition, bounded action choices, and authoritative deep links.

### Shared Tyrion-to-Mission-Control contract

A separate protected `/api/finance/insights` contract should include:

- Stable `insightId` and `occurrenceId`, kind, source lifecycle, `generatedAt`, and
  `sourceAsOf`.
- Observation and baseline periods, baseline method/window, expected range, observed
  value, absolute delta, percentage delta, and currency.
- Typed entity identity (`recurring`, `transaction`, `category`, or `merchant`) with
  normalized display name and opaque source reference.
- Severity, confidence, baseline sufficiency, explanation, and stable reason codes.
- Source generation, detector/method version, policy version, and actual connector
  identity.
- A typed Monarch target (`transaction`, `recurring`, `report-filter`, or safe root),
  never a raw URL. Mission Control constructs the allowlisted external link.

Static artifacts use visibly invented `demo-` entity references and a reserved
`example.invalid` OWL host to demonstrate entity-specific targets without exposing or
guessing live records.

Zero, unavailable, partial/stale, and insufficient-baseline values are distinct states,
not interchangeable falsey or empty values.

### Detector-specific treatment

- **Recurring bill amount:** Lead with a same-season expected range, then show rolling
  context. Account for billing-period length and usage only when normalized document
  evidence exists. Missing seasonal history is an explicit insufficient-baseline
  state, not an adaptive anomaly.
- **Large transaction:** Deliver notification-first, with an optional open/recent
  `/finance` card. Show the explicit household rule and adaptive merchant,
  category, and account comparisons, including whether each comparison contributed to
  the result. Identify exclusions. Never use fraud language or
  imply that Tyrion replaces card-issuer monitoring.
- **Category or merchant variance:** Persist ranked category/merchant movers on
  `/finance` and deliver one grouped monthly digest for material movers. For a partial
  month, compare the same elapsed
  period in prior months. Require both a relative change and meaningful dollar impact.
  Explain refunds, transfers, category changes, and sparse samples, and show only the
  top bounded contributors.

## Lifecycle and actions

There are two independent state machines:

```text
Tyrion source: analyzing -> open -> resolved/superseded
Mission Control delivery: unread/read -> snoozed or dismissed
```

`insufficient-baseline` and `unavailable` are explicit non-alert analysis states.
Re-running the same detector against the same source generation and policy version is
idempotent. Mission Control uses stable insight/occurrence keys for dedupe and grouping.
Dismiss or snooze does not imply Tyrion resolution. Materially changed evidence may
create a new occurrence and resurface. Refunds, corrections, source mutations, or a
newer analysis may resolve or supersede an occurrence.

Actions are intentionally distinct:

- **Dismiss or snooze** changes only Mission Control notification disposition.
- **Expected/approved** records a structured reason and may optionally propose a
  bounded suppression.
- **Suppress** requires explicit scope and duration, shows who created it and when it
  expires, and provides an undo path. V1 allows 30, 90, or 180 days and prohibits
  permanent suppression.
- **Not useful** is structured feedback. It does not silently mutate thresholds.
- **Open in Monarch** starts the comprehensive source workflow; it is not presented as
  a Tyrion or Mission Control write.

Tyrion persists detector/source lifecycle and suppression policy. Mission Control owns
notification disposition, filtering, grouping, safe navigation, and rendering, while
retaining only minimal references to Tyrion occurrences.

## Mission Control integration notes

- Fetch insights through a separate protected finance endpoint so insight failure does
  not take down the existing overview. Use finance-local presentation components and
  the finance notification provider's rich card/action model.
- Use the actual configured Monarch connector and stable identities. Existing
  Mission-Control-generated finance notifications use random identifiers and a fake
  connector reference; retire that path rather than extending it.
- Retire the existing mean/standard-deviation finance anomaly detector in favor of the
  explainable Tyrion detector contract.
- The first release may assume one configured Monarch connector, but the selector and
  single-connector assumption must be explicit in contract and UI behavior.
- Expand allowlisted external-link builders for typed Monarch transaction, recurring,
  and report/filter targets, plus typed OWL document targets when evidence exists.
  Never render a Tyrion-provided URL.
- Preserve category/merchant filtering on mobile; current mobile category-filter
  parity is a known implementation requirement.

## Accessibility and responsive behavior

- State meaning uses text and icon/shape in addition to color.
- Focus indicators are visible, controls are at least 44px high, and headings,
  landmarks, tables, labels, and fieldsets provide semantic navigation.
- Narrow layouts move the queue above the selected detail, stack comparison facts,
  keep actions full width, and allow evidence tables to scroll without clipping.
- Mockups respect reduced-motion preferences and include a print treatment.
- Compact surfaces preserve the critical state, value, confidence, sufficiency, and
  freshness text instead of relying on hover or hidden detail.

## Approved v1 delivery decisions

- Use existing Mission Control primitives and one shared detail component in both the
  canonical notification detail route and a `/finance` drawer. `/finance/review`
  remains attribution-only.
- Use verified allowlisted Monarch entity links when supported and safe
  Transactions/Recurring/Reports root fallbacks otherwise.
- The fixed single operator may use all feedback and 30/90/180-day suppression actions
  with undo. Permanent suppression is prohibited; no permission model is introduced.
- Candidate detector thresholds are versioned, feature-gated defaults. Recurring
  decreases are analysis-only, and adaptive large-transaction alerts below the
  explicit rule require at least two eligible baseline dimensions to agree. Canary
  tuning affects future source generations and never retroactively relabels prior
  occurrences.
- A dismissed insight resurfaces only for a new occurrence or materially changed source
  value/classification. Corrections resolve or supersede the old occurrence.
- New alerts require source data no more than 48 hours old. The monthly digest runs on
  day 2 at 9:00 AM household-local time; medium-confidence movers remain visible on
  `/finance` but do not notify.
