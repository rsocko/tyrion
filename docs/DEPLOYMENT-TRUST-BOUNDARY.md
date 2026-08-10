# Deployment Trust Boundary

**Status:** Production container publication is enabled for trusted `main` pushes.

Tyrion publishes two Linux production images:

- `ghcr.io/rsocko/tyrion-bridge`
- `ghcr.io/rsocko/tyrion-ui`

## Initial workflow enablement

**Operational note (2026-08-09):** PR #148 merged as `e88cb86` while GitHub still
recorded the publication workflow as manually disabled, so that merge created no
publication run. The repository owner subsequently enabled the existing workflow.
This documentation-only follow-up merge supplies the next trusted `main` push needed
to create the first publication event under the reviewed contract.

The publisher runs entirely on a disposable GitHub-hosted Ubuntu runner. It has no
route to or dependency on the homelab, no self-hosted runner, no static registry
credential, no repository secret, and no cache or artifact handoff. Runtime deployment
and Monarch credentials never enter the build or publication boundary.

## Trusted publication path

`.github/workflows/build-and-push.yml` accepts only a `push` to the repository's
default `main` branch. It does not accept `pull_request`, `pull_request_target`,
`workflow_run`, `repository_dispatch`, `workflow_dispatch`, `workflow_call`, a supplied
ref, or a reusable-workflow input. The job independently verifies the event,
repository, full ref, 40-character commit ID, and checked-out revision before it
authenticates.

The workflow grants only:

- `contents: read`, to check out the trusted commit; and
- `packages: write`, to publish packages associated with this repository.

Authentication uses the run-scoped `GITHUB_TOKEN` and `docker login
--password-stdin`. No PAT or registry password is stored. Checkout does not persist
credentials. The only third-party workflow step is GitHub's checkout Action pinned to
an immutable reviewed commit. Builds resolve public pinned base images and
hash-/lock-pinned public dependencies directly; they do not consume Actions caches,
artifacts from another run, or a private registry.

Pull-request CI remains separate. It runs on GitHub-hosted runners with `contents:
read`, builds both images without pushing, and has no package write permission.
Repository policy tests reject any second use of `packages: write` or `github.token`,
self-hosted runner selection, untrusted or cross-workflow triggers, repository secrets,
mutable Actions, credential persistence, explicit caches, and artifact transfers.

## Image identity and promotion

Each trusted run first verifies that neither commit tag exists, then builds the bridge
and UI exactly once from the checked-out commit and pushes write-once commit tags:

```text
ghcr.io/rsocko/tyrion-bridge:sha-<40-character-git-sha>
ghcr.io/rsocko/tyrion-ui:sha-<40-character-git-sha>
```

The publisher never replaces an existing commit tag. A retry verifies the tag's OCI
revision label, reuses its digest, and builds only a missing counterpart before
retrying promotion. GHCR itself permits package administrators to move tags, so the
digest remains the authoritative immutable identity.

GHCR assigns each pushed manifest an immutable `sha256:` digest. Only after both
commit-tagged images have been built and pushed does the workflow use `docker buildx
imagetools create --prefer-index=false` to point `build-N` at each exact digest, where
`N` is that run's validated `github.run_number`. If the commit is still the remote
`main` head, the publisher also points `main` and `latest` at the same digest. It
resolves every promoted tag and fails if any digest differs. Promotion never rebuilds
either image. An older queued run still receives its historical `build-N` aliases but
cannot move `main` or `latest` backward.

GitHub defines `run_number` as a unique number for each run of a particular workflow;
it starts at one and increases for each new run, while a rerun keeps the same number.
Tyrion accepts only canonical positive decimal values through
`9,223,372,036,854,775,807`. Published `build-N` values may have gaps because failed or
cancelled runs also consume numbers. They are not globally contiguous across
workflows, and operators must not treat them as reset-proof if workflow history or
workflow-file identity changes.

The workflow summary records the full commit tag, `build-N`, and manifest digest for
both images. Canonical Compose deliberately defaults to the convenient moving
`latest` tag. Set its shared `TYRION_IMAGE_TAG` override to a reported `build-N` or
`sha-<commit>` value for a paired rollback; use the reported digest-addressed
references in deployment systems that require immutable pinning. `main`, `latest`,
`build-N`, the commit tag, and the digest all identify the same manifest in a
successful current-head publication.

Both Dockerfiles retain the repository license and dependency notices in `/licenses`
and set OCI source, revision, license, title, and description labels. The revision is
the same full commit ID used in the write-once commit tag.

## Public package visibility

GHCR creates a new container package as **private**, even when it is linked to a public
repository. Repository permission inheritance does not change package visibility.
Publishing with `GITHUB_TOKEN` and the
`org.opencontainers.image.source=https://github.com/rsocko/tyrion` label links each
package to this repository and gives its workflow package access.

