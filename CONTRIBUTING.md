# Contributing

Tyrion is Mission Control's household-finance domain, not a standalone finance
product. Read [`docs/PRODUCT-BOUNDARY.md`](docs/PRODUCT-BOUNDARY.md) before proposing a
feature or changing product scope.

## Pull requests

Submit focused pull requests against the default branch. Direct updates, force pushes,
and deletion of the default branch are prohibited. Keep the branch current with
`main`, resolve every review conversation, and wait for both required checks:

- `conflicts-and-python`
- `test-and-build`

This repository currently has one maintainer, so the ruleset requires pull requests
but zero approvals; authors cannot approve their own changes. The requirement must be
raised to one approval before a second maintainer receives merge access. Web-created
commits require signoff. Cryptographic commit signatures are not currently required.

## Data and integration safety

Keep tests deterministic and use only invented data. Never add credentials, reusable
sessions, private financial records, account or transaction identifiers, internal
service details, machine paths, live responses, or generated local state. Normal
development and automated tests use demo mode and must not contact Monarch or load a
developer session. Credentialed live tests require the repository's separate
operator-controlled process and must never capture live output.

Workflow changes require security review. Jobs triggered by pull requests or forks
must remain unprivileged, use GitHub-hosted runners, avoid shared cache and artifact
handoffs, disable persisted checkout credentials, and pin third-party Actions to
immutable commits. Do not add a publication or self-hosted runner path without first
satisfying the private evidence gate in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](docs/DEPLOYMENT-TRUST-BOUNDARY.md).

## Validation and dependencies

Run the smallest existing tests and policy checks that cover the change before opening
a pull request. Dependency updates must preserve lockfiles, reviewed licenses, public
registry provenance, immutable workflow Actions, and container notice inclusion.
Dependabot version updates run weekly; security updates remain independently enabled.

By contributing, you agree that your contribution is provided under the repository's
[MIT License](LICENSE). Dependencies and third-party material retain their own terms;
see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
