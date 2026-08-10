from __future__ import annotations

from pathlib import Path
import unittest

import check_workflow_security as policy


PINNED_CHECKOUT = policy.PUBLICATION_CHECKOUT
PINNED_SETUP_NODE = "actions/setup-node@2222222222222222222222222222222222222222"

SAFE_PUBLICATION = """\
name: Publish production images
on:
  push:
    branches:
      - main
permissions:
  contents: read
  packages: write
jobs:
  publish:
    if: >-
      github.event_name == 'push' &&
      github.repository == 'rsocko/tyrion' &&
      github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout trusted default-branch commit
        uses: %s
        with:
          persist-credentials: false
      - name: Publish production images
        env:
          GHCR_TOKEN: ${{ github.token }}
          GITHUB_RUN_NUMBER: ${{ github.run_number }}
        run: python .github/scripts/publish_images.py
""" % PINNED_CHECKOUT

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
      - uses: %s
        with:
          node-version: "24"
          package-manager-cache: false
      - run: echo validate
""" % (PINNED_CHECKOUT, PINNED_SETUP_NODE)


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
        commented_pin = SAFE_VALIDATION.replace(
            PINNED_SETUP_NODE, f"{PINNED_SETUP_NODE} # v7.0.0"
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(commented_pin)), [])
        quoted_keys = SAFE_VALIDATION.replace("- uses:", '- "uses":').replace(
            "        with:", '        "with":'
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(quoted_keys)), [])
        quoted_false = SAFE_VALIDATION.replace(": false", ': "false"')
        self.assertEqual(policy.check_workflows(synthetic_workflows(quoted_false)), [])
        quoted_action_ref = SAFE_VALIDATION.replace(
            PINNED_CHECKOUT, f'"{PINNED_CHECKOUT}"'
        )
        self.assertEqual(
            policy.check_workflows(synthetic_workflows(quoted_action_ref)), []
        )

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
        for action_key in ("uses", "uses ", '"uses"'):
            with self.subTest(action_key=action_key):
                validation = SAFE_VALIDATION.replace(
                    PINNED_CHECKOUT, "actions/checkout@v5"
                ).replace("- uses:", f"- {action_key}:", 1)
                self.assertTrue(
                    policy.check_workflows(synthetic_workflows(validation))
                )

    def test_flow_style_action_reference_is_rejected(self) -> None:
        validation = SAFE_VALIDATION.replace(
            f"- uses: {PINNED_CHECKOUT}\n"
            "        with:\n"
            "          persist-credentials: false",
            f"- {{ uses: {PINNED_CHECKOUT}, "
            "with: { persist-credentials: false } }",
        )
        self.assertTrue(policy.check_workflows(synthetic_workflows(validation)))

    def test_checkout_must_explicitly_disable_credential_persistence(self) -> None:
        mutations = (
            SAFE_VALIDATION.replace("          persist-credentials: false\n", ""),
            SAFE_VALIDATION.replace(
                "persist-credentials: false", "persist-credentials: true"
            ),
            SAFE_VALIDATION.replace(
                "persist-credentials: false",
                "persist-credentials: false\n          persist-credentials: true",
            ),
            SAFE_VALIDATION.replace(
                "        with:\n          persist-credentials: false",
                "        env:\n          persist-credentials: false",
            ),
            SAFE_VALIDATION.replace(
                "- uses:", '- "uses":', 1
            ).replace("          persist-credentials: false\n", ""),
            SAFE_VALIDATION.replace(
                "        with:\n          persist-credentials: false",
                "        env: |\n          with:\n"
                "            persist-credentials: false",
            ),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.assertTrue(policy.check_workflows(synthetic_workflows(mutation)))

    def test_setup_node_must_explicitly_disable_automatic_caching(self) -> None:
        mutations = (
            SAFE_VALIDATION.replace("          package-manager-cache: false\n", ""),
            SAFE_VALIDATION.replace(
                "package-manager-cache: false", "package-manager-cache: true"
            ),
            SAFE_VALIDATION.replace(
                "package-manager-cache: false",
                "package-manager-cache: false\n          package-manager-cache: true",
            ),
            SAFE_VALIDATION.replace(
                '        with:\n          node-version: "24"\n'
                "          package-manager-cache: false",
                "        env:\n          package-manager-cache: false\n"
                '        with:\n          node-version: "24"',
            ),
            SAFE_VALIDATION.replace(
                "actions/setup-node", "Actions/Setup-Node"
            ).replace("          package-manager-cache: false\n", ""),
            SAFE_VALIDATION.replace(
                "- uses: " + PINNED_SETUP_NODE,
                '- "uses": ' + PINNED_SETUP_NODE,
            ).replace("          package-manager-cache: false\n", ""),
            SAFE_VALIDATION.replace(
                '        with:\n          node-version: "24"\n'
                "          package-manager-cache: false",
                "        env: |\n          with:\n"
                "            package-manager-cache: false",
            ),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.assertTrue(policy.check_workflows(synthetic_workflows(mutation)))

    def test_explicit_action_cache_configuration_is_rejected(self) -> None:
        for cache_key in (
            "cache: npm",
            '"cache": npm',
            "cache-from: type=gha",
            "cache-to: type=gha",
        ):
            with self.subTest(cache_key=cache_key):
                validation = SAFE_VALIDATION.replace(
                    '          node-version: "24"',
                    f'          node-version: "24"\n          {cache_key}',
                )
                self.assertTrue(policy.check_workflows(synthetic_workflows(validation)))

    def test_unrelated_cache_named_environment_value_is_allowed(self) -> None:
        validation = SAFE_VALIDATION.replace(
            "    steps:", "    env:\n      cache: npm\n    steps:"
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(validation)), [])

    def test_uses_text_in_an_unrelated_scalar_is_allowed(self) -> None:
        validation = SAFE_VALIDATION.replace(
            "- run: echo validate", "- run: echo uses:"
        )
        self.assertEqual(policy.check_workflows(synthetic_workflows(validation)), [])

    def test_cache_and_artifact_text_in_a_script_is_not_configuration(self) -> None:
        scripts = (
            "- run: echo actions/cache",
            "- run: echo actions/upload-artifact",
            "- run: echo cache-from:",
            "- run: |\n"
            "          echo actions/cache\n"
            "          echo actions/upload-artifact\n"
            "          echo cache-from:\n"
            "          echo cache-to:",
        )
        for script in scripts:
            with self.subTest(script=script):
                validation = SAFE_VALIDATION.replace(
                    "- run: echo validate", script
                )
                self.assertEqual(
                    policy.check_workflows(synthetic_workflows(validation)), []
                )

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

    def test_publication_rejects_untrusted_triggers_and_refs(self) -> None:
        for mutation in (
            SAFE_PUBLICATION.replace(
                "  push:\n    branches:\n      - main",
                "  workflow_dispatch:",
            ),
            SAFE_PUBLICATION.replace("      - main", "      - feature"),
            SAFE_PUBLICATION.replace(
                "  push:\n    branches:\n      - main",
                "  pull_request:\n  push:\n    branches:\n      - main",
            ),
            SAFE_PUBLICATION.replace(
                "      github.event_name == 'push' &&\n", ""
            ),
            SAFE_PUBLICATION.replace(
                "      github.repository == 'rsocko/tyrion' &&\n", ""
            ),
            SAFE_PUBLICATION.replace(
                "      github.ref == 'refs/heads/main'", "      github.ref == 'main'"
            ),
        ):
            with self.subTest(mutation=mutation):
                workflows = synthetic_workflows()
                workflows[policy.PUBLICATION_WORKFLOW] = mutation
                self.assertTrue(policy.check_workflows(workflows))

    def test_publication_privilege_is_exact_and_publisher_only(self) -> None:
        publisher_mutations = (
            SAFE_PUBLICATION.replace("  packages: write\n", ""),
            SAFE_PUBLICATION.replace(
                "  packages: write", "  packages: write\n  attestations: write"
            ),
            SAFE_PUBLICATION.replace(
                "GHCR_TOKEN: ${{ github.token }}",
                "GHCR_TOKEN: ${{ secrets.REGISTRY_PASSWORD }}",
            ),
            SAFE_PUBLICATION.replace(
                "    steps:", "    permissions:\n      packages: write\n    steps:"
            ),
        )
        for mutation in publisher_mutations:
            with self.subTest(mutation=mutation):
                workflows = synthetic_workflows()
                workflows[policy.PUBLICATION_WORKFLOW] = mutation
                self.assertTrue(policy.check_workflows(workflows))

    def test_publication_cannot_add_inert_or_unreviewed_commands(self) -> None:
        for mutation in (
            SAFE_PUBLICATION.replace(
                "run: python .github/scripts/publish_images.py",
                "run: echo python .github/scripts/publish_images.py",
            ),
            SAFE_PUBLICATION.replace(
                "run: python .github/scripts/publish_images.py",
                "run: python .github/scripts/publish_images.py\n"
                "      - run: docker build .",
            ),
            SAFE_PUBLICATION.replace(
                "      - name: Publish production images",
                "      - uses: ./.github/actions/unreviewed\n"
                "      - name: Publish production images",
            ),
            SAFE_PUBLICATION.replace(
                PINNED_CHECKOUT,
                "attacker/rewrite-workspace@"
                "3d3c42e5aac5ba805825da76410c181273ba90b1",
            ),
            SAFE_PUBLICATION.replace(
                PINNED_CHECKOUT,
                "actions/checkout@1111111111111111111111111111111111111111",
            ),
            SAFE_PUBLICATION.replace(
                "        run: python .github/scripts/publish_images.py",
                "        working-directory: .github\n"
                "        run: python .github/scripts/publish_images.py",
            ),
            SAFE_PUBLICATION.replace(
                "          GHCR_TOKEN: ${{ github.token }}",
                "          GHCR_TOKEN: ${{ github.token }}\n"
                "          EXTRA_VALUE: unreviewed",
            ),
            SAFE_PUBLICATION.replace(
                "          GITHUB_RUN_NUMBER: ${{ github.run_number }}",
                "          GITHUB_RUN_NUMBER: ${{ github.event.number }}",
            ),
            SAFE_PUBLICATION.replace(
                "          persist-credentials: false",
                "          persist-credentials: false\n"
                "          fetch-depth: 0",
            ),
        ):
            with self.subTest(mutation=mutation):
                workflows = synthetic_workflows()
                workflows[policy.PUBLICATION_WORKFLOW] = mutation
                self.assertTrue(policy.check_workflows(workflows))

        validation_mutations = (
            SAFE_VALIDATION.replace(
                "  contents: read", "  contents: read\n  packages: write"
            ),
            SAFE_VALIDATION.replace(
                "- run: echo validate",
                "- env:\n          TOKEN: ${{ github.token }}\n"
                "        run: echo validate",
            ),
            SAFE_VALIDATION.replace(
                "  contents: read", "  contents: read\n  issues: write"
            ),
        )
        for mutation in validation_mutations:
            with self.subTest(mutation=mutation):
                self.assertTrue(
                    policy.check_workflows(synthetic_workflows(mutation))
                )


if __name__ == "__main__":
    unittest.main()
