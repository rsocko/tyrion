from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Protocol


BRIDGE_IMAGE = "ghcr.io/rsocko/tyrion-bridge"
UI_IMAGE = "ghcr.io/rsocko/tyrion-ui"
EXPECTED_REPOSITORY = "rsocko/tyrion"
EXPECTED_REF = "refs/heads/main"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
MISSING_MANIFEST_MARKERS = ("manifest unknown", "name unknown", "not found")


class PublicationError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class PublicationResult:
    sha: str
    bridge_digest: str
    ui_digest: str
    promoted: bool


class CommandRunner(Protocol):
    def __call__(
        self,
        command: Sequence[str],
        *,
        input_text: str | None = None,
        capture_output: bool = False,
        check: bool = True,
    ) -> CommandResult: ...


def run_command(
    command: Sequence[str],
    *,
    input_text: str | None = None,
    capture_output: bool = False,
    check: bool = True,
) -> CommandResult:
    child_environment = dict(os.environ)
    child_environment.pop("GHCR_TOKEN", None)
    completed = subprocess.run(
        list(command),
        env=child_environment,
        input=input_text,
        capture_output=capture_output,
        check=check,
        text=True,
    )
    return CommandResult(
        returncode=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
    )


def required_environment(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "")
    if not value:
        raise PublicationError(f"Required workflow context is missing: {name}")
    return value


def verify_context(
    environment: Mapping[str, str], runner: CommandRunner
) -> tuple[str, str, str]:
    if required_environment(environment, "GITHUB_EVENT_NAME") != "push":
        raise PublicationError("Publication requires a push event")
    if required_environment(environment, "GITHUB_REPOSITORY") != EXPECTED_REPOSITORY:
        raise PublicationError("Publication requires the canonical repository")
    if required_environment(environment, "GITHUB_REF") != EXPECTED_REF:
        raise PublicationError("Publication requires refs/heads/main")

    sha = required_environment(environment, "GITHUB_SHA")
    if not SHA_PATTERN.fullmatch(sha):
        raise PublicationError("Publication requires a full Git commit ID")

    checkout = runner(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
    ).stdout.strip()
    if checkout != sha:
        raise PublicationError("Checked-out commit does not match the workflow commit")

    actor = required_environment(environment, "GITHUB_ACTOR")
    token = required_environment(environment, "GHCR_TOKEN")
    return sha, actor, token


def inspect_digest(reference: str, runner: CommandRunner) -> str:
    result = runner(
        [
            "docker",
            "buildx",
            "imagetools",
            "inspect",
            reference,
            "--format",
            "{{json .Manifest.Digest}}",
        ],
        capture_output=True,
    )
    digest = result.stdout.strip().strip('"')
    if not DIGEST_PATTERN.fullmatch(digest):
        raise PublicationError("Registry returned an invalid image digest")
    return digest


