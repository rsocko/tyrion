# Public-readiness remediation ledger

**Issue:** [#102](https://github.com/rsocko/tyrion/issues/102)

**Review date:** 2026-08-09

**Status:** Repository remediation complete; publication gates remain fail-closed

This ledger maps the findings and owner decisions from issues #97, #99, #100,
#101, #103, and #104 to terminal dispositions and redacted evidence. It does not
contain candidate values, raw scanner output, private financial records, private
infrastructure details, or machine-specific paths.

## Credential and history decision

No review found a confirmed or uncertain credential, reusable session, private
financial record, or live household record. The final scans likewise found none.
Credential rotation or revocation is therefore **not required**. Deleting content
was never treated as credential invalidation.

A history rewrite and remote-ref purge are also **not required**. The only retained
historical private provenance was explicitly accepted by the repository owner as
intentionally public, low-risk metadata that grants no access. Rewriting Git
history would not reduce credential or financial-data exposure, and GitHub-owned
pull-request refs cannot be completely purged by a repository rewrite.

## Terminal finding ledger

| Source | Finding or decision | Owner | Terminal disposition and remediation | Evidence |
| --- | --- | --- | --- | --- |
| #97 | Repository license | Repository owner | **Resolved.** Owner-authored content is MIT licensed. Third-party terms remain separate. | [`LICENSE`](../LICENSE), [`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md) |
| #97 | Scaffold fonts and favicon | Repository maintainer | **Resolved.** Unused font binaries were removed and the scaffold favicon was replaced with an authored asset. | [`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md) |
| #97 | Dependency, image, font, and notice obligations | Repository maintainer | **Resolved for the reviewed resolutions.** Material runtime and development terms, base images, hosted fonts, and required notices are recorded. Re-review is required when resolutions change. | [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md), license policy check |
| #137 | Production image runtime license texts | Repository maintainer | **Resolved.** Authoritative sharp and libvips license texts are retained in the production image and verified by deterministic container tests. | [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md), container contract tests |
| #97 | Monarch service terms and Tyrion naming risk | Repository owner | **Accepted owner risk.** Live mode remains opt-in, personal, non-commercial, and disabled in automated testing. Affiliation is disclaimed. Character references and third-party artwork remain excluded. | [`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md) |
| #99 | Default-branch governance | Repository owner | **Resolved.** An active no-bypass ruleset requires pull requests, strict current checks, resolved conversations, linear history, and blocks deletion and force pushes. | [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md), authenticated ruleset API |
| #99 | Actions permissions and supply-chain policy | Repository owner | **Resolved.** Tokens default read-only, Actions cannot approve pull requests, only the reviewed GitHub-owned allowlist is permitted, and immutable Action references are provider-enforced. | [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md), workflow policy tests, authenticated Actions APIs |
| #99 | Dependency automation | Repository owner | **Resolved and configured.** Dependency graph, alerts, security updates, and weekly update groups are enabled. Human-authored remediation is merged and the authenticated API reports zero open alerts. | [`.github/dependabot.yml`](../.github/dependabot.yml), authenticated security APIs |
| #99 | Public-only GitHub security controls | Repository owner | **Deferred and fail-closed.** Secret scanning, push protection, private vulnerability reporting, and external-contributor workflow approval are unavailable for the current private-repository plan or visibility. They must be enabled and API-verified before public collaboration. | [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md) |
| #100 | Untrusted access to privileged runners and publication credentials | Repository maintainer | **Resolved by removal.** Repository workflows use GitHub-hosted validation only. Privileged triggers, credentials, cache/artifact handoffs, and self-hosted selection are prohibited. | [`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md), workflow policy tests |
| #100 | Image or release publication | Infrastructure owner and repository owner | **Disabled, not waived.** The retained manual workflow has no runnable job or privilege. Independent ephemeral-runner, identity, environment-review, network, signing, and monitoring evidence is required to restore publication. | [`build-and-push.yml`](../.github/workflows/build-and-push.yml), [`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md) |
| #101 | Full-ref secret and sensitive-artifact review | Repository maintainer | **Resolved.** Every advertised branch, pull-request ref, commit, tree, path, and reachable blob was reconciled and scanned. Scanner findings were deterministic test-name or placeholder false positives; no unexplained result remains. | [`SECURITY-AUDIT-2026-08-08.md`](SECURITY-AUDIT-2026-08-08.md), final issue #102 scan |
| #101 | Current private provenance and implementation references | Repository maintainer | **Resolved in the current tree.** Private repository-form references and pinned implementation details were removed. | [`SECURITY-AUDIT-2026-08-08.md`](SECURITY-AUDIT-2026-08-08.md) |
| #101 | Historical private provenance | Repository owner | **Accepted owner disclosure.** Retained as intentionally public low-risk provenance; no history rewrite or ref purge is justified. | Owner decision recorded in #101 and [`SECURITY-AUDIT-2026-08-08.md`](SECURITY-AUDIT-2026-08-08.md) |
| #103 | Personal and financial-looking fixtures, mocks, demos, and examples | Repository owner and #103 technical reviewer | **Certified synthetic.** Every retained class is invented or an intentional public reference; no live response or household record is retained. | [`SYNTHETIC-DATA-CERTIFICATION.md`](SYNTHETIC-DATA-CERTIFICATION.md) |
| #103 | Operational identifiers and architecture detail | Repository owner and #103 technical reviewer | **Resolved or approved.** Current values are standard platform metadata, repository-derived expressions, reserved examples, generalized roles, or required public coordinates. | [`SYNTHETIC-DATA-CERTIFICATION.md`](SYNTHETIC-DATA-CERTIFICATION.md) |
| #104 | Actions logs, artifacts, and caches existing before the first surface audit | Repository maintainer | **Resolved.** All downloadable material was scanned in controlled storage and nonessential runs, artifacts, and caches were deleted. No credential rotation was indicated. | [`GITHUB-SURFACE-AUDIT-2026-08-09.md`](GITHUB-SURFACE-AUDIT-2026-08-09.md) |
| #104 / #102 follow-up | Five later legacy publication build records | Repository maintainer | **Resolved.** All five records were downloaded despite their nonstandard archive encoding, recursively inspected, and scanned. The only secret-shaped hits were public base-image signing fingerprints. Their five obsolete publication runs and artifacts were deleted; post-deletion artifact, publication-run, and cache counts are zero. | Final issue #102 GitHub-surface scan and authenticated Actions APIs |
| #104 / #102 follow-up | Current Actions logs | Repository maintainer | **Resolved.** Every downloadable current log was scanned. One run had no downloadable log. Findings were limited to generic hosted-runner, CI, or generalized service-role paths. | Final issue #102 GitHub-surface scan |
| #104 / #102 follow-up | Current GitHub collaboration metadata | Repository maintainer | **Resolved.** Issues, pull requests, comments, reviews, branches, labels, milestones, hooks, deployments, environments, releases, and tags were inventoried. The final scan produced no detector finding. | Final issue #102 GitHub-surface scan |
| #104 | Packages, releases, assets, attachments, wiki, projects, discussions, deployments, and environments | Repository owner and maintainer | **Resolved.** Owner attests that no GitHub Package exists; the other retained publication surfaces have no content requiring remediation. Wiki and discussions are disabled. | [`GITHUB-SURFACE-AUDIT-2026-08-09.md`](GITHUB-SURFACE-AUDIT-2026-08-09.md), authenticated API inventory |
| #104 | Actions retention and future artifacts | Repository owner | **Resolved.** Retention is one day. Repository policy rejects explicit artifact upload and all cache or artifact handoffs; any future use requires an explicit reviewed policy change. | [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md), baseline policy checks |

Every preceding finding has an owner and terminal disposition. No candidate is open
or unexplained.

## Final verification method

The issue #102 audit started from a fresh authenticated remote inventory and isolated
mirror. It reconciled each advertised ref exactly, enumerated every reachable commit,
tree, historical path, and blob, and extracted the exact reachable blob set. Gitleaks
8.30.1 scanned full history and the blob set with complete redaction. TruffleHog
3.96.0 scanned the exact blob set. Targeted checks covered sensitive filenames,
private keys, JWTs, credential assignments, private network and machine paths,
financial identifiers, generated output, commit metadata, and scanner-blind merge
residue. Temporary raw reports and extracted content were removed after aggregate
classification.

The GitHub-surface pass separately downloaded every accessible Actions log and every
artifact into controlled temporary storage, expanded nested archives, and scanned
GitHub collaboration and publication metadata. Releases, assets, packages,
attachments, caches, deployments, environments, pages, wiki, projects, discussions,
webhooks, branches, tags, labels, milestones, and repository settings were
independently inventoried. Final aggregate counts are recorded on the pull request
that closes #102 so they describe its published head and GitHub surfaces.

### Durable aggregate evidence

The complete pre-ledger full-ref snapshot contained 99 concrete advertised refs:
35 branches, 45 pull-request heads, 19 pull-request merge refs, and no tags. The
isolated mirror reconciled every ref with no missing or mismatched tip and contained
150 reachable commits, 346 trees, 536 blobs, and 214 unique historical paths. Every
reachable blob was extracted; none was omitted.

Gitleaks 8.30.1 reported zero findings in full-history mode and zero findings in the
exact reachable-blob set. TruffleHog 3.96.0 reported 16 instances representing five
distinct candidates in the blob set. Structural classification confirmed only the
previously documented deterministic Python test-name false positives and
documentation/test placeholder URI values; no result was unclassified. Independent
targeted checks found no private-key block, JWT, unexplained sensitive filename, or
coverage gap. A separate current-worktree Gitleaks pass included ignored dependency
and build output: its seven results were an installed upstream package's deterministic
test fixture and framework-generated build hashes. None was tracked, packaged,
credential-shaped after structural review, or unexplained.

The post-cleanup GitHub snapshot contained 140 Actions runs. All 136 downloadable logs
were scanned; four runs had no downloadable log. Artifact, legacy-publication-run, and
cache counts were zero. The collaboration inventory contained 128 issue/PR records,
46 pull requests, 62 issue comments, no pull-request or commit comments, 32 branches,
19 labels, one reviewed webhook, and no release, tag, milestone, deployment, or
environment. Gitleaks reported zero GitHub-surface findings. TruffleHog's 85
unverified results were generated only by cross-field concatenation while scanning
minified Dependabot API JSON; no individual API field contained a candidate. All
machine-path matches were standard hosted-runner, CI, or generalized service-role
paths. No candidate remained unexplained.

These counts establish the durable remediation snapshot. The closing pull request
records the final published-head delta and post-push ref/surface counts.

### Final closing snapshot

After the dependency workstreams landed, the closing branch was rebased onto current
`main` and the complete scan was repeated at the pushed closing head immediately
before this evidence-only finalization. The isolated mirror reconciled all 80
advertised refs (22 branches, 52 pull-request heads, six pull-request merge refs, and
no tags) with no missing or mismatched tip. It contained 178 commits, 394 trees, 610
reachable blobs, and 223 unique historical paths; every reachable blob was extracted.

Gitleaks 8.30.1 again reported zero history findings. Its two exact-blob findings were
public dependency-policy SHA-256 integrity and license metadata, not credentials.
TruffleHog 3.96.0 reported 19 instances representing five distinct candidates, all
covered by the established deterministic-test and placeholder classifications.
Targeted private-key, JWT, sensitive-path, generated-output, package-bound, and
repository-hygiene checks found no unexplained sensitive content.

The final GitHub-surface snapshot contained 306 Actions runs: 305 logs were
downloadable and scanned, and one had no downloadable log. Artifact and cache counts
were zero. The collaboration inventory contained 135 issue/PR records, 52 pull
requests, 76 issue comments, 22 branches, 19 labels, one reviewed webhook, and no
release, tag, milestone, deployment, environment, pull-request comment, or commit
comment. Gitleaks and TruffleHog reported zero findings. No result remained
unexplained. The evidence-only finalization diff and pull-request metadata were then
scanned separately with no finding or prohibited private reference.

## Remaining publication gates

These gates are explained and owned; none is an unexplained remediation finding:
The current fail-closed source-visibility recommendation and required post-change
anonymous checks are recorded in
[`PUBLIC-RELEASE-GATE-2026-08-09.md`](PUBLIC-RELEASE-GATE-2026-08-09.md).

1. **Dependency vulnerabilities:** **Resolved.** Human-authored Actions, Python, and
   UI remediation pull requests #132, #133, and #134 are merged. The UI now uses
   public-registry dependencies outside all applicable vulnerable ranges, and its
   lockfile contains only public-registry package sources. Post-merge Baseline guard
   and CI passed on `main`. Production-image license compliance follow-up #137 is also
   merged with both hosted checks passing. The authenticated Dependabot API reports
   zero open alerts.
2. **Visibility-dependent GitHub controls:** secret scanning, push protection, private
   vulnerability reporting, and external-contributor workflow approval must be
   enabled and API-verified after the visibility or plan supports them and before
   accepting public contributions.
3. **Publication infrastructure:** image, package, release, and deployment publication
   remains disabled until every independent evidence requirement in
   [`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md) is satisfied.
4. **Review governance:** required approvals remain zero only while the repository has
   one maintainer. Before a second maintainer receives merge access, require one
   approval and approval after the latest push.

The repository must remain private except during the controlled visibility transition
defined in [`REPOSITORY-GOVERNANCE.md`](REPOSITORY-GOVERNANCE.md). External workflows,
public collaboration, and publication remain disabled until every applicable gate is
verified.
