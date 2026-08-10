from __future__ import annotations

from collections.abc import Sequence
import json
import os
import unittest
from unittest import mock

import publish_images as publisher


SHA = "1" * 40
NEWER_SHA = "2" * 40
BRIDGE_DIGEST = f"sha256:{'a' * 64}"
UI_DIGEST = f"sha256:{'b' * 64}"
BUILD_NUMBER = "1234"


def workflow_environment(**overrides: str) -> dict[str, str]:
    environment = {
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_REPOSITORY": "rsocko/tyrion",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": SHA,
        "GITHUB_RUN_NUMBER": BUILD_NUMBER,
        "GITHUB_ACTOR": "publisher",
        "GHCR_TOKEN": "short-lived-test-token",
    }
    environment.update(overrides)
    return environment


class FakeRunner:
    def __init__(
        self,
        *,
        remote_sha: str = SHA,
        existing_reference: str | None = None,
        existing_references: set[str] | None = None,
        existing_revision: str = SHA,
        mismatched_promotion: str | None = None,
    ) -> None:
        self.remote_sha = remote_sha
        self.existing_references = existing_references or set()
        if existing_reference is not None:
            self.existing_references.add(existing_reference)
        self.existing_revision = existing_revision
        self.mismatched_promotion = mismatched_promotion
        self.commands: list[tuple[str, ...]] = []
        self.inputs: list[str | None] = []
        self.pushed: set[str] = set()

    def __call__(
        self,
        command: Sequence[str],
        *,
        input_text: str | None = None,
        capture_output: bool = False,
        check: bool = True,
    ) -> publisher.CommandResult:
        del capture_output, check
        invocation = tuple(command)
        self.commands.append(invocation)
        self.inputs.append(input_text)

        if invocation == ("git", "rev-parse", "HEAD"):
            return publisher.CommandResult(0, f"{SHA}\n")
        if invocation == (
            "git",
            "ls-remote",
            "origin",
            publisher.EXPECTED_REF,
        ):
            return publisher.CommandResult(
                0, f"{self.remote_sha}\t{publisher.EXPECTED_REF}\n"
            )
        if invocation[:2] == ("docker", "push"):
            self.pushed.add(invocation[2])
            return publisher.CommandResult(0)
        if invocation[:4] == (
            "docker",
            "buildx",
            "imagetools",
            "inspect",
        ):
            reference = invocation[4]
            output_format = invocation[6]
            if reference in self.existing_references:
                if output_format == "{{json .Image}}":
                    return publisher.CommandResult(
                        0,
                        json.dumps(
                            {
                                "config": {
                                    "Labels": {
                                        "org.opencontainers.image.revision": (
                                            self.existing_revision
                                        )
                                    }
                                }
                            }
                        ),
                    )
                digest = (
                    BRIDGE_DIGEST
                    if reference.startswith(publisher.BRIDGE_IMAGE)
                    else UI_DIGEST
                )
                return publisher.CommandResult(0, f'"{digest}"\n')
            if ":sha-" in reference and reference not in self.pushed:
                return publisher.CommandResult(1, stderr="manifest unknown")
            digest = (
                BRIDGE_DIGEST
                if reference.startswith(publisher.BRIDGE_IMAGE)
                else UI_DIGEST
            )
            if reference == self.mismatched_promotion:
                digest = f"sha256:{'c' * 64}"
            return publisher.CommandResult(0, f'"{digest}"\n')
        return publisher.CommandResult(0)


