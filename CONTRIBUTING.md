# Contributing

Submit focused pull requests against the default branch. Keep tests deterministic and
use only invented data; never add credentials, reusable sessions, private financial
records, internal service details, machine paths, live responses, or generated local
state.

Workflow changes require security review. Jobs triggered by pull requests or forks
must remain unprivileged, use GitHub-hosted runners, avoid shared cache and artifact
handoffs, disable persisted checkout credentials, and pin third-party Actions to
immutable commits. Do not add a publication or self-hosted runner path without first
satisfying the private evidence gate in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](docs/DEPLOYMENT-TRUST-BOUNDARY.md).

Run the repository's existing targeted tests and policy checks before opening a pull
request. Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).
