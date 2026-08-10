# Public source release gate

**Evaluated:** 2026-08-09T21:01:48-04:00

**Issue:** [#98](https://github.com/rsocko/tyrion/issues/98)

**Evaluated revision:** `9833c58` (public `main`) and the anonymous closing pull-request head

**Recommendation:** Go for the public source repository; no-go for image, package,
release, or deployment publication

> **Historical record:** This gate describes revision `9833c58` on 2026-08-09.
> The later reviewed GitHub-hosted GHCR publisher in
> [`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md) supersedes its
> container-image publication decision. Release and deployment automation remain
> separate, disabled surfaces.

The owner changed source visibility to public and explicitly requested the terminal
anonymous verification. A credential-free clone, unauthenticated API and web reads, an
anonymous full-ref fetch, and an anonymous fetch of the closing pull-request head all
succeeded. The visibility-dependent security controls are enabled and API-verified.
Issue #98 may close when this evidence reaches `main` with both required checks green.

Image, package, release, and deployment publication remains disabled. This decision
does not enable those surfaces or waive any requirement in
[`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md).

## Gate evidence

| Gate | Current evidence | Result |
| --- | --- | --- |
| Blocking readiness work | Issues #97, #99, #100, #101, #102, #103, and #104 are closed with the redacted evidence mapped in [`PUBLIC-READINESS-REMEDIATION.md`](PUBLIC-READINESS-REMEDIATION.md). | Pass |
| Product and publication boundary | Tyrion remains Mission Control's household-finance domain, Monarch remains the system of record, and `triage-app` remains a bounded operations/configuration UI. The publication workflow has no runnable job or privilege. | Pass |
| Default-branch governance | The post-change active default-branch ruleset has no bypass actors; it requires pull requests, resolved conversations, strict current `conflicts-and-python` and `test-and-build` checks, linear history, and blocks deletion and non-fast-forward updates. Web commits require signoff. | Pass |
| Public-only security controls | Secret scanning, push protection, and private vulnerability reporting are enabled. All external contributors require workflow approval. The authenticated APIs report zero open secret-scanning alerts. | Pass |
| Current protected revision | Both required checks completed successfully on public `main`. Actions default to read-only, cannot approve pull requests, allow only the three reviewed GitHub Actions, and require immutable SHA references. | Pass |
| Dependency security and provenance | The authenticated API reports zero open Dependabot alerts and enabled security updates. Lock-policy checks accept only public npm/PyPI provenance, required integrity or hashes, reviewed licenses, and the pinned dependency graph. Public PyPI metadata was anonymously readable; the public closing checks provide the cold npm and Python installs. | Pass |
| Anonymous source and documentation | A credential-free clone resolved public `main` and contained the README, MIT license, third-party notices, security policy, and contribution guidance. The closing pull-request head was fetched anonymously and all 28 Markdown documents had valid relative links. | Pass |
| Full refs and reachable history | An unauthenticated remote inventory reconciled 82 concrete advertised refs: 22 branches, 54 pull-request heads, six pull-request merge refs, and no tags. The graph contained 184 commits, 537 trees, and 621 reachable blobs. | Pass |
| Secret and sensitive-data scans | Gitleaks 8.30.1 found four instances of two reviewed dependency-policy metadata values. TruffleHog 3.96.0 found four distinct deterministic `test_` names used only as Python test identifiers and one unverified invented URI fixture. These match the established classifications; no result is unexplained. | Pass |
| Public GitHub surfaces | Anonymous API and web reads succeeded for repository metadata, Actions and run pages, issues, pull requests, security, releases, and the package listing. The anonymous collaboration inventory contained 141 issue/pull-request records and 76 issue comments; Gitleaks and TruffleHog reported zero findings. Private-source cross-references remained permission-gated. | Pass |
| GitHub-hosted logs | All 16 post-ledger logs, three changed collaboration records, and both initial closing-PR logs were scanned with zero findings. GitHub exposes public run pages anonymously but requires authentication for the log-archive API; that platform restriction does not conceal the public workflow definition or run result. | Pass |
| Publication surfaces | The publication workflow remains manually disabled and has no runnable job or privilege. There are no tags, releases, artifacts, caches, deployments, environments, or public package links for Tyrion. No branch or run is named for temporary lock generation. | Pass |
| Retained Actions history | At the terminal snapshot the repository had 315 retained workflow runs, zero active runs, one-day retention, and no artifact or cache handoff. See the issue #108 disposition below. | Pass for source visibility |
| Clean public build path | Public `main` passed the hosted cold Python and npm installs, deterministic tests, lint, type checks, builds, both Docker builds, and advisory check. The closing pull request must repeat both required checks against its final public head before merge. | Pending closing PR |

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

## Post-change acceptance

The owner decision and visibility change are complete. The required public-only
security controls, repository governance, anonymous source and collaboration surfaces,
public ref/history scan, and fail-closed publication state all pass. The remaining
mechanical gate is the closing pull request's final public `conflicts-and-python` and
`test-and-build` results. Those checks include cold public-registry installs,
deterministic tests, lint, type checks, application builds, advisory enforcement, and
both production Docker builds.

If either check fails or the final hosted log scan finds unexpected exposure, the
decision reverts to no-go and issue #98 must remain open. Image, package, release, and
deployment publication remains disabled regardless of the source-release result.
