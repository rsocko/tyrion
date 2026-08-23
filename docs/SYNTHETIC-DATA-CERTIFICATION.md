# Synthetic Data and Public Disclosure Certification

**Date:** 2026-08-09
**Issue:** [#103](https://github.com/rsocko/tyrion/issues/103)
**Technical reviewer:** GitHub Copilot coding agent for issue #103
**Approval authority:** Repository owner
**Result:** Approved for public-repository use

This certification covers the current tree and every concrete GitHub-advertised
historical ref. It is intentionally value-free: it records review scope,
classifications, and decisions without preserving candidate literals, raw scanner
output, private identifiers, or local paths.

The repository owner previously confirmed that the repeated demo people,
relationships, issuer associations, and legacy card-rule values are fabricated. The owner
also approved the historical private-repository and package provenance described in
the [full Git ref security audit](./SECURITY-AUDIT-2026-08-08.md) as intentionally
public, low-risk metadata. Merging the pull request that closes issue #103 records
owner approval of the complete retained-value classification below.

## Current-tree review inventory

Each row identifies the reviewer and disposition for every current fixture, mock,
demo, screenshot, documentation-example, configuration-example, and operational
metadata class. Grouped paths include every file below the stated path.

| Surface | Technical reviewer | Disposition |
| --- | --- | --- |
| `kid-engine/tests/**`, `kid-engine/config/demo-kids.json`, and `finance-insights/fixtures/**` | Issue #103 coding agent and Finance insight T1 implementation review | Synthetic. People, relationships, rules, identifiers, amounts, limits, dates, histories, source generations, insight occurrences, and entity associations are invented deterministic inputs. Public entity names may be intentional references. |
| `monarch-bridge/test_*.py` and `monarch-bridge/conftest.py` | Issue #103 coding agent | Synthetic. Test records, upstream shapes, sessions, tokens, identifiers, and timestamps are deterministic inventions using temporary external session paths. |
| `triage-app/src/lib/mock-*.ts` and `triage-app/test/**` | Issue #103 coding agent | Synthetic. UI people, relationships, identifiers, amounts, balances, budgets, bills, dates, histories, and entity associations are invented mock data. Public entity names may be intentional references. |
| `mockups/**` | Issue #103 coding agent | Synthetic visual references. Embedded people, relationships, financial values, dates, and activity histories are invented and do not define deployment architecture. |
| `monarch-bridge/config.example.env`, `triage-app/.env.example`, and `deploy/homelab/.env.example` | Issue #103 coding agent | Intentional public examples. Values are blank, bracketed placeholders, reserved examples, loopback defaults, benign numeric or boolean operational defaults, or generalized resource, image-tag, volume, and network names; no credential or reusable session material is present. |
| Root and component README files, `docs/**`, `brand/**`, API examples, and the OpenAPI document | Issue #103 coding agent | Public documentation. Example personal and financial values are synthetic; public protocol names, reserved endpoints, and public project references are intentional. Historical private provenance remains governed by the explicit owner decision recorded in issue #101. |
| `.github/workflows/**` and `deploy/homelab/**` | Issue #103 coding agent | Intentional public operational configuration. Standard GitHub runner labels, repository-derived registry locations, public action coordinates, generalized service roles, and placeholder topology are required to reproduce builds and deployment contracts. No private hostname, network address, runner identity, registry credential, or machine path is retained. |
| Package manifests and lockfiles | Issue #103 coding agent | Intentional public dependency metadata. Package names, versions, registry URLs, and integrity digests are required for deterministic restoration and grant no access. |
| Screenshots and browser captures | Issue #103 coding agent | None are tracked in the current tree or reachable history. Brand and vector design assets contain no captured household or operational state. |
| Git commit messages and author/committer identities | Issue #103 coding agent; owner decision from issue #101 | Intentional public Git metadata. The prior all-ref review found no private financial record, credential, or machine state in this class. |

The active TypeScript fixture and mock modules also carry an in-source synthetic
notice. The JSON demo configuration is covered by its explicit demo path and the
inventory above; adding a non-schema certification field would weaken contract
validation.

## Historical-ref coverage

The review repeated the issue #101 clean-room method from a fresh remote inventory:
all advertised heads, pull-request heads, pull-request merge refs, and tags were
copied into an isolated repository and reconciled exactly before content review.

| Coverage dimension | Result |
| --- | ---: |
| Concrete advertised refs | 48 |
| Branch refs | 20 |
| Pull-request head refs | 24 |
| Pull-request merge refs | 4 |
| Tag refs | 0 |
| Missing, extra, or mismatched refs | 0 |
| Reachable commits | 101 |
| Reachable trees | 372 |
| Reachable blobs | 445 |
| Unique historical paths | 154 |
| Fixture, mock, demo, sample, or example paths | 15 |
| Screenshot or browser-capture paths | 0 |
| Blobs absent from every non-merge commit diff | 5 |

Path coverage is the union of `git ls-tree -r` over every reachable commit. Reachable
blob object IDs were reconciled against the scanner set; all 445 blobs were non-empty
and scanned. The five blobs omitted by non-merge patch traversal were extracted with
a text extension, confirmed non-empty, and scanned separately.

## Scanner and targeted-review results

| Check | Result |
| --- | --- |
| Gitleaks 8.30.1, all-ref full history, fully redacted | No findings |
| Gitleaks 8.30.1, extracted merge-only residue | No findings |
| TruffleHog 3.96.0, exact reachable-blob set | Eleven historical-blob instances of three deterministic Python test-name false positives; all occur only in test function definitions and reproduce the detector behavior classified in issue #101 |
| TruffleHog 3.96.0, extracted merge-only residue | No findings |
| Sensitive artifact-name review | Example environment files and documented session/security source files only; no live environment, cookie store, key, certificate, database, export, capture, archive, log, backup, or generated secret artifact |
| Full-blob structural review | No private key, certificate, literal credential assignment, private network address, full payment-card number, bank/routing number, government identifier, or unclassified machine path |
| Personal and financial value review | Every retained household association and financial record in fixtures, mocks, demos, and mockups is classified synthetic; no private household record or live upstream response is retained |
| Operational disclosure review | Current values are standard public platform metadata, repository-derived expressions, reserved examples, or generalized roles; historical private provenance is covered by the explicit issue #101 owner decision |

Raw candidates and scanner output existed only in access-limited temporary storage
and were deleted after aggregate classification.

## Certification and ongoing rule

All people, household relationships, card suffixes, account/transaction-like
identifiers, histories, amounts, limits, balances, dates, records, and entity
associations retained in fixtures, tests, demos, or mockups are certified synthetic.
They were not captured from Monarch, a reusable session, a private financial export,
or a live household record. Public entity and product names may be intentional
references; their appearance does not assert a private relationship or financial
record.

Operational details retained in the current tree are approved only when they are
standard public platform metadata, repository-derived expressions, reserved
examples, generalized roles, or required public project coordinates. New fixtures
must carry an explicit synthetic notice or be added to this inventory. New
operational identifiers require owner approval before publication. Live payloads,
screenshots, machine paths, credentials, session material, and private financial
records remain prohibited.
