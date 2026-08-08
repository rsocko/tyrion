"""Deterministic policy checks for the production container contract."""

import shlex
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def read_repository_file(path: str) -> str:
    return (REPOSITORY_ROOT / path).read_text(encoding="utf-8")


def dockerfile_instructions(dockerfile: str) -> list[str]:
    instructions = []
    parts = []
    for raw_line in dockerfile.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        continued = line.endswith("\\")
        parts.append(line[:-1].rstrip() if continued else line)
        if not continued:
            instructions.append(" ".join(parts))
            parts = []
    assert not parts
    return instructions


def test_image_contains_only_runtime_bridge_dependencies():
    dockerfile = read_repository_file("Dockerfile")
    requirements = read_repository_file(
        "monarch-bridge/requirements-runtime.txt"
    ).lower()

    assert "requirements-runtime.txt" in dockerfile
    assert dockerfile.count("python:3.12.11-slim-bookworm@sha256:") == 2
    assert "requirements.txt" not in dockerfile.replace(
        "requirements-runtime.txt", ""
    )
    assert "pytest" not in requirements
    assert "test_" not in dockerfile
    assert "triage-app" not in dockerfile


def test_image_runs_non_root_with_external_session_storage():
    dockerfile = read_repository_file("Dockerfile")
    instructions = dockerfile_instructions(dockerfile)
    final_stage_start = max(
        index
        for index, instruction in enumerate(instructions)
        if shlex.split(instruction)[0].upper() == "FROM"
    )
    session_values = []
    for instruction in instructions[final_stage_start + 1:]:
        tokens = shlex.split(instruction)
        if tokens[0].upper() != "ENV":
            continue
        for assignment in tokens[1:]:
            name, separator, value = assignment.partition("=")
            if separator and name == "SESSION_FILE":
                session_values.append(value)

    assert "USER tyrion" in dockerfile
    assert "TYRION_UID=10001" in dockerfile
    assert session_values == ["/var/lib/tyrion/monarch-session.json"]
    assert 'VOLUME ["/var/lib/tyrion"]' in dockerfile
    assert "BRIDGE_HOST=0.0.0.0" in dockerfile
    assert "BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us" in dockerfile
    assert "BRIDGE_REMOTE_TLS=" not in dockerfile
    assert "BRIDGE_LOAD_DOTENV=false" in dockerfile
    assert "DEFAULT_TRANSACTION_DAYS=90" in dockerfile


def test_image_port_and_health_contract_are_stable():
    dockerfile = read_repository_file("Dockerfile")

    assert "BRIDGE_PORT=8100" in dockerfile
    assert "EXPOSE 8100" in dockerfile
    assert "http://127.0.0.1:8100/health" in dockerfile
    assert 'CMD ["python", "main.py"]' in dockerfile


def test_build_context_excludes_sensitive_and_non_runtime_content():
    dockerignore = read_repository_file(".dockerignore")

    for excluded in (
        "**/.env",
        "**/.mm",
        "**/monarch-session.json",
        "**/*.key",
        "**/*.pem",
        ".git",
        "triage-app",
        "monarch-bridge/test*.py",
    ):
        assert excluded in dockerignore


def test_workflows_separate_untrusted_validation_from_trusted_publish():
    ci = read_repository_file(".github/workflows/ci.yml")
    publisher = read_repository_file(".github/workflows/build-and-push.yml")
    bridge_readme = read_repository_file("monarch-bridge/README.md")
    validation_guide = read_repository_file(
        "docs/MONARCH-INTEGRATION-VALIDATION.md"
    )

    assert "runs-on: ubuntu-latest" in ci
    assert "docker build --tag tyrion:ci ." in ci
    assert "push: true" not in ci
    assert (
        "runs-on: [self-hosted, linux, docker, build, homelab, dockhand]"
        in publisher
    )
    assert "github.event.workflow_run.event == 'push'" in publisher
    assert (
        "github.event.workflow_run.head_repository.full_name == github.repository"
        in publisher
    )
    assert "group: build-and-push-tyrion" in publisher
    assert publisher.count("REGISTRY_REPOSITORY:") == 1
    assert "REGISTRY_REPOSITORY: registry.socko.us/tyrion" in publisher
    assert "tag=sha-$IMAGE_SHA" in publisher
    assert "Immutable image already exists; it will not be overwritten." in publisher
    logical_lines = []
    logical_parts = []
    for raw_line in publisher.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        continued = line.endswith("\\")
        logical_parts.append(line[:-1].rstrip() if continued else line)
        if not continued:
            logical_lines.append(" ".join(logical_parts))
            logical_parts = []
    assert not logical_parts

    commands = []
    for logical_line in logical_lines:
        tokens = shlex.split(logical_line, comments=True)
        for index in range(len(tokens) - 3):
            if tokens[index:index + 4] == [
                "docker",
                "buildx",
                "imagetools",
                "create",
            ]:
                commands.append(tokens[index:])

    assert len(commands) == 1
    moving_tags = []
    for command in commands:
        for index, argument in enumerate(command):
            if argument in ("--tag", "-t"):
                moving_tags.append(command[index + 1])
            elif argument.startswith("--tag=") or argument.startswith("-t="):
                moving_tags.append(argument.split("=", 1)[1])
            elif argument.startswith("-t") and len(argument) > 2:
                moving_tags.append(argument[2:])
    assert moving_tags == [
        "${{ env.REGISTRY_REPOSITORY }}:main",
        "${{ env.REGISTRY_REPOSITORY }}:latest",
    ]
    assert commands[0][-1] == (
        "${{ env.REGISTRY_REPOSITORY }}:${{ steps.image.outputs.tag }}"
    )
    assert publisher.count(
        "if: steps.current.outputs.publish == 'true'"
    ) == 1
    normalized_readme = " ".join(bridge_readme.split())
    normalized_validation = " ".join(validation_guide.split())
    assert (
        "publishes an immutable `sha-<full-commit>` tag and moves both "
        "`main` and `latest`"
        in normalized_readme
    )
    assert (
        "publishes `sha-<full-commit>`, `main`, and `latest` from the trusted "
        "homelab builder. Existing SHA tags are never overwritten, and "
        "moving-tag promotion is serialized"
        in normalized_validation
    )
    assert (
        "private Traefik route at `https://tyrion.socko.us`"
        in normalized_readme
    )
    assert (
        "`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`"
        in normalized_readme
    )
    assert (
        "`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`"
        in normalized_validation
    )
    assert (
        "`https://tyrion.socko.us` is the only production ingress"
        in normalized_validation
    )
