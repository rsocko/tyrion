# Repository Governance

**Last verified:** 2026-08-09; publication policy updated 2026-08-09

This record describes public-safe repository controls. It intentionally omits raw API
responses, actor identifiers, infrastructure names, runner labels, environment
details, credentials, and other operational data.

## Default branch

`main` is governed by an active repository ruleset with no explicit bypass actors.
The ruleset:

- requires a pull request and resolved review conversations;
- requires a linear history;
- requires the current branch to pass `conflicts-and-python` and `test-and-build`;
- blocks deletion and non-fast-forward updates, including force pushes.

The repository currently has one maintainer. Required approvals are therefore set to
zero because an author cannot approve their own pull request. This is an operational
constraint, not independent review. Before a second maintainer receives merge access,
the required approval count must be raised to one and approval after the latest push
must be enabled.

Administrators are not configured as ruleset bypass actors. The previous classic
branch protection remained in place until the ruleset was API-verified against this
governance pull request. It was then removed after the effective branch-rules API
confirmed equivalent-or-stronger enforcement with no gap.

Web-created commits require signoff. Cryptographic commit signatures are not required
while the repository has one maintainer and no verified local signing workflow.

## GitHub Actions

Repository workflow tokens default to read-only, and Actions cannot approve pull
requests. Allowed Actions are limited to the GitHub-owned validation Actions used by
the repository, with provider-side immutable SHA enforcement. Repository policy tests
also reject mutable Action references, persisted checkout credentials, privileged or
cross-workflow triggers, untrusted runner selection, and cache or artifact handoffs.

The only writable workflow token is the `packages: write` grant in
`build-and-push.yml`. That workflow runs only for a push to `main` on a GitHub-hosted
runner, verifies its repository/ref/commit context, and uses the run-scoped
`GITHUB_TOKEN` to publish the two GHCR images. It accepts no manual, pull-request,
cross-workflow, reusable, or dispatch trigger and consumes no shared cache or artifact.
All other workflows remain read-only. The complete image and package boundary is in
[`DEPLOYMENT-TRUST-BOUNDARY.md`](DEPLOYMENT-TRUST-BOUNDARY.md).

Workflows from all external contributors require approval. Approved fork work can
schedule only the repository's read-only GitHub-hosted validation.

## Dependency and vulnerability controls

The dependency graph, Dependabot alerts, and Dependabot security updates are enabled.
Weekly version updates cover GitHub Actions, Python dependencies in
`monarch-bridge`, and npm dependencies in `kid-engine` and `triage-app`.

GitHub secret scanning, push protection, and private vulnerability reporting are
enabled and authenticated-API verified. Workflows from all external contributors
require approval. Pull-request workflows cannot publish; package write permission is
isolated to the trusted default-branch publisher.
Vulnerabilities must never be reported through public issues; follow
[`../SECURITY.md`](../SECURITY.md).

## Licensing and public data

Original repository content is MIT licensed. Dependencies and third-party material
retain their own terms. The authoritative records are:

- [`../LICENSE`](../LICENSE)
- [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
- [`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md)
- [`SECURITY-AUDIT-2026-08-08.md`](SECURITY-AUDIT-2026-08-08.md)
- [`GITHUB-SURFACE-AUDIT-2026-08-09.md`](GITHUB-SURFACE-AUDIT-2026-08-09.md)
- [`SYNTHETIC-DATA-CERTIFICATION.md`](SYNTHETIC-DATA-CERTIFICATION.md)
- [`PUBLIC-READINESS-REMEDIATION.md`](PUBLIC-READINESS-REMEDIATION.md)

## API verification

Settings are accepted only after authenticated API reads confirm their effective
state. Verification distinguishes:

- **enabled** or **disabled**, when the API exposes the setting;
- **unavailable for current visibility or plan**, when GitHub rejects the feature;
- **permission denied**, which is an incomplete audit rather than a feature state.

The expected effective state is:

| Surface | Expected state |
| --- | --- |
| Ruleset | Active on the default branch, no explicit bypass, pull request required |
| Required checks | Strict `conflicts-and-python` and `test-and-build` |
| History | Linear; deletion and force pushes blocked |
| Reviews | Conversations resolved; zero approvals while single-maintainer |
| Actions token | Read-only; Actions PR approval disabled |
| Action sources | Selected GitHub-owned Actions; immutable SHA required |
| Container publication | GitHub-hosted `main` publisher; contents read and package write only |
| Dependabot | Alerts and security updates enabled; weekly version updates configured |
| Commit policy | Web signoff enabled; signed commits not required |
| Public-only security | Secret scanning, push protection, private vulnerability reporting, and all-external-contributor workflow approval enabled and API-verified |
