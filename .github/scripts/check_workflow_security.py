from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIRECTORY = ROOT / ".github" / "workflows"
PUBLICATION_WORKFLOW = WORKFLOW_DIRECTORY / "build-and-push.yml"

ANY_ACTION = re.compile(r"^\s*(?:-\s*)?uses:\s*(?P<value>\S+)", re.MULTILINE)
PRIVILEGED_TOKENS = (
    "self-hosted",
    "pull_request_target",
    "workflow_run",
    "repository_dispatch",
    "workflow_call",
    "secrets.",
    "secrets: inherit",
    "github.token",
    "github.event.",
    "ref: ${{",
    "id-token: write",
    "contents: write",
    "packages: write",
    "environment:",
    "actions/cache",
    "actions/upload-artifact",
    "actions/download-artifact",
    "cache:",
    "cache-from:",
    "cache-to:",
)


def _workflow_texts() -> dict[Path, str]:
    return {
        path: path.read_text(encoding="utf-8")
        for path in sorted(WORKFLOW_DIRECTORY.glob("*.y*ml"))
    }


def _runner_specs(text: str) -> list[list[str]]:
    lines = text.splitlines()
    specs: list[list[str]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^(?P<indent> *)runs-on:\s*(?P<value>.*)$", line)
        if not match:
            continue

        value = match.group("value").strip()
        if value:
            if value.startswith("[") and value.endswith("]"):
                specs.append(
                    [item.strip() for item in value[1:-1].split(",") if item.strip()]
                )
            else:
                specs.append([value])
            continue

        indent = len(match.group("indent"))
        items: list[str] = []
        for following in lines[index + 1 :]:
            if not following.strip():
                continue
            following_indent = len(following) - len(following.lstrip(" "))
            if following_indent <= indent:
                break
            item = re.match(r"^\s*-\s*(\S+)\s*$", following)
            if not item:
                break
            items.append(item.group(1))
        specs.append(items)
    return specs


def check_workflows(workflows: dict[Path, str]) -> list[str]:
    failures: list[str] = []

    for path, text in workflows.items():
        relative = path.relative_to(ROOT)
        if not re.search(r"(?m)^permissions:\s*(?:\{\})?\s*$", text):
            failures.append(f"{relative}: missing top-level permissions boundary")

        for match in ANY_ACTION.finditer(text):
            use = match.group("value")
            if use.startswith("./"):
                continue
            _, separator, ref = use.rpartition("@")
            if separator != "@" or not re.fullmatch(r"[0-9a-f]{40}", ref):
                failures.append(
                    f"{relative}: action is not pinned to an immutable commit"
                )

        lowered = text.lower()
        for token in PRIVILEGED_TOKENS:
            if token in lowered:
                failures.append(
                    f"{relative}: prohibited privileged workflow token: {token}"
                )

        for runners in _runner_specs(text):
            if len(runners) != 1 or not re.fullmatch(
                r"ubuntu-\d+\.\d+|ubuntu-latest", runners[0]
            ):
                failures.append(
                    f"{relative}: jobs must use a GitHub-hosted Ubuntu runner"
                )

    publication = workflows.get(PUBLICATION_WORKFLOW, "")
    required_publication_fragments = (
        "workflow_dispatch:",
        "permissions: {}",
        "if: ${{ false }}",
        "runs-on: ubuntu-latest",
    )
    for fragment in required_publication_fragments:
        if fragment not in publication:
            failures.append(
                "publication workflow is not an inert, hosted-runner-only placeholder"
            )
            break

    if "uses:" in publication or re.search(r"(?m)^\s*(push|pull_request):", publication):
        failures.append("publication workflow can consume repository content automatically")

    return failures


def main() -> int:
    failures = check_workflows(_workflow_texts())
    if failures:
        print("\n".join(failures))
        return 1

    print("Workflow security policy checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
