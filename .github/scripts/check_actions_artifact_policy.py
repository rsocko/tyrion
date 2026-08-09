from pathlib import Path
import re
import sys


UPLOAD_ACTION = re.compile(r"actions/upload-artifact@", re.IGNORECASE)


def main() -> int:
    workflow_directory = Path(__file__).resolve().parents[1] / "workflows"
    violations = [
        workflow.relative_to(workflow_directory.parent.parent)
        for workflow in sorted(workflow_directory.glob("*.y*ml"))
        if UPLOAD_ACTION.search(workflow.read_text(encoding="utf-8"))
    ]
    if violations:
        print(
            "Actions artifact upload references require an explicit "
            "public-readiness policy change.",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
