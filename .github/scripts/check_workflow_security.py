from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIRECTORY = ROOT / ".github" / "workflows"
PUBLICATION_WORKFLOW = WORKFLOW_DIRECTORY / "build-and-push.yml"

ANY_ACTION = re.compile(
    r"^(?P<indent> *)(?P<item>-\s*)?(?P<quote>['\"]?)uses(?P=quote)"
    r"\s*:\s*(?P<value>\S+)",
    re.MULTILINE,
)
NONCANONICAL_ACTION_SYNTAX = re.compile(
    r"(?m)^(?:"
    r" *(?:- *)?\{[^\r\n]*['\"]?uses['\"]? *:|"
    r" *- *\? *['\"]?uses['\"]? *$|"
    r" *steps *: *\S"
    r")"
)
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
)
PROHIBITED_ACTIONS = {
    "actions/cache",
    "actions/upload-artifact",
    "actions/download-artifact",
}
PROHIBITED_ACTION_INPUT = re.compile(
    r"^\s*['\"]?(?P<key>cache-from|cache-to)['\"]?\s*:\s*"
    r"(?P<value>\S+)\s*(?:#.*)?$",
    re.MULTILINE,
)
BLOCK_SCALAR = re.compile(r":\s*[|>][1-9+-]*\s*(?:#.*)?$")
ACTION_CACHE = re.compile(
    r"^\s*['\"]?cache['\"]?\s*:\s*(?P<value>\S+)\s*(?:#.*)?$",
    re.MULTILINE,
)
PACKAGE_MANAGER_CACHE = re.compile(
    r"^\s*['\"]?package-manager-cache['\"]?\s*:\s*"
    r"(?P<value>\S+)\s*(?:#.*)?$",
    re.MULTILINE,
)
PERSIST_CREDENTIALS = re.compile(
    r"^\s*['\"]?persist-credentials['\"]?\s*:\s*"
    r"(?P<value>\S+)\s*(?:#.*)?$",
    re.MULTILINE,
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


def _action_step_body(text: str, match: re.Match[str]) -> str:
    line_end = text.find("\n", match.end())
    if line_end == -1:
        return ""
    lines = text[line_end + 1 :].splitlines()
    use_indent = len(match.group("indent"))
    body: list[str] = []

    for line in lines:
        if not line.strip():
            body.append(line)
            continue

        indent = len(line) - len(line.lstrip(" "))
        if indent < use_indent:
            break
        if match.group("item") and indent == use_indent and line.lstrip().startswith("- "):
            break
        body.append(line)

    return "\n".join(body)


def _mask_block_scalars(text: str) -> str:
    masked: list[str] = []
    scalar_indent: int | None = None

    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        ending = line[len(content) :]
        indent = len(content) - len(content.lstrip(" "))

        if scalar_indent is not None:
            if not content.strip() or indent > scalar_indent:
                masked.append(" " * len(content) + ending)
                continue
            scalar_indent = None

        if BLOCK_SCALAR.search(content):
            scalar_indent = indent
        masked.append(line)

    return "".join(masked)


def _strip_yaml_comments(text: str) -> str:
    stripped: list[str] = []
    for line in text.splitlines():
        single_quoted = False
        double_quoted = False
        escaped = False
        content: list[str] = []
        for character in line:
            if character == "#" and not single_quoted and not double_quoted:
                break
            content.append(character)
            if character == "\\" and double_quoted:
                escaped = not escaped
                continue
            if character == "'" and not double_quoted:
                single_quoted = not single_quoted
            elif character == '"' and not single_quoted and not escaped:
                double_quoted = not double_quoted
            escaped = False
        stripped.append("".join(content))
    return "\n".join(stripped)


def _normalized_scalar(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value.lower()


def _mapping_blocks(text: str, key: str, expected_indent: int) -> list[str]:
    lines = text.splitlines()
    blocks: list[str] = []
    key_pattern = re.compile(
        rf"^ {{{expected_indent}}}['\"]?{re.escape(key)}['\"]?\s*:\s*(?:#.*)?$"
    )

    for index, line in enumerate(lines):
        match = key_pattern.match(line)
        if not match:
            continue

        block: list[str] = []
        for following in lines[index + 1 :]:
            if not following.strip():
                block.append(following)
                continue
            indent = len(following) - len(following.lstrip(" "))
            if indent <= expected_indent:
                break
            block.append(following)
        blocks.append("\n".join(block))

    return blocks


def _normalized_values(pattern: re.Pattern[str], blocks: list[str]) -> list[str]:
    values: list[str] = []
    for block in blocks:
        for match in pattern.finditer(block):
            values.append(_normalized_scalar(match.group("value")))
    return values


def check_workflows(workflows: dict[Path, str]) -> list[str]:
    failures: list[str] = []

    for path, text in workflows.items():
        relative = path.relative_to(ROOT)
        structural_text = _mask_block_scalars(text)
        if not re.search(r"(?m)^permissions:\s*(?:\{\})?\s*$", text):
            failures.append(f"{relative}: missing top-level permissions boundary")

        action_matches = list(ANY_ACTION.finditer(structural_text))
        if NONCANONICAL_ACTION_SYNTAX.search(
            _strip_yaml_comments(structural_text)
        ):
            failures.append(
                f"{relative}: action references must use canonical block syntax"
            )

        for match in action_matches:
            use = _normalized_scalar(match.group("value"))
            if use.startswith("./"):
                continue
            action, separator, ref = use.rpartition("@")
            if separator != "@" or not re.fullmatch(r"[0-9a-f]{40}", ref):
                failures.append(
                    f"{relative}: action is not pinned to an immutable commit"
                )
            action_name = action.lower()
            use_indent = len(match.group("indent"))
            with_indent = use_indent + 2 if match.group("item") else use_indent
            with_blocks = _mapping_blocks(
                _action_step_body(structural_text, match), "with", with_indent
            )
            if action_name in PROHIBITED_ACTIONS:
                failures.append(
                    f"{relative}: prohibited privileged workflow action: {action_name}"
                )
            if _normalized_values(ACTION_CACHE, with_blocks):
                failures.append(
                    f"{relative}: prohibited privileged workflow token: cache:"
                )
            if _normalized_values(PROHIBITED_ACTION_INPUT, with_blocks):
                failures.append(
                    f"{relative}: prohibited privileged workflow cache input"
                )
            if action_name == "actions/checkout":
                credential_values = _normalized_values(
                    PERSIST_CREDENTIALS, with_blocks
                )
                if credential_values != ["false"]:
                    failures.append(
                        f"{relative}: checkout must explicitly disable "
                        "credential persistence"
                    )
            if action_name == "actions/setup-node":
                cache_values = _normalized_values(PACKAGE_MANAGER_CACHE, with_blocks)
                if cache_values != ["false"]:
                    failures.append(
                        f"{relative}: setup-node must explicitly disable "
                        "package-manager caching"
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
