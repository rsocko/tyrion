# Monarch Transaction-Rule Import Evaluation

**Status:** Deferred
**Decision date:** 2026-10-09
**Related:** [Issue #256](https://github.com/rsocko/tyrion/issues/256),
[Monarch integration validation](MONARCH-INTEGRATION-VALIDATION.md),
[product boundary](PRODUCT-BOUNDARY.md)

## Decision

Tyrion will not add a Monarch Bridge transaction-rule endpoint, import flow, or
comparison flow.

Monarch remains the source of record and editor for its transaction rules. Tyrion
continues to own household attribution policy. The two rule systems do not share a
safe normalized meaning: a Monarch rule automates Monarch transaction management,
while a Tyrion merchant rule attributes a transaction to a configured kid with an
explicit confidence level.

Exposing a generic rule summary would not support a decision. Translating a subset
would silently discard ordering, criteria, and actions. Exposing the complete source
shape would violate the Bridge DTO boundary and disclose household configuration that
Tyrion does not need. A rule count or overlap warning would still require reading the
complete sensitive rules while providing no reliable attribution conclusion.

## Evidence

The pinned
[`monarchmoneycommunity==1.6.0` implementation](https://github.com/bradleyseanf/monarchmoneycommunity/blob/v1.6.0/monarchmoney/monarchmoney.py#L3822-L3963)
returns one priority-ordered collection. Its rules can combine merchant, statement,
amount, category, account, owner, and business-entity criteria with actions including
merchant/category changes, tags, goals, review assignment, notifications, report
visibility, ownership, business entities, and transaction splits.

Tyrion policy has a deliberately smaller purpose:

- account defaults select `rule-based`, `parent-shared`, or one configured kid;
- merchant rules contain one bounded merchant pattern, one kid, confidence, and
  enabled state;
- manual decisions override policy, and conflicting attribution remains reviewable.

Monarch has no verified action that assigns a Tyrion kid or confidence. Monarch
household ownership and review assignment are not evidence of the physical spender
and must not be converted to a Tyrion `kidId`.

## Invented deterministic cases

The evaluation used conceptual synthetic cases only. No live account, session, rule,
identifier, or response was accessed or recorded.

| Invented Monarch behavior | Possible Tyrion interpretation | Result |
| --- | --- | --- |
| Match an invented merchant, then set a spending category | Attribute that merchant to a kid | Reject. A category is not a kid identity or confidence signal. |
| Match an invented account, then assign a household owner or reviewer | Create an account default | Reject. Monarch ownership/review responsibility is not physical-spender attribution. |
| Match an invented amount range, then split the transaction and hide part from reports | Create a merchant rule | Reject. Tyrion has no equivalent criteria or action, and partial translation would change meaning. |
| Match an invented merchant, then rename it and add a tag | Compare merchant patterns | Defer. Text overlap alone cannot establish equivalent intent, priority, or attribution. |
| Apply two ordered invented rules whose criteria overlap | Import both patterns | Reject. Tyrion conflict handling and Monarch priority are different semantics. |

Every case is either non-isomorphic or loses information required to explain the
result. There is therefore no useful smallest read-only DTO to publish.

## Contract and UX consequences

- The Bridge does not call `get_transaction_rules` and exposes no transaction-rule
  route, DTO, raw criteria, raw actions, or mutation.
- The Tyrion operations/configuration UI does not offer import, comparison, or a
  second Monarch rule browser. Operators manage Monarch rules in Monarch.
- Mission Control receives no transaction-rule data. It continues to consume only
  normalized transaction facts and Tyrion attribution outcomes.
- No connector gateway or browser proxy allowlist is expanded.
- No live-validation step is added. The capability remains outside the supported
  Bridge contract.

## Reconsideration gate

Reconsider only when a concrete Tyrion-owned workflow identifies a user decision that
cannot be completed in Monarch and defines a lossless normalized candidate model.
That proposal must specify:

1. which Monarch semantics are required and how unsupported criteria/actions fail
   closed;
2. how priority, overlap, identity, and confidence map without inference;
3. a complete-or-error dataset bound and sanitized failure behavior;
4. an explicit review UI that never auto-imports or mutates either rule system; and
5. deterministic invented fixtures demonstrating a useful decision rather than raw
   rule inspection.

Until all five conditions are met, deep-linking to Monarch and configuring Tyrion
policy independently is the complete workflow.
