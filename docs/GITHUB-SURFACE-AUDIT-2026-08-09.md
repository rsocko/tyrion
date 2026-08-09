# GitHub Surface Security Audit

**Date:** 2026-08-09
**Repository:** `rsocko/tyrion`
**Issue:** [#104](https://github.com/rsocko/tyrion/issues/104)
**Status:** In progress; GitHub Packages and the repository retention setting still
require owner-level follow-up described below.

This report is intentionally redacted. It records coverage, aggregate counts, and
dispositions without preserving candidate values, raw logs, artifact contents,
private repository names, private network details, or machine-specific paths.

## Initial inventory

Counts are from the pre-remediation snapshot. Actions counts changed while the audit
was running; the final complete snapshot contained 118 runs and 13 unexpired
artifacts.

| Surface | Count and disposition |
| --- | --- |
| Actions workflow runs | 118; all deleted |
| Accessible Actions logs | 109 scanned; the other 9 had no downloadable log at scan time |
| Unexpired Actions artifacts | 13 archives, 104 files; all scanned and deleted |
| Actions caches | 9; all deleted |
| Releases and release assets | 0 releases, 0 assets |
| Issues and pull requests | 81 issues, 22 pull requests |
| Issue comments | 54 |
| Pull-request reviews and review comments | 0 reviews, 0 review comments |
| GitHub-hosted attachments | 0 |
| Issue and pull-request timeline events | 334, including 33 cross-references |
| Projects and discussions | 0 projects, 0 discussions |
| Wiki | Disabled |
| Deployments and environments | 0 deployments, 0 environments |
| Commit statuses | 0 across 85 API-enumerated commits |
| Repository webhooks | 1 active hook; TLS verification enabled and no private-network target |
| Branches, tags, milestones, and labels | 20 branches, 0 tags, 0 milestones, 17 labels |

Ten timeline cross-references originate from private repositories. GitHub
permission-gates those events and does not expose their source details to users who
cannot read the source repository.

## Actions review and remediation

Every downloadable log was checked for private keys, authorization values,
credential assignments, JWTs, private-network addresses, machine-specific home or
runner paths, environment files, and reusable session-material names. The only log
candidate was the generic GitHub-hosted `/home/runner` path. The completed
self-hosted workflow logs did not contain a user home or runner-install path.

All 13 artifact archives were downloaded to unique temporary storage, expanded,
scanned, and removed locally. Thirty-two of 104 files contained environment-file,
private-network, or reusable-session-material references. No private-key,
authorization-value, credential-assignment, or JWT pattern was found. Because the
artifacts and run history were nonessential, all 118 runs, 13 artifacts, and 9
caches were deleted rather than retaining or reproducing the candidate material.
Post-deletion API counts were zero for all three surfaces.

No credential rotation was indicated by the scan. If a later source establishes
that any deleted artifact contained a live credential rather than a reference,
that credential must still be revoked because deletion does not invalidate it.

The baseline guard now detects any `actions/upload-artifact` reference in a
repository workflow. Checkout steps also disable credential persistence. Because
the repository does not currently enforce required checks on its default branch,
this is a review signal rather than a preventive control: a workflow could upload
an artifact before the concurrent guard fails. Any future artifact use requires an
explicit policy change and security review rather than inheriting GitHub's default
retention.

## Collaboration review and remediation

Issue, pull-request, comment, review, and review-comment text was scanned using the
same targeted rules. One pull-request body mentions two reusable-session filenames;
it contains no session contents, credential assignment, authorization value,
private key, or JWT and is retained as an explained false positive.

Fourteen distinct external GitHub repository targets appeared in collaboration
text. Seven were not accessible through the audit identity. Eight links or names in
two issue bodies were replaced with a redacted predecessor-repository marker.
The follow-up scan found zero collaboration records containing an inaccessible
repository link. No GitHub-hosted attachment was present.

## Remaining owner follow-up

The current GitHub token does not have the `read:packages` scope, so it cannot
enumerate repository-linked GitHub Packages or their versions. An owner must grant
that read scope, inventory package visibility and versions, scan downloadable
package metadata where applicable, and delete unnecessary packages before this
audit can be closed.

GitHub does not expose the repository's **Artifact and log retention** setting
through the repository data returned to this audit identity. In **Settings >
Actions > General**, set the shortest supported retention period appropriate for
this repository and record the selected value on issue #104. The workflow guard
continues to detect artifact-upload references regardless of that setting.

The default branch has no branch protection or ruleset requiring the baseline
guard. Before changing visibility, enforce the baseline guard as a required check
so the policy cannot be bypassed by merging a failing workflow change.

## Current conclusion

The scanned Actions and collaboration surfaces have zero unexplained findings.
Releases, assets, attachments, wiki, projects, discussions, deployments,
environments, and commit statuses have no retained content to remediate. Issue
#104 remains open for the GitHub Packages inventory, confirmation of the
repository-level retention value, and enforcement of the baseline guard.
