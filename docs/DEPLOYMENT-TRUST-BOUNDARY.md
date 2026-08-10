# Deployment Trust Boundary

**Status:** Production container publication is enabled for trusted `main` pushes.

Tyrion publishes two Linux production images:

- `ghcr.io/rsocko/tyrion-bridge`
- `ghcr.io/rsocko/tyrion-ui`

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
imagetools create --prefer-index=false` to point `main` and `latest` at those exact
digests without wrapping them in a new index. It then resolves every promoted tag and
fails if its digest differs. Promotion does not rebuild either image. Immediately
before promotion, the job also verifies that its commit is still the remote `main`
head; an older queued run can publish its write-once references but cannot move the
discovery tags backward. The workflow summary records both digest-pinned references;
production compose requires those digests and never defaults to a mutable tag.

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
| A moving tag changes without a corresponding immutable digest | The publisher first pushes write-once `sha-<commit>`, resolves its registry digest, validates the digest form, and promotes and re-verifies that digest without rebuilding. |
| Deployment silently advances to a mutable image | Canonical production compose requires explicit bridge and UI `sha256:` digests. |
| Build or publication reaches private infrastructure | The job uses a GitHub-hosted runner and public package/dependency endpoints only; it has no homelab address, runner, credential, or network dependency. |

Repository owners can still change workflows, branch rules, package visibility, or
Actions settings. Account protection, ruleset monitoring, and review of changes to this
workflow remain operator responsibilities. This publication path does not deploy the
images, receive runtime secrets, inspect runtime state, or exercise live Monarch access.
