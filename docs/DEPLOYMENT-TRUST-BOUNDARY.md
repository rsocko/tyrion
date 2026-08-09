# Deployment Trust Boundary

**Status:** Publication is disabled.

The repository does not contain enough evidence to establish that a privileged
runner, network path, credential broker, or publication target is safe for a public
repository. Repository workflows therefore cannot schedule self-hosted work, access
protected services, mint deployment credentials, publish artifacts, or promote
releases. The retained publication workflow is an inert manual placeholder that
cannot run its job.

Private infrastructure fail-closed hardening has landed outside this repository.
That work removes the legacy publication path but does not establish the independent
disposable-runner, workload-identity, approval, signing, or monitoring evidence
required to enable publication.

Pull requests and forks run only unprivileged validation on GitHub-hosted runners.
They receive read-only repository permissions, do not persist checkout credentials,
do not write shared caches, and cannot transfer artifacts into a later privileged
workflow. Third-party Actions are pinned to reviewed immutable commits. A repository
policy test rejects trigger, runner, permission, credential, cache, and Action-pin
regressions before merge.

## Threat model

| Threat | Fail-closed control |
| --- | --- |
| Fork or pull-request code attempts to reach protected services | Validation uses only GitHub-hosted runners with a read-only token and no deployment identity. No privileged runner labels exist in a workflow. |
| A `workflow_run`, `pull_request_target`, dispatch payload, or reusable workflow launders untrusted inputs into a trusted job | Privileged and cross-workflow triggers, inherited secrets, event-derived refs, and reusable-workflow entry points are prohibited by the workflow policy test. Publication has no runnable job. |
| A pull request poisons a cache or artifact consumed after merge | Workflow caches and artifact transfers are prohibited. Existing repository caches were deleted. Trusted publication cannot consume either surface. |
| A mutable third-party Action changes after review | Every Action reference is an immutable commit and provider-side policy rejects non-immutable references outside a three-Action allowlist. |
| A maintainer publishes an unreviewed branch or stale commit | There is no publication capability. The default branch independently requires current checks, signed linear history, review after the latest push, and resolved conversations. |
| A maintainer account or repository owner is compromised | Repository controls reduce single-change paths but cannot prove account integrity or prevent an owner from changing settings. Account protection, independent environment reviewers, audit monitoring, and credential-broker policy are required infrastructure evidence before publication. |
| A build attempts to substitute an unreviewed dependency or output | Pull-request builds publish nothing. Future publication must use reviewed immutable dependencies, bind output to the protected commit digest, and promote by digest without rebuilding. |

## Required evidence before publication can be enabled

Enabling publication requires a separate private infrastructure review and a new
security-reviewed pull request. The operator must provide redacted evidence that:

1. Publication accepts only a protected default-branch commit that passed required
   checks after merge. It must not trust a pull-request artifact, cache, event payload,
   branch name, mutable tag, user-controlled path, or reusable-workflow input.
2. The publication job uses a protected GitHub environment with required reviewers,
   no administrator bypass, and deployment branch restrictions.
3. Credentials are audience-restricted, short-lived, and issued only after environment
   approval. No static publication credential is stored on a runner or in repository
   configuration.
4. Runners are dedicated to this repository, single-job and ephemeral, start from a
   known-clean image, discard all work and caches after use, and cannot be selected by
   untrusted jobs.
5. Network policy permits only the minimum control-plane and publication endpoints.
   Pull-request jobs cannot route to protected services, runner management interfaces,
   or publication targets.
6. Action and container dependencies are immutable and reviewed. Build output is
   bound to the verified commit digest, signed with workload identity, and promoted
   by digest without rebuilding.
7. Repository owners have verified fork approval policy, branch protection, immutable
   Action enforcement, secret scanning, push protection, dependency alerts, and
   private vulnerability reporting after any visibility change.

The review must not place hostnames, addresses, runner labels, filesystem paths,
topology, credentials, or raw settings in this repository or a public collaboration
surface. Infrastructure implementation belongs in the system that owns the runners
and publication service, not in Tyrion.

## Current repository controls

The publication workflow is disabled in GitHub and inert in the repository. Actions
use a read-only default token, an explicit three-Action allowlist, and provider-side
immutable commit enforcement. The protected default branch requires pull requests, the baseline and full validation
jobs, resolved conversations, linear history, and current-branch checks.
Because this repository has one maintainer, it does not require an impossible
self-review or commit-signing setup. Administrators cannot bypass the other
protections, and force pushes and deletion are disabled. Existing Actions caches were
removed; the workflows do not create replacements. Dependency alerts and security
updates are enabled.

The current private-repository plan does not expose secret scanning, push protection,
private vulnerability reporting, or fork-contributor approval policy. Before changing
visibility or accepting an external contribution, an owner must enable and API-verify
those four controls. If any remains unavailable, publication and external workflow
execution must remain disabled. No protected deployment environment exists because
there is currently no deployment job; creating one is part of the evidence-gated
future publication change, not a substitute for disabling an unverified runner.
