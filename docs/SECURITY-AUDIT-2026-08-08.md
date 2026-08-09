# Full Git Ref Security Audit

**Date:** 2026-08-08
**Repository:** `rsocko/tyrion`
**Issue:** [#101](https://github.com/rsocko/tyrion/issues/101)
**Result:** No credential, reusable session material, private financial record, or
other high-risk sensitive artifact was found in any GitHub-advertised ref.

This report is intentionally redacted. It records coverage, methods, and
classifications without preserving candidate values, raw scanner output, local
paths, or private upstream identifiers.

## Initial scope and coverage

The initial audit snapshot used `git ls-remote` as the authoritative
client-visible ref inventory and copied every concrete advertised ref into an
isolated mirror. Counts below describe that pre-remediation snapshot; the
published remediation branch is covered by the follow-up scan recorded on issue
[#101](https://github.com/rsocko/tyrion/issues/101).

| Coverage dimension | Result |
| --- | ---: |
| Advertised symbolic refs | 1 |
| Advertised concrete refs | 44 |
| Branch refs | 19 |
| Pull-request head refs | 21 |
| Pull-request merge refs | 4 |
| Tag refs | 0 |
| Missing, extra, or mismatched mirror refs | 0 |
| Reachable commits | 91 |
| Pull-request-only commits | 4 |
| Reachable Git objects | 868 |
| Reachable blobs | 429 |
| Reachable blobs omitted from the scan set | 0 |
| Unique historical file paths | 151 |
| Unique historical directory paths | 45 |
| Commit messages and identities | 91 |

The scan covered every client-visible branch, tag, pull-request ref, reachable
commit, commit message, path, and blob. Five blobs never appear on either side of
a non-merge commit diff. They were extracted and scanned separately because
Gitleaks Git history mode examines patches and therefore skips merge commits
entirely. Of those five, three are reachable only through pull-request merge refs
and two are reachable through merge commits on branch and pull-request head refs.

### Published remediation verification

After the first remediation commit was published as pull request #105, the entire
audit was repeated from a fresh advertised-ref inventory and isolated mirror.

| Coverage dimension | Result |
| --- | ---: |
| Advertised symbolic refs | 1 |
| Advertised concrete refs | 47 |
| Branch refs | 20 |
| Pull-request head refs | 22 |
| Pull-request merge refs | 5 |
| Tag refs | 0 |
| Missing, extra, or mismatched mirror refs | 0 |
| Reachable commits | 93 |
| Reachable trees | 350 |
| Reachable blobs | 432 |
| Reachable blobs omitted from the scan set | 0 |
| Unique historical file paths | 152 |
| Unique historical directory paths | 45 |
| Blobs absent from every non-merge commit diff (scanned separately) | 5 |
| Blobs contributed only by pull-request merge refs | 3 |

These counts describe the published first remediation commit. The issue records
the final verification after this report correction.

Git clients cannot enumerate objects that are unreachable from every advertised
ref, such as overwritten commits that GitHub no longer exposes through a branch
or pull-request ref. GitHub secret scanning is the required complementary control
for provider-retained unreachable objects.

## Scanner runs

Scanner output was fully redacted and retained only in temporary, access-limited
scratch storage for classification. Scratch data was removed after each run.

| Tool | Version | Non-sensitive invocation | Result |
| --- | --- | --- | --- |
| Gitleaks | 8.30.1 | `gitleaks git <mirror> --log-opts="--all --full-history" --redact=100 --max-decode-depth=3` | No findings |
| Gitleaks | 8.30.1 | `gitleaks dir <merge-only-blob-set> --redact=100 --max-decode-depth=3` | No findings |
| TruffleHog | 3.96.0 | `trufflehog git file://<all-ref-worktree> --json --no-update --results=verified,unknown,unverified,filtered_unverified` | Three false positives |
| TruffleHog | 3.96.0 | `trufflehog filesystem <merge-only-blob-set> --json --no-update` | No findings |

The TruffleHog Lob detector labeled three Python test function names as verified
credentials. A synthetic control with the same shape produced the same result.
The detector's verification state was therefore not treated as independent proof;
the candidates were classified from source context and structure without printing
their values.

## Targeted checks

Independent checks covered all historical paths and blobs rather than relying only
on scanner signatures:

1. Path classification for environment files, session state, cookies, keys and
   certificates, databases, financial exports, browser captures, archives,
   generated output, logs, backups, and editor or machine state.
2. Full-blob pattern checks for private keys and certificates, common provider
   credentials, JWTs, credentialed connection strings, authorization assignments,
   private network addresses, home-directory paths, financial identifiers, and
   government identifiers.
3. High-entropy token review, including a separate accounting of package-manager
   integrity hashes and Git object names.
4. Credential-named assignment review using structure-only representations.
5. Commit-message and author/committer identity review.
6. Exact reconciliation of reachable blob object IDs against the scanned set.

Path counts are the union of `git ls-tree -r` over every reachable commit, not
`rev-list --objects`, which binds a shared blob to a single name. Merge-only blob
counts use source and destination blob IDs from non-merge diffs. Extracted residue
blobs use a text extension, and the scan must confirm a non-zero byte count because
Gitleaks can silently skip binary-looking extensions.

## Redacted classification

| Finding class | Count | Classification and disposition |
| --- | ---: | --- |
| Python test names matching a provider-key shape | 3 | False positive; deterministic test identifiers, independently reproduced detector behavior |
| Example password placeholder | 1 | False positive; explicit human-readable placeholder |
| Documentation token placeholder | 1 | False positive; bracketed placeholder |
| Live-test environment lookups | 1 file | False positive; process-environment reads without literals |
| Synthetic session, CSRF, secret, and token fixtures | 10 | False positive; deterministic word-structured test data |
| Workflow-generated synthetic token | 2 historical blobs | False positive; generated repeated-character test value |
| GitHub Actions secret context reference | 1 | Intentionally public expression; no secret value is present |
| Package-lock integrity digests | 4,802 tokens | Intentionally public dependency integrity metadata |
| Registry and reserved-domain email addresses | 71 | Intentionally public package metadata or documentation examples |
| Git object names in commit metadata | 100 tokens | False positive |
| Git author and committer identities | 91 commits | Intentionally public Git metadata |
| Demo child and card-rule dataset | 1 dataset, repeated in examples and tests | False positive; repository owner confirmed every person, issuer association, and last-four value is fabricated |
| Private predecessor links and revision details | Historical refs and blobs | Intentionally public low-risk provenance metadata by explicit owner decision; removed from current documentation and grants no access |
| Historical predecessor package identifier | Historical refs and blobs | Intentionally public low-risk provenance metadata by explicit owner decision; not a credential or published package |
| External private implementation repository name | Historical refs and blobs | Intentionally public low-risk provenance metadata by explicit owner decision; removed from current documentation and grants no access |
| External private deployment repository name | Historical refs and blobs | Intentionally public low-risk provenance metadata by explicit owner decision; removed from current documentation and grants no access |
| Shared editor configuration | 2 files | False positive; plugin settings only, with per-user state ignored |

All findings are explained. No candidate remains unclassified or uncertain.

## Negative results

No private keys, certificates, provider credentials, JWTs, real environment files,
session files, browser cookie stores, browser captures, databases, financial
exports, archives, build artifacts, logs, backup files, private network addresses,
machine-specific home paths, bank or routing numbers, full payment-card numbers,
or government identifiers were found.

## Remediation decision

- **Credential rotation or revocation:** None required. No confirmed or uncertain
  credential was found.
- **History rewrite:** Not required. The repository owner explicitly accepts the
  historical private-repository and package identifiers as intentionally public,
  low-risk provenance metadata. They grant no access and contain no credential or
  private financial record. Pull-request refs cannot be rewritten by the repository
  owner; a complete purge would require GitHub Support or publication through a
  fresh repository, adding destructive risk without reducing credential or
  financial-data exposure.
- **Remote-ref cleanup:** Not applicable because no history rewrite occurred.
- **Current-tree cleanup:** Private repository URLs and names, internal paths,
  issue references, and pinned revision details were removed from `README.md`,
  `docs/TYRION-UI-ARCHITECTURE-REVIEW.md`, and `deploy/homelab/README.md`.

## Ongoing controls

The repository already ignores real environment files, known Monarch session
material, browser captures, databases, private keys, certificates, and common
per-user editor state. Keep those ignore rules protected.

Before changing visibility, enable GitHub secret scanning and push protection when
the repository's GitHub plan supports them. Future release-readiness audits should
repeat the complete advertised-ref inventory, both pinned scanners, merge-only blob
extraction, and targeted checks described above.
