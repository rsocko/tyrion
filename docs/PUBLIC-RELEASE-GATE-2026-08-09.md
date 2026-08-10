# Public source release gate

**Evaluated:** 2026-08-09T20:36:49-04:00  
**Issue:** [#98](https://github.com/rsocko/tyrion/issues/98)  
**Evaluated revision:** `27de99c` (`main`)  
**Recommendation:** Conditional go for the controlled source-visibility transition;
no-go for publication or public collaboration until the transition checks below pass

This is a fail-closed pre-publication decision. The repository was private during this
evaluation, and the operator did not authorize a visibility change. Anonymous API and
credential-free clone probes therefore returned not found or unreadable as expected.
Issue #98 cannot be finally accepted until the owner explicitly approves the visibility
change and the post-change anonymous verification succeeds.

Image, package, release, and deployment publication remains disabled. This decision
does not enable those surfaces or waive any requirement in
[`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md).

## Gate evidence

| Gate | Current evidence | Result |
| --- | --- | --- |
| Blocking readiness work | Issues #97, #99, #100, #101, #102, #103, and #104 are closed with the redacted evidence mapped in [`PUBLIC-READINESS-REMEDIATION.md`](PUBLIC-READINESS-REMEDIATION.md). | Pass |
| Product and publication boundary | Tyrion remains Mission Control's household-finance domain, Monarch remains the system of record, and `triage-app` remains a bounded operations/configuration UI. The publication workflow has no runnable job or privilege. | Pass |
| Default-branch governance | The active default-branch ruleset has no bypass actors; it requires pull requests, resolved conversations, strict current `conflicts-and-python` and `test-and-build` checks, linear history, and blocks deletion and non-fast-forward updates. Web commits require signoff. | Pass |
| Current protected revision | Both required checks completed successfully on `27de99c`. Actions default to read-only, cannot approve pull requests, allow only the three reviewed GitHub Actions, and require immutable SHA references. | Pass |
| Dependency security and provenance | The authenticated API reports zero open Dependabot alerts and enabled security updates. Lock-policy checks accept only public npm/PyPI provenance, required integrity or hashes, reviewed licenses, and the pinned dependency graph. | Pass |
| License and contribution surfaces | The MIT license, third-party notices, provenance review, security-reporting path, contribution rules, and public product boundary are present. All 27 Markdown documents were checked; the one stale historical source link found by this review is removed in this change. | Pass after this change |
| Full refs and reachable history | A fresh remote inventory reconciled 78 concrete advertised refs: 21 branches, 52 pull-request heads, five pull-request merge refs, and no tags. The isolated mirror also contained 21 remote-tracking aliases. The graph contained 179 commits, 531 trees, and 611 reachable blobs. | Pass |
| Secret and sensitive-data scans | Gitleaks 8.30.1 found four instances of two reviewed dependency-policy metadata values. TruffleHog 3.96.0 found four distinct deterministic `test_` names used only as Python test identifiers and one unverified invented URI fixture. These match the established classifications; no result is unexplained. | Pass |
| GitHub-hosted delta | All 16 Actions logs and three changed collaboration records since the durable closing snapshot were downloaded to controlled temporary storage and scanned. Gitleaks and TruffleHog reported zero findings. Temporary scan material was removed. | Pass |
| Publication surfaces | There are no tags, releases, artifacts, caches, deployments, or environments. No branch or run is named for temporary lock generation. Public package/container inventory remains the zero-package owner attestation from issue #104; no repository workflow can publish one. | Pass |
| Retained Actions history | The repository has 310 completed or retained workflow runs, zero active runs, one-day retention, and no artifact or cache handoff. See the issue #108 disposition below. | Pass for source visibility |
| Clean public build path | Current `main` passed the GitHub-hosted cold Python and npm installs, deterministic tests, lint, type checks, builds, both Docker builds, and advisory check. Local Python verification passed 69 deterministic tests and all policy checks. The local host could not repeat npm downloads or Docker builds; the closing pull request's GitHub-hosted required checks are therefore mandatory evidence. | Pending closing PR |

No live test ran, no Monarch endpoint was contacted, and only invented/demo data was
used.

## Deferred issue #108

Issue #108 remains open and must not be represented as complete. It is an
operator-controlled cleanup after replacement CI/CD is validated and the legacy local
runner is permanently decommissioned. Executing it now would violate its timing gate.

It does not block making the source repository public:

- current workflows select only GitHub-hosted runners and prohibit privileged,
  cross-workflow, cache, and artifact handoffs;
- publication is inert and fail-closed;
- no run is active, artifacts and caches are zero, and retention is one day;
- all retained logs through this evaluation are covered by the durable audit plus the
  clean delta scan above.

Issue #108 must remain open until its own runner-cutover prerequisites and cleanup
acceptance criteria are satisfied.

## Controlled visibility transition

The current recommendation becomes an executable go only when the repository owner
records an explicit go decision. Immediately after changing visibility, and before any
announcement, external contribution, fork workflow, release, package, image, or
deployment:

1. Enable and authenticated-API verify secret scanning, push protection, and private
   vulnerability reporting.
2. Require approval for workflows from all external contributors, then verify that
   approved fork work can schedule only read-only GitHub-hosted validation.
3. Re-query the active default-branch ruleset, required checks, Actions permissions,
   dependency alerts, one-day retention, and empty artifact/cache/publication surfaces.
4. From a clean unauthenticated context, verify repository and clone readability,
   default branch, README and documentation links, license, notices, security policy,
   contribution guidance, issues and pull requests, commit metadata, Actions,
   releases, packages, wiki, and the absence of private/internal targets.
5. Run the documented public cold-install, test, build, and both Docker build paths
   against the public revision without private registries or credentials.
6. Keep publication disabled and close issue #98 only after every check succeeds.

If any control is unavailable, any required check is not green, or anonymous review
finds unexpected exposure, the decision reverts to no-go. Restore private visibility
where possible and follow the incident process while assuming public clones persist.
