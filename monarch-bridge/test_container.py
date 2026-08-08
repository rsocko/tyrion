"""Deterministic policy checks for the production container contract."""

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def read_repository_file(path: str) -> str:
    return (REPOSITORY_ROOT / path).read_text(encoding="utf-8")


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

    assert "USER tyrion" in dockerfile
    assert "TYRION_UID=10001" in dockerfile
    assert "SESSION_FILE=/var/lib/tyrion/monarch-session.json" in dockerfile
    assert 'VOLUME ["/var/lib/tyrion"]' in dockerfile
    assert "BRIDGE_HOST=0.0.0.0" in dockerfile
    assert "BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us" in dockerfile
    assert "BRIDGE_REMOTE_TLS=true" in dockerfile
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
    assert "registry.socko.us/tyrion" in publisher
    assert "tag=sha-$IMAGE_SHA" in publisher
    assert "Immutable image already exists; it will not be overwritten." in publisher
    assert "${{ env.REGISTRY_REPOSITORY }}:main" in publisher
    assert "${{ env.REGISTRY_REPOSITORY }}:latest" in publisher