class PublishImagesTests(unittest.TestCase):
    def test_builds_once_then_promotes_exact_digests(self) -> None:
        runner = FakeRunner()

        result = publisher.publish(workflow_environment(), runner)

        self.assertEqual(result.bridge_digest, BRIDGE_DIGEST)
        self.assertEqual(result.ui_digest, UI_DIGEST)
        self.assertEqual(result.build_number, BUILD_NUMBER)
        self.assertTrue(result.promoted)

        builds = [command for command in runner.commands if command[:2] == ("docker", "build")]
        pushes = [command for command in runner.commands if command[:2] == ("docker", "push")]
        promotions = [
            command
            for command in runner.commands
            if command[:4] == ("docker", "buildx", "imagetools", "create")
        ]
        self.assertEqual(len(builds), 2)
        self.assertEqual(len(pushes), 2)
        self.assertEqual(len(promotions), 4)
        self.assertTrue(all("--prefer-index=false" in command for command in promotions))
        expected_references = {
            publisher.BRIDGE_IMAGE: {
                f"{publisher.BRIDGE_IMAGE}:sha-{SHA}",
                f"{publisher.BRIDGE_IMAGE}:build-{BUILD_NUMBER}",
                f"{publisher.BRIDGE_IMAGE}:main",
                f"{publisher.BRIDGE_IMAGE}:latest",
            },
            publisher.UI_IMAGE: {
                f"{publisher.UI_IMAGE}:sha-{SHA}",
                f"{publisher.UI_IMAGE}:build-{BUILD_NUMBER}",
                f"{publisher.UI_IMAGE}:main",
                f"{publisher.UI_IMAGE}:latest",
            },
        }
        published_references = {image: set() for image in expected_references}
        for push in pushes:
            reference = push[2]
            image = (
                publisher.BRIDGE_IMAGE
                if reference.startswith(publisher.BRIDGE_IMAGE)
                else publisher.UI_IMAGE
            )
            published_references[image].add(reference)
        for promotion in promotions:
            source = promotion[-1]
            image, expected_digest = (
                (publisher.BRIDGE_IMAGE, BRIDGE_DIGEST)
                if source.startswith(publisher.BRIDGE_IMAGE)
                else (publisher.UI_IMAGE, UI_DIGEST)
            )
            self.assertEqual(source, f"{image}@{expected_digest}")
            published_references[image].update(
                promotion[index + 1]
                for index, value in enumerate(promotion)
                if value == "--tag"
            )
        self.assertEqual(published_references, expected_references)
        self.assertLess(
            max(runner.commands.index(command) for command in pushes),
            min(runner.commands.index(command) for command in promotions),
        )
        self.assertEqual(runner.commands[-1], ("docker", "logout", "ghcr.io"))

        login_index = runner.commands.index(
            (
                "docker",
                "login",
                "ghcr.io",
                "--username",
                "publisher",
                "--password-stdin",
            )
        )
        self.assertNotIn("short-lived-test-token", runner.commands[login_index])
        self.assertEqual(runner.inputs[login_index], "short-lived-test-token\n")

    def test_stale_run_keeps_immutable_images_without_promotion(self) -> None:
        runner = FakeRunner(remote_sha=NEWER_SHA)

        result = publisher.publish(workflow_environment(), runner)

        self.assertFalse(result.promoted)
        promotions = [
            command
            for command in runner.commands
            if command[:4] == ("docker", "buildx", "imagetools", "create")
        ]
        self.assertEqual(len(promotions), 2)
        self.assertTrue(
            all(
                any(value.endswith(f":build-{BUILD_NUMBER}") for value in command)
                for command in promotions
            )
        )
        self.assertTrue(
            all(
                not any(value.endswith((":main", ":latest")) for value in command)
                for command in promotions
            )
        )

    def test_partial_publication_reuses_verified_tag_and_builds_missing_image(self) -> None:
        bridge_reference = f"{publisher.BRIDGE_IMAGE}:sha-{SHA}"
        runner = FakeRunner(existing_reference=bridge_reference)

        result = publisher.publish(workflow_environment(), runner)

        self.assertEqual(result.bridge_digest, BRIDGE_DIGEST)
        builds = [
            command for command in runner.commands if command[:2] == ("docker", "build")
        ]
        self.assertEqual(len(builds), 1)
        self.assertIn("triage-app/Dockerfile", builds[0])
        self.assertFalse(
            any(bridge_reference in command for command in builds)
        )

    def test_complete_publication_rerun_reuses_both_tags_without_rebuild(self) -> None:
        runner = FakeRunner(
            existing_references={
                f"{publisher.BRIDGE_IMAGE}:sha-{SHA}",
                f"{publisher.UI_IMAGE}:sha-{SHA}",
            }
        )

        result = publisher.publish(workflow_environment(), runner)

        self.assertTrue(result.promoted)
        self.assertFalse(
            any(command[:2] == ("docker", "build") for command in runner.commands)
        )

    def test_existing_commit_tag_requires_matching_oci_revision(self) -> None:
        reference = f"{publisher.BRIDGE_IMAGE}:sha-{SHA}"
        runner = FakeRunner(
            existing_reference=reference,
            existing_revision=NEWER_SHA,
        )

        with self.assertRaisesRegex(publisher.PublicationError, "does not match"):
            publisher.publish(workflow_environment(), runner)

        self.assertFalse(
            any(command[:2] == ("docker", "build") for command in runner.commands)
        )

    def test_unexpected_tag_lookup_failure_is_fail_closed(self) -> None:
        class FailedLookupRunner(FakeRunner):
            def __call__(self, command: Sequence[str], **kwargs: object) -> publisher.CommandResult:
                if tuple(command[:4]) == (
                    "docker",
                    "buildx",
                    "imagetools",
                    "inspect",
                ):
                    return publisher.CommandResult(1, stderr="temporary registry failure")
                return super().__call__(command, **kwargs)

        runner = FailedLookupRunner()
        with self.assertRaisesRegex(publisher.PublicationError, "Unable to verify"):
            publisher.publish(workflow_environment(), runner)

    def test_promoted_digest_mismatch_fails(self) -> None:
        runner = FakeRunner(
            mismatched_promotion=f"{publisher.BRIDGE_IMAGE}:latest"
        )

        with self.assertRaisesRegex(
            publisher.PublicationError, "does not match"
        ):
            publisher.publish(workflow_environment(), runner)

    def test_rejects_untrusted_workflow_context(self) -> None:
        invalid_environments = (
            workflow_environment(GITHUB_EVENT_NAME="workflow_dispatch"),
            workflow_environment(GITHUB_REPOSITORY="other/repository"),
            workflow_environment(GITHUB_REF="refs/heads/feature"),
            workflow_environment(GITHUB_SHA="short"),
        )
        for environment in invalid_environments:
            with self.subTest(environment=environment):
                runner = FakeRunner()
                with self.assertRaises(publisher.PublicationError):
                    publisher.publish(environment, runner)
                self.assertFalse(
                    any(command[0] == "docker" for command in runner.commands)
                )

    def test_rejects_malformed_or_unbounded_run_numbers(self) -> None:
        invalid_run_numbers = (
            "",
            "0",
            "-1",
            "+1",
            "01",
            "1.0",
            " 1",
            "1 ",
            "build-1",
            str(publisher.MAX_RUN_NUMBER + 1),
        )
        for run_number in invalid_run_numbers:
            with self.subTest(run_number=run_number):
                runner = FakeRunner()
                with self.assertRaisesRegex(
                    publisher.PublicationError,
                    "bounded positive workflow run number|context is missing",
                ):
                    publisher.publish(
                        workflow_environment(GITHUB_RUN_NUMBER=run_number),
                        runner,
                    )
                self.assertFalse(
                    any(command[0] == "docker" for command in runner.commands)
                )

    def test_accepts_maximum_bounded_run_number(self) -> None:
        runner = FakeRunner()

        result = publisher.publish(
            workflow_environment(
                GITHUB_RUN_NUMBER=str(publisher.MAX_RUN_NUMBER),
            ),
            runner,
        )

        self.assertEqual(result.build_number, str(publisher.MAX_RUN_NUMBER))
        self.assertTrue(
            any(
                f"{publisher.BRIDGE_IMAGE}:build-{publisher.MAX_RUN_NUMBER}" in command
                for command in runner.commands
            )
        )

    def test_summary_records_build_tag_and_manifest_digests(self) -> None:
        result = publisher.PublicationResult(
            sha=SHA,
            build_number=BUILD_NUMBER,
            bridge_digest=BRIDGE_DIGEST,
            ui_digest=UI_DIGEST,
            promoted=True,
        )
        files: dict[str, list[str]] = {}

        def capture(path: str, lines: Sequence[str]) -> None:
            files[path] = list(lines)

        with mock.patch("publish_images.append_line", side_effect=capture):
            publisher.record_result(
                result,
                {
                    "GITHUB_OUTPUT": "output",
                    "GITHUB_STEP_SUMMARY": "summary",
                },
            )

        self.assertIn(f"build_number={BUILD_NUMBER}", files["output"])
        summary = "\n".join(files["summary"])
        self.assertIn(
            f"{publisher.BRIDGE_IMAGE}:build-{BUILD_NUMBER}", summary
        )
        self.assertIn(f"{publisher.BRIDGE_IMAGE}@{BRIDGE_DIGEST}", summary)
        self.assertIn(f"{publisher.UI_IMAGE}:build-{BUILD_NUMBER}", summary)
        self.assertIn(f"{publisher.UI_IMAGE}@{UI_DIGEST}", summary)
        self.assertIn("`main`, and `latest`", summary)

    def test_real_command_runner_removes_token_from_child_environment(self) -> None:
        subprocess_result = mock.Mock(
            returncode=0,
            stdout="",
            stderr="",
        )
        with mock.patch.dict(
            os.environ,
            {"GHCR_TOKEN": "short-lived-test-token", "SAFE_VALUE": "retained"},
            clear=True,
        ), mock.patch(
            "publish_images.subprocess.run",
            return_value=subprocess_result,
        ) as run:
            publisher.run_command(["example"], input_text="token-through-stdin")

        self.assertNotIn("GHCR_TOKEN", run.call_args.kwargs["env"])
        self.assertEqual(run.call_args.kwargs["env"]["SAFE_VALUE"], "retained")
        self.assertEqual(run.call_args.kwargs["input"], "token-through-stdin")


if __name__ == "__main__":
    unittest.main()