GitHub's documented package REST API has no update operation for package visibility.
The run-scoped `GITHUB_TOKEN` can publish and, with package admin access, use GitHub's
preview delete/restore support, but it has no supported operation that changes
visibility. Tyrion therefore cannot perform this operation with available workflow
permissions and deliberately does not store a PAT. After the first successful
publication, the `rsocko` owner must open each package's **Package settings**, choose
**Change visibility**, and set it to **Public**:

- <https://github.com/users/rsocko/packages/container/tyrion-bridge/settings>
- <https://github.com/users/rsocko/packages/container/tyrion-ui/settings>

That one-time setting persists for later versions. Confirm anonymous access by signing
out of GHCR and pulling each workflow-reported `image@sha256:...` reference. If a
same-named package was created previously without being linked to this repository,
connect it to `rsocko/tyrion` and grant the repository Actions access before rerunning;
do not add a PAT or registry secret to the workflow.

GitHub documents the default-private behavior, source-label association, anonymous
public pulls, and workflow `GITHUB_TOKEN` authentication in
[Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
Its [package REST API](https://docs.github.com/en/rest/packages/packages) exposes no
visibility update operation.

## Threat model

| Threat | Control |
| --- | --- |
| Fork or pull-request code attempts to publish | PR workflows have read-only contents permission; only a `push` to `main` starts the publisher. |
| An event payload or manual input selects attacker-controlled code | The publisher has no manual, cross-workflow, reusable, or dispatch trigger and checks the literal repository and default-branch ref. |
| A PR poisons output consumed after merge | Publication performs a clean checkout and rebuild. Workflows prohibit shared caches and artifact upload/download. |
| A mutable Action changes after review | Every external Action reference is a full immutable commit, and repository policy enforces that form. |
| Registry credentials persist or cross trust boundaries | The run-scoped `GITHUB_TOKEN` has only contents read and package write, is passed through standard input, and is logged out at job end. |
| A moving tag changes without a corresponding immutable digest | The publisher first pushes write-once `sha-<commit>`, resolves its registry digest, validates the digest form, and promotes and re-verifies `build-N`, `main`, and `latest` from that digest without rebuilding. |
| A deployment needs rollback rather than the moving release | Canonical Compose uses one shared tag for both images; operators override `latest` with a reported `build-N` or commit tag, or use the reported digest in deployment tooling that accepts full references. |
| Build or publication reaches private infrastructure | The job uses a GitHub-hosted runner and public package/dependency endpoints only; it has no homelab address, runner, credential, or network dependency. |

Repository owners can still change workflows, branch rules, package visibility, or
Actions settings. Account protection, ruleset monitoring, and review of changes to this
workflow remain operator responsibilities. This publication path does not deploy the
images, receive runtime secrets, inspect runtime state, or exercise live Monarch access.

## Runtime ingress boundary

The raw Monarch Bridge has no host port or Traefik router. Its authentication setup,
cookie/session lifecycle, complete contract, and reusable session material remain on
the isolated `tyrion-backend` network.

The UI container owns the existing `https://tyrion.socko.us` origin with two disjoint
Traefik surfaces:

- `/api/connector/v1/` is reachable over public TLS for Mission Control backend and
  worker calls. It does not use the browser/UI `trusted-private-networks` middleware
  because the bearer-protected gateway authenticates every request itself. Its router
  enumerates the exact connector paths instead of accepting an unrestricted prefix,
  and stamps an internal ingress marker. Next.js verifies that marker after URL
  normalization so encoded traversal cannot fall into a private API tree. HTTP only
  redirects to HTTPS.
- Every other public UI route excludes both `/api/internal/` and
  `/api/connector/v1/`, retains `trusted-private-networks`, and reaches the bounded
  operations/configuration UI and `/api/bridge/...` browser proxy.

The connector router targets the UI container, not the bridge container. The Next.js
gateway accepts only its documented Bridge v1 route/method/query/body allowlist,
rejects browser-origin metadata and missing/invalid credentials, then forwards to
private `BRIDGE_URL`. `/auth/*`, raw bridge routes, policy routes, and attribution
routes are unavailable through it. `/api/internal/` remains excluded from every
public router and the attribution handler independently enforces its private Docker
authority.

Connector `GET /health` is composed inside the server-only gateway: it calls private
Bridge `/health` and protected `/auth/status` with `BRIDGE_API_TOKEN`, validates both
bounded v1 responses, and returns only the normalized `HealthResponse`. The verified
auth-status fields replace the coarse health auth fields, but email and all other
session context are discarded. This internal composition does not add `/auth/status`
to either the Next.js route policy or Traefik's exact public allowlist. Failure of
either private call is a sanitized non-2xx gateway error, never a healthy or
authenticated fallback.

Mission Control configures
`FINANCE_MANAGER_URL=https://tyrion.socko.us/api/connector/v1` and
`FINANCE_MANAGER_API_TOKEN` equal to Tyrion's minimum-32-character
`BRIDGE_API_TOKEN`. Its host and token-origin allowlists must contain only
`tyrion.socko.us` and `https://tyrion.socko.us`, respectively. Tokens are attached
only by backend processes and never forwarded across redirects.