def existing_commit_digest(
    reference: str,
    expected_revision: str,
    runner: CommandRunner,
) -> str | None:
    result = runner(
        [
            "docker",
            "buildx",
            "imagetools",
            "inspect",
            reference,
            "--format",
            "{{json .Manifest.Digest}}",
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        digest = result.stdout.strip().strip('"')
        if not DIGEST_PATTERN.fullmatch(digest):
            raise PublicationError("Registry returned an invalid image digest")
        image_result = runner(
            [
                "docker",
                "buildx",
                "imagetools",
                "inspect",
                reference,
                "--format",
                "{{json .Image}}",
            ],
            capture_output=True,
        )
        try:
            image = json.loads(image_result.stdout)
            labels = image["config"]["Labels"]
            revision = labels["org.opencontainers.image.revision"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise PublicationError(
                "Existing commit tag has no verifiable OCI revision"
            ) from error
        if revision != expected_revision:
            raise PublicationError(
                "Existing commit tag revision does not match the workflow commit"
            )
        return digest

    error = f"{result.stdout}\n{result.stderr}".lower()
    if not any(marker in error for marker in MISSING_MANIFEST_MARKERS):
        raise PublicationError("Unable to verify that the commit tag is unused")
    return None


def build_and_push(
    image: str,
    dockerfile: str,
    sha: str,
    runner: CommandRunner,
) -> str:
    commit_reference = f"{image}:sha-{sha}"
    runner(
        [
            "docker",
            "build",
            "--pull",
            "--file",
            dockerfile,
            "--build-arg",
            f"TYRION_REVISION={sha}",
            "--tag",
            commit_reference,
            ".",
        ]
    )
    runner(["docker", "push", commit_reference])
    return inspect_digest(commit_reference, runner)


def promote_and_verify(
    image: str,
    digest: str,
    runner: CommandRunner,
) -> None:
    source = f"{image}@{digest}"
    moving_references = (f"{image}:main", f"{image}:latest")
    runner(
        [
            "docker",
            "buildx",
            "imagetools",
            "create",
            "--prefer-index=false",
            "--tag",
            moving_references[0],
            "--tag",
            moving_references[1],
            source,
        ]
    )
    for reference in moving_references:
        if inspect_digest(reference, runner) != digest:
            raise PublicationError(
                f"Promoted tag does not match its immutable digest: {reference}"
            )


def publish(
    environment: Mapping[str, str],
    runner: CommandRunner = run_command,
) -> PublicationResult:
    sha, actor, token = verify_context(environment, runner)
    bridge_commit = f"{BRIDGE_IMAGE}:sha-{sha}"
    ui_commit = f"{UI_IMAGE}:sha-{sha}"
    logged_in = False

    try:
        runner(
            [
                "docker",
                "login",
                "ghcr.io",
                "--username",
                actor,
                "--password-stdin",
            ],
            input_text=f"{token}\n",
        )
        logged_in = True

        bridge_digest = existing_commit_digest(bridge_commit, sha, runner)
        ui_digest = existing_commit_digest(ui_commit, sha, runner)

        if bridge_digest is None:
            bridge_digest = build_and_push(BRIDGE_IMAGE, "Dockerfile", sha, runner)
        if ui_digest is None:
            ui_digest = build_and_push(UI_IMAGE, "triage-app/Dockerfile", sha, runner)

        remote_main = runner(
            ["git", "ls-remote", "origin", EXPECTED_REF],
            capture_output=True,
        ).stdout.split()
        if len(remote_main) != 2 or not SHA_PATTERN.fullmatch(remote_main[0]):
            raise PublicationError("Unable to resolve the remote main commit")

        promoted = remote_main[0] == sha
        if promoted:
            promote_and_verify(BRIDGE_IMAGE, bridge_digest, runner)
            promote_and_verify(UI_IMAGE, ui_digest, runner)

        return PublicationResult(
            sha=sha,
            bridge_digest=bridge_digest,
            ui_digest=ui_digest,
            promoted=promoted,
        )
    finally:
        if logged_in:
            runner(["docker", "logout", "ghcr.io"], check=False)


def append_line(path: str, lines: Sequence[str]) -> None:
    with Path(path).open("a", encoding="utf-8", newline="\n") as stream:
        for line in lines:
            stream.write(f"{line}\n")


def record_result(result: PublicationResult, environment: Mapping[str, str]) -> None:
    output_path = required_environment(environment, "GITHUB_OUTPUT")
    summary_path = required_environment(environment, "GITHUB_STEP_SUMMARY")
    append_line(
        output_path,
        (
            f"bridge_digest={result.bridge_digest}",
            f"ui_digest={result.ui_digest}",
            f"promoted={str(result.promoted).lower()}",
        ),
    )

    promotion_summary = (
        "`main` and `latest` now reference these same digests."
        if result.promoted
        else "`main` and `latest` were not changed because `main` advanced."
    )
    append_line(
        summary_path,
        (
            "### Published production images",
            "",
            f"- `{BRIDGE_IMAGE}:sha-{result.sha}`",
            f"- `{BRIDGE_IMAGE}@{result.bridge_digest}`",
            f"- `{UI_IMAGE}:sha-{result.sha}`",
            f"- `{UI_IMAGE}@{result.ui_digest}`",
            "",
            promotion_summary,
        ),
    )


def main() -> int:
    try:
        result = publish(os.environ)
        record_result(result, os.environ)
    except PublicationError as error:
        print(f"Publication failed: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError:
        print("Publication command failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
