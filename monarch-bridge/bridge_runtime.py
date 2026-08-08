"""Security configuration and bridge-owned Monarch session lifecycle."""

from __future__ import annotations

import asyncio
import getpass
import hmac
import ipaddress
import logging
import os
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Optional


class AuthState(str, Enum):
    UNAUTHENTICATED = "unauthenticated"
    CONNECTED = "connected"
    EXPIRED = "expired"
    DEGRADED = "degraded"


class UpstreamFailure(str, Enum):
    INVALID_CREDENTIALS = "invalid_credentials"
    MFA_REQUIRED = "mfa_required"
    INVALID_MFA = "invalid_mfa"
    CAPTCHA_REQUIRED = "captcha_required"
    EXPIRED = "expired"
    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    MALFORMED = "malformed"
    UNKNOWN = "unknown"


class SessionInUseError(RuntimeError):
    pass


class InvalidSessionError(RuntimeError):
    pass


def _default_session_file() -> Path:
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.getenv("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return base / "Tyrion" / "monarch-bridge" / "session.json"


def _is_loopback(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class BridgeSettings:
    host: str
    port: int
    api_token: Optional[str]
    allowed_origins: tuple[str, ...]
    session_file: Path
    remote_tls: bool
    max_auth_body_bytes: int

    @property
    def is_loopback(self) -> bool:
        return _is_loopback(self.host)

    @property
    def requires_service_auth(self) -> bool:
        return not self.is_loopback

    @classmethod
    def from_env(cls) -> "BridgeSettings":
        origins = tuple(
            value.strip()
            for value in os.getenv(
                "BRIDGE_ALLOWED_ORIGINS",
                "http://localhost:3000,http://127.0.0.1:3000",
            ).split(",")
            if value.strip()
        )
        settings = cls(
            host=os.getenv("BRIDGE_HOST", "127.0.0.1"),
            port=int(os.getenv("BRIDGE_PORT", "8100")),
            api_token=os.getenv("BRIDGE_API_TOKEN") or None,
            allowed_origins=origins,
            session_file=Path(
                os.getenv("SESSION_FILE", str(_default_session_file()))
            ).expanduser().resolve(),
            remote_tls=os.getenv("BRIDGE_REMOTE_TLS", "").lower() in ("1", "true", "yes"),
            max_auth_body_bytes=int(os.getenv("BRIDGE_MAX_AUTH_BODY_BYTES", "16384")),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.max_auth_body_bytes < 1024 or self.max_auth_body_bytes > 65536:
            raise RuntimeError("BRIDGE_MAX_AUTH_BODY_BYTES must be between 1024 and 65536")
        if self.requires_service_auth:
            if not self.api_token or len(self.api_token) < 32:
                raise RuntimeError(
                    "Non-loopback binding requires BRIDGE_API_TOKEN with at least 32 characters"
                )
            if not self.remote_tls:
                raise RuntimeError(
                    "Non-loopback binding requires TLS termination and BRIDGE_REMOTE_TLS=true"
                )

    def request_requires_service_auth(self, client_host: Optional[str]) -> bool:
        return self.requires_service_auth or bool(
            client_host and not _is_loopback(client_host)
        )

    def authorizes(
        self,
        authorization: Optional[str],
        bridge_token: Optional[str],
        *,
        required: Optional[bool] = None,
    ) -> bool:
        if required is None:
            required = self.requires_service_auth
        if not required:
            return True
        candidate = bridge_token or ""
        if authorization and authorization.startswith("Bearer "):
            candidate = authorization[7:]
        return bool(
            self.api_token
            and candidate
            and hmac.compare_digest(candidate, self.api_token)
        )


_SENSITIVE_PATTERNS = (
    re.compile(r"(?i)(authorization|cookie|password|mfa(?:code)?|token)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"(?i)(session_id|csrftoken)=[^;\s]+"),
)


def redact(value: object) -> str:
    text = str(value)
    for pattern in _SENSITIVE_PATTERNS:
        text = pattern.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


def classify_failure(exc: Exception, *, login_flow: bool = False) -> UpstreamFailure:
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    combined = f"{name} {message}"
    if "captcha" in combined:
        return UpstreamFailure.CAPTCHA_REQUIRED
    if "requiremfa" in combined or any(
        marker in combined
        for marker in ("mfa required", "multi-factor required", "two-factor required")
    ):
        return UpstreamFailure.MFA_REQUIRED
    if any(marker in combined for marker in ("invalid mfa", "invalid code", "expired code")):
        return UpstreamFailure.INVALID_MFA
    if any(marker in combined for marker in ("timeout", "timed out")):
        return UpstreamFailure.TIMEOUT
    if any(marker in combined for marker in ("rate limit", "too many requests", "429")):
        return UpstreamFailure.RATE_LIMITED
    if any(marker in combined for marker in ("malformed", "decode", "invalid response")):
        return UpstreamFailure.MALFORMED
    if login_flow and any(
        marker in combined
        for marker in (
            "loginfailedexception",
            "invalid credentials",
            "incorrect password",
            "unauthorized",
            "401",
        )
    ):
        return UpstreamFailure.INVALID_CREDENTIALS
    if any(
        marker in combined
        for marker in ("expired", "unauthorized", "not authenticated", "401")
    ):
        return UpstreamFailure.EXPIRED
    return UpstreamFailure.UNKNOWN


def _repository_root(path: Path) -> Optional[Path]:
    for parent in (path, *path.parents):
        if (parent / ".git").exists():
            return parent
    return None


def ensure_external_session_path(path: Path) -> None:
    repository = _repository_root(path.parent)
    if repository is not None:
        raise RuntimeError("SESSION_FILE must be outside a Git repository")


def _restrict_permissions(path: Path, *, directory: bool = False) -> None:
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
    mode = stat.S_IRWXU if directory else stat.S_IRUSR | stat.S_IWUSR
    os.chmod(path, mode)


def atomic_save_session(client: object, path: Path) -> None:
    ensure_external_session_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _restrict_permissions(path.parent, directory=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".session-",
        suffix=".tmp",
        dir=path.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        client.save_session(str(temporary))
        _restrict_permissions(temporary)
        with temporary.open("r+b") as session:
            session.flush()
            os.fsync(session.fileno())
        os.replace(temporary, path)
        _restrict_permissions(path)
    finally:
        temporary.unlink(missing_ok=True)


class _SessionLease:
    def __init__(self, session_path: Path):
        self.path = session_path.with_suffix(".lock")
        self.handle = None

    def acquire(self) -> None:
        if self.handle is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _restrict_permissions(self.path.parent, directory=True)
        handle = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            _restrict_permissions(self.path)
        except (OSError, subprocess.CalledProcessError) as exc:
            handle.close()
            raise SessionInUseError(
                "Another bridge process owns the Monarch session"
            ) from exc
        self.handle = handle

    def release(self) -> None:
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None
            self.path.unlink(missing_ok=True)


class SessionManager:
    def __init__(self, path: Path):
        ensure_external_session_path(path)
        self.path = path
        self.client: Optional[object] = None
        self.state = AuthState.DEGRADED if path.exists() else AuthState.UNAUTHENTICATED
        self.email: Optional[str] = None
        self._lock = asyncio.Lock()
        self._lease = _SessionLease(path)

    async def get_client(self, factory: Callable[[], object]) -> object:
        async with self._lock:
            if self.client is None:
                if not self.path.exists():
                    self.state = AuthState.UNAUTHENTICATED
                    raise FileNotFoundError("No bridge-managed session is available")
                self._lease.acquire()
                try:
                    if not self.path.exists():
                        self.state = AuthState.UNAUTHENTICATED
                        raise FileNotFoundError(
                            "No bridge-managed session is available"
                        )
                    client = factory()
                    try:
                        client.load_session(str(self.path))
                    except Exception as exc:
                        self.path.unlink(missing_ok=True)
                        self.state = AuthState.EXPIRED
                        raise InvalidSessionError(
                            "The bridge-managed session could not be loaded"
                        ) from exc
                except Exception:
                    self._lease.release()
                    raise
                self.client = client
                self.state = AuthState.DEGRADED
            return self.client

    async def verify(self, factory: Callable[[], object]) -> AuthState:
        if self.state == AuthState.EXPIRED and not self.path.exists():
            return self.state
        try:
            client = await self.get_client(factory)
            await client.get_accounts()
        except FileNotFoundError:
            self.state = AuthState.UNAUTHENTICATED
        except InvalidSessionError:
            self.state = AuthState.EXPIRED
        except Exception as exc:
            if classify_failure(exc) == UpstreamFailure.EXPIRED:
                self.clear(AuthState.EXPIRED)
            else:
                self.state = AuthState.DEGRADED
        else:
            self.state = AuthState.CONNECTED
        return self.state

    def establish(self, client: object, email: Optional[str] = None) -> None:
        self._lease.acquire()
        atomic_save_session(client, self.path)
        self.client = client
        self.email = email
        self.state = AuthState.CONNECTED

    def clear(self, state: AuthState = AuthState.UNAUTHENTICATED) -> None:
        self._lease.acquire()
        self.client = None
        self.email = None
        self.path.unlink(missing_ok=True)
        self.state = state
        self._lease.release()

    def release(self) -> None:
        self.client = None
        self.email = None
        self._lease.release()
