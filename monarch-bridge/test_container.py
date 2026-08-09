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
    assert "--index-url https://pypi.org/simple" in dockerfile
    assert "--require-hashes" in dockerfile
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
    runtime_env = {}
    for instruction in instructions[final_stage_start + 1:]:
        tokens = shlex.split(instruction)
        if tokens[0].upper() != "ENV":
            continue
        for assignment in tokens[1:]:
            name, separator, value = assignment.partition("=")
            if separator:
                runtime_env[name] = value

    assert "USER tyrion" in dockerfile
    assert "TYRION_UID=10001" in dockerfile
    assert runtime_env["SESSION_FILE"] == "/var/lib/tyrion/monarch-session.json"
    assert 'VOLUME ["/var/lib/tyrion"]' in dockerfile
    assert runtime_env["BRIDGE_HOST"] == "0.0.0.0"
    assert runtime_env["BRIDGE_ALLOWED_ORIGINS"] == "https://mc.socko.us"
    assert runtime_env["BRIDGE_REMOTE_TLS"] == "true"
    assert runtime_env["BRIDGE_LOAD_DOTENV"] == "false"
    assert runtime_env["DEFAULT_TRANSACTION_DAYS"] == "90"


def test_image_port_and_health_contract_are_stable():
    dockerfile = read_repository_file("Dockerfile")

    assert "BRIDGE_PORT=8100" in dockerfile
    assert "EXPOSE 8100" in dockerfile
    assert "http://127.0.0.1:8100/health" in dockerfile
    assert 'CMD ["python", "main.py"]' in dockerfile


def test_ui_image_is_standalone_non_root_and_contains_no_runtime_secret():
    dockerfile = read_repository_file("triage-app/Dockerfile")
    dockerignore = read_repository_file("triage-app/.dockerignore")
    next_config = read_repository_file("triage-app/next.config.mjs")

    assert (
        "node:20.19.4-bookworm-slim@sha256:"
        "6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be8f25f70a"
        in dockerfile
    )
    assert 'output: "standalone"' in next_config
    assert "USER tyrion" in dockerfile
    assert "TYRION_UID=10001" in dockerfile
    assert "EXPOSE 3000" in dockerfile
    assert "http://127.0.0.1:3000/api/health" in dockerfile
    assert 'CMD ["node", "server.js"]' in dockerfile
    assert (
        "COPY --from=dependencies /workspace/kid-engine /workspace/kid-engine"
        in dockerfile
    )
    assert (
        "COPY --from=domain-builder /workspace/kid-engine/node_modules "
        "/workspace/kid-engine/node_modules"
        in dockerfile
    )
    assert "BRIDGE_API_TOKEN" not in dockerfile
    for excluded in (".env", ".env.*", "node_modules", ".next", "test"):
        assert excluded in dockerignore


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


def test_images_include_repository_and_dependency_license_notices():
    bridge_dockerfile = read_repository_file("Dockerfile")
    ui_dockerfile = read_repository_file("triage-app/Dockerfile")
    bridge_dockerignore = read_repository_file(".dockerignore")

    notice_copy = (
        "COPY --chown=tyrion:tyrion LICENSE THIRD-PARTY-NOTICES.md /licenses/"
    )
    assert notice_copy in bridge_dockerfile
    assert notice_copy in ui_dockerfile
    assert "!LICENSE" in bridge_dockerignore
    assert "!THIRD-PARTY-NOTICES.md" in bridge_dockerignore


def test_workflows_keep_untrusted_validation_separate_and_publication_disabled():
    ci = read_repository_file(".github/workflows/ci.yml")
    publisher = read_repository_file(".github/workflows/build-and-push.yml")
    bridge_readme = read_repository_file("monarch-bridge/README.md")
    validation_guide = read_repository_file(
        "docs/MONARCH-INTEGRATION-VALIDATION.md"
    )

    assert "runs-on: ubuntu-latest" in ci
    assert "docker build --tag tyrion-bridge:ci ." in ci
    assert "docker build --file triage-app/Dockerfile --tag tyrion-ui:ci ." in ci
    assert "npm run build" in ci
    assert "npm test" in ci
    assert "push: true" not in ci
    assert "workflow_dispatch:" in publisher
    assert "permissions: {}" in publisher
    assert "if: ${{ false }}" in publisher
    assert "runs-on: ubuntu-latest" in publisher
    assert "uses:" not in publisher
    assert "self-hosted" not in publisher
    assert "workflow_run" not in publisher
    assert "pull_request" not in publisher
    assert "push:" not in publisher
    assert "secrets." not in publisher
    normalized_readme = " ".join(bridge_readme.split())
    normalized_validation = " ".join(validation_guide.split())
    assert (
        "CI builds both production containers without publishing them"
        in normalized_readme
    )
    assert (
        "Automated publication is disabled"
        in normalized_validation
    )
    assert (
        "`https://tyrion.socko.us`; the browser uses its allowlisted "
        "`/api/bridge/...` proxy"
        in normalized_readme
    )
    assert "BRIDGE_ALLOWED_ORIGINS" in normalized_readme
    assert "BRIDGE_ALLOWED_ORIGINS" in normalized_validation
    assert "`BRIDGE_REMOTE_TLS=true`" in normalized_readme
    assert "`BRIDGE_REMOTE_TLS=true`" in normalized_validation
    assert (
        "the only production ingress at `https://tyrion.socko.us`"
        in normalized_validation
    )


def test_homelab_contract_routes_only_ui_through_traefik():
    compose = read_repository_file("deploy/homelab/compose.yaml")
    environment = read_repository_file("deploy/homelab/.env.example")
    bridge_section, ui_section = compose.split("  tyrion-operations-ui:", 1)

    assert "${TYRION_BRIDGE_IMAGE:?" in bridge_section
    assert "${TYRION_UI_IMAGE:?" in ui_section
    assert "traefik" not in bridge_section
    assert "BRIDGE_URL: http://tyrion-monarch-bridge:8100" in ui_section
    assert "traefik.http.services.tyrion.loadbalancer.server.port=3000" in ui_section
    assert compose.count("read_only: true") == 2
    assert compose.count("user:") == 0
    assert "TYRION_BRIDGE_IMAGE_TAG=latest" in environment
    assert "TYRION_UI_IMAGE_TAG=latest" in environment
    environment_lines = environment.splitlines()
    for secret in (
        "BRIDGE_API_TOKEN",
        "TYRION_POLICY_AUTH_SECRET",
        "TYRION_INSTRUMENT_FINGERPRINT_KEY",
        "TYRION_REATTRIBUTION_TOKEN",
    ):
        assert f"{secret}=" in environment_lines
