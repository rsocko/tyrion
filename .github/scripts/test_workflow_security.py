from __future__ import annotations

from pathlib import Path
import unittest

import check_workflow_security as policy


SAFE_PUBLICATION = """\
name: Publication disabled
on:
  workflow_dispatch:
permissions: {}
jobs:
  publication-disabled:
    if: ${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo disabled
"""

PINNED_CHECKOUT = "actions/checkout@1111111111111111111111111111111111111111"

SAFE_VALIDATION = """\
name: Validation
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: %s
        with:
          persist-credentials: false
      - run: echo validate
""" % PINNED_CHECKOUT


def synthetic_workflows(validation: str = SAFE_VALIDATION) -> dict[Path, str]:
    return {
        policy.PUBLICATION_WORKFLOW: SAFE_PUBLICATION,
        policy.WORKFLOW_DIRECTORY / "validation.yml": validation,
    }


class WorkflowSecurityPolicyTests(unittest.TestCase):
    def test_repository_workflows_satisfy_policy(self) -> None:
        self.assertEqual(policy.check_workflows(policy._workflow_texts()), [])

    def test_safe_synthetic_workflows_pass(self) -> None:
        self.assertEqual(policy.check_workflows(synthetic_workflows()), [])
        inline_runner = SAFE_VALIDATION.replace(
            "runs-on: ubuntu-latest", "runs-on: [ubuntu-latest]"
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(inline_runner)), [])
        block_runner = SAFE_VALIDATION.replace(
            "runs-on: ubuntu-latest", "runs-on:\n      - ubuntu-latest"
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(block_runner)), [])

    def test_event_name_does_not_expose_event_payload(self) -> None:
        event_conditional = SAFE_VALIDATION.replace(
            "steps:", "if: github.event_name == 'pull_request'\n    steps:"
        )
        self.assertEqual(
            policy.check_workflows(synthetic_workflows(event_conditional)), []
        )

    def test_untrusted_job_cannot_select_privileged_runner(self) -> None:
        for runner in (
            "[self-hosted, privileged]",
            "[ubuntu-latest, self-hosted]",
            "\n      - ubuntu-latest\n      - self-hosted",
        ):
            with self.subTest(runner=runner):
                workflows = synthetic_workflows(
                    SAFE_VALIDATION.replace("ubuntu-latest", runner)
                )
                self.assertTrue(policy.check_workflows(workflows))

    def test_mutable_action_reference_is_rejected(self) -> None:
        workflows = synthetic_workflows(
            SAFE_VALIDATION.replace(PINNED_CHECKOUT, "actions/checkout@v5")
        )
        self.assertTrue(policy.check_workflows(workflows))

    def test_credential_cache_and_privileged_trigger_paths_are_rejected(self) -> None:
        mutations = (
            "\n    secrets: inherit\n",
            "\n    permissions:\n      id-token: write\n",
            "\n      - uses: actions/cache@2222222222222222222222222222222222222222\n",
            "\nworkflow_run:\n",
            "\npull_request_target:\n",
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation.strip()):
                workflows = synthetic_workflows(SAFE_VALIDATION + mutation)
                self.assertTrue(policy.check_workflows(workflows))

    def test_publication_cannot_run_or_consume_automatic_content(self) -> None:
        for mutation in (
            SAFE_PUBLICATION.replace("if: ${{ false }}", "if: ${{ true }}"),
            SAFE_PUBLICATION + "\npush:\n",
            SAFE_PUBLICATION + "\n  - uses: actions/checkout@"
            "1111111111111111111111111111111111111111\n",
        ):
            with self.subTest():
                workflows = synthetic_workflows()
                workflows[policy.PUBLICATION_WORKFLOW] = mutation
                self.assertTrue(policy.check_workflows(workflows))


if __name__ == "__main__":
    unittest.main()
