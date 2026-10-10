"""External restart cursor and singleton lease for receipt recovery."""

from __future__ import annotations

import getpass
import json
import os
import stat
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import IO, Literal


class RecoveryBusyError(RuntimeError):
    pass


@dataclass(frozen=True)
class RecoveryCheckpoint:
    schema_version: Literal[1] = 1
    source: Literal["upload", "email"] = "upload"
    resume_after: str | None = None

    @classmethod
    def parse(cls, payload: object) -> RecoveryCheckpoint:
        if not isinstance(payload, dict) or set(payload) != {
            "schema_version",
            "source",
            "resume_after",
        }:
            raise ValueError("recovery checkpoint is invalid")
        if payload["schema_version"] != 1:
            raise ValueError("recovery checkpoint version is invalid")
        source = payload["source"]
        resume_after = payload["resume_after"]
        if source not in {"upload", "email"}:
            raise ValueError("recovery checkpoint source is invalid")
        if resume_after is not None and (
            not isinstance(resume_after, str)
            or len(resume_after) != 64
            or any(character not in "0123456789abcdef" for character in resume_after)
        ):
            raise ValueError("recovery checkpoint cursor is invalid")
        return cls(source=source, resume_after=resume_after)


class RecoveryState:
    def __init__(self, path: Path):
        self.path = path
        self.lock_path = path.with_suffix(path.suffix + ".lock")
        self._lock_handle: IO[bytes] | None = None
        ensure_external_path(path)

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _restrict(self.path.parent, directory=True)
        handle = self.lock_path.open("a+b")
        try:
            if self.lock_path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            _restrict(self.lock_path)
        except (OSError, subprocess.CalledProcessError) as exc:
            handle.close()
            raise RecoveryBusyError("receipt recovery is already running") from exc
        self._lock_handle = handle

    def release(self) -> None:
        if self._lock_handle is None:
            return
        try:
            self._lock_handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._lock_handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._lock_handle.close()
            self._lock_handle = None

    def load(self) -> RecoveryCheckpoint:
        if not self.path.exists():
            return RecoveryCheckpoint()
        return RecoveryCheckpoint.parse(
            json.loads(self.path.read_text(encoding="utf-8"))
        )

    def save(self, checkpoint: RecoveryCheckpoint) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".recovery-checkpoint-",
            suffix=".tmp",
            dir=self.path.parent,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(
                    asdict(checkpoint),
                    output,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                output.flush()
                os.fsync(output.fileno())
            _restrict(temporary)
            os.replace(temporary, self.path)
            _restrict(self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


def ensure_external_path(path: Path) -> None:
    for parent in (path.parent, *path.parent.parents):
        if (parent / ".git").exists():
            raise ValueError("recovery state must be outside a Git repository")


def _restrict(path: Path, *, directory: bool = False) -> None:
    if os.name == "nt":
        permission = "(OI)(CI)F" if directory else "F"
        subprocess.run(
            [
                "icacls",
                str(path),
                "/inheritance:r",
                "/grant:r",
                f"{getpass.getuser()}:{permission}",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return
    os.chmod(
        path,
        stat.S_IRWXU if directory else stat.S_IRUSR | stat.S_IWUSR,
    )
