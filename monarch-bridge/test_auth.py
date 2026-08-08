"""Deterministic bridge authentication and session security contracts."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

import main as main_module
from bridge_runtime import AuthState, BridgeSettings, SessionInUseError, SessionManager


class RequireMFAException(Exception):
    pass


def saved_client() -> MagicMock:
    client = MagicMock()
    client.login = AsyncMock()
    client.multi_factor_authenticate = AsyncMock()
    client.login_with_cookies = AsyncMock()
    client.get_accounts = AsyncMock(return_value={"accounts": []})
    client.save_session.side_effect = lambda filename: Path(filename).write_text(
        '{"testSession":"opaque"}',
        encoding="utf-8",
    )
    return client


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def live_client(tmp_path, monkeypatch):
    manager = SessionManager(tmp_path / "state" / "session.json")
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "session_manager", manager)
    transport = ASGITransport(app=main_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.mark.anyio
async def test_auth_login_success_persists_bridge_owned_session(
    live_client,
    monkeypatch,
):
    provider = saved_client()
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.post(
        "/auth/login",
        json={"email": "person@example.test", "password": "not-a-real-password"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert main_module.session_manager.state == AuthState.CONNECTED
    assert main_module.session_manager.path.exists()
    provider.login.assert_awaited_once_with(
        "person@example.test",
        "not-a-real-password",
        use_saved_session=False,
        save_session=False,
    )


@pytest.mark.anyio
async def test_auth_login_completes_mfa(live_client, monkeypatch):
    provider = saved_client()
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.post(
        "/auth/login",
        json={
            "email": "person@example.test",
            "password": "not-a-real-password",
            "mfaCode": "123456",
        },
    )

    assert response.status_code == 200
    provider.multi_factor_authenticate.assert_awaited_once()
    assert main_module.session_manager.path.exists()


@pytest.mark.anyio
async def test_cookie_login_success_uses_same_session_store(live_client, monkeypatch):
    provider = saved_client()
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.post(
        "/auth/login-with-cookies",
        json={"cookies": "opaque-cookie=synthetic-value"},
    )

    assert response.status_code == 200
    provider.login_with_cookies.assert_awaited_once_with(
        "opaque-cookie=synthetic-value",
        save_session=False,
    )
    assert main_module.session_manager.path.exists()


@pytest.mark.anyio
async def test_cookie_login_rejects_incomplete_header(live_client):
    response = await live_client.post(
        "/auth/login-with-cookies",
        json={"cookies": "not-a-cookie-header"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("failure", "status", "code"),
    [
        (Exception("Invalid credentials"), 401, "invalid_credentials"),
        (RequireMFAException("MFA required"), 403, "mfa_required"),
        (Exception("Invalid MFA code"), 401, "invalid_mfa"),
        (Exception("CAPTCHA required"), 403, "captcha_required"),
        (TimeoutError("upstream timed out"), 504, "upstream_timeout"),
        (Exception("429 rate limit"), 429, "upstream_rate_limited"),
        (Exception("provider failed token=must-not-leak"), 502, "login_failed"),
    ],
)
async def test_auth_login_failures_are_stable_and_sanitized(
    live_client,
    monkeypatch,
    failure,
    status,
    code,
):
    provider = saved_client()
    provider.login.side_effect = failure
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.post(
        "/auth/login",
        json={"email": "person@example.test", "password": "not-a-real-password"},
    )

    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert "must-not-leak" not in response.text
    assert response.status_code != 500


@pytest.mark.anyio
async def test_cookie_failure_never_returns_cookie_or_upstream_error(
    live_client,
    monkeypatch,
    caplog,
):
    provider = saved_client()
    session_cookie_name = "session" + "_id"
    csrf_cookie_name = "csrf" + "token"
    provider.login_with_cookies.side_effect = Exception(
        f"rejected {session_cookie_name}=private-value; {csrf_cookie_name}=private-value"
    )
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.post(
        "/auth/login-with-cookies",
        json={"cookies": f"{session_cookie_name}=input-value; {csrf_cookie_name}=input-value"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "cookie_login_failed"
    assert "private-value" not in response.text
    assert "private-value" not in caplog.text
    assert "input-value" not in caplog.text


@pytest.mark.anyio
async def test_saved_session_reuse_after_restart(live_client, monkeypatch):
    original = saved_client()
    main_module.session_manager.establish(original)
    main_module.session_manager.release()
    restarted = SessionManager(main_module.session_manager.path)
    loaded = saved_client()
    monkeypatch.setattr(main_module, "session_manager", restarted)
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: loaded)

    response = await live_client.get("/auth/status")

    assert response.status_code == 200
    assert response.json()["authState"] == "connected"
    loaded.load_session.assert_called_once_with(str(restarted.path))
    loaded.get_accounts.assert_awaited_once()


@pytest.mark.anyio
async def test_missing_session_is_unauthenticated(live_client):
    response = await live_client.get("/auth/status")

    assert response.status_code == 200
    assert response.json()["authState"] == "unauthenticated"
    assert response.json()["authenticated"] is False


@pytest.mark.anyio
async def test_expired_session_is_removed(live_client, monkeypatch):
    provider = saved_client()
    main_module.session_manager.establish(provider)
    provider.get_accounts.side_effect = Exception("401 session expired")
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.get("/auth/status")

    assert response.status_code == 200
    assert response.json()["authState"] == "expired"
    assert response.json()["authenticated"] is False
    assert not main_module.session_manager.path.exists()


@pytest.mark.anyio
async def test_transient_failure_marks_session_degraded_without_deleting_it(
    live_client,
    monkeypatch,
):
    provider = saved_client()
    main_module.session_manager.establish(provider)
    provider.get_accounts.side_effect = TimeoutError("timed out")
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.get("/auth/status")

    assert response.status_code == 200
    assert response.json()["authState"] == "degraded"
    assert main_module.session_manager.path.exists()


@pytest.mark.anyio
async def test_logout_clears_memory_and_persisted_session(live_client):
    provider = saved_client()
    main_module.session_manager.establish(provider)

    response = await live_client.post("/auth/logout")

    assert response.status_code == 200
    assert main_module.session_manager.client is None
    assert main_module.session_manager.state == AuthState.UNAUTHENTICATED
    assert not main_module.session_manager.path.exists()


def test_second_process_cannot_load_or_delete_owned_session(tmp_path):
    path = tmp_path / "state" / "session.json"
    owner = SessionManager(path)
    owner.establish(saved_client())
    contender = SessionManager(path)

    with pytest.raises(SessionInUseError):
        contender.clear()
    assert path.exists()

    owner.clear()
    contender.clear()
    assert not path.exists()


@pytest.mark.anyio
async def test_missing_session_check_does_not_block_another_process_login(tmp_path):
    path = tmp_path / "state" / "session.json"
    observer = SessionManager(path)
    owner = SessionManager(path)

    with pytest.raises(FileNotFoundError):
        await observer.get_client(saved_client)

    owner.establish(saved_client())
    assert path.exists()
    owner.clear()


@pytest.mark.anyio
async def test_unreadable_session_is_removed_before_lease_release(
    live_client,
    monkeypatch,
):
    path = main_module.session_manager.path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"synthetic":"invalid"}', encoding="utf-8")
    provider = saved_client()
    provider.load_session.side_effect = ValueError("malformed session")
    monkeypatch.setattr(main_module, "create_monarch_client", lambda: provider)

    response = await live_client.get("/accounts")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "session_expired"
    assert not path.exists()

    status = await live_client.get("/auth/status")
    assert status.status_code == 200
    assert status.json()["authState"] == "unauthenticated"

    replacement_owner = SessionManager(path)
    replacement_owner.establish(saved_client())
    assert path.exists()
    replacement_owner.clear()


def test_session_path_inside_repository_is_rejected(tmp_path):
    repository = tmp_path / "repository"
    (repository / ".git").mkdir(parents=True)

    with pytest.raises(RuntimeError, match="outside a Git repository"):
        SessionManager(repository / "private" / "session.json")


@pytest.mark.anyio
async def test_remote_bridge_requires_service_auth(monkeypatch, tmp_path):
    token = "a" * 32
    remote = BridgeSettings(
        host="192.0.2.10",
        port=8100,
        api_token=token,
        allowed_origins=("https://mission-control.example",),
        session_file=tmp_path / "session.json",
        remote_tls=True,
        max_auth_body_bytes=16384,
    )
    monkeypatch.setattr(main_module, "SETTINGS", remote)
    monkeypatch.setattr(main_module, "DEMO_MODE", True)
    transport = ASGITransport(app=main_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        denied = [
            await client.get("/accounts"),
            await client.post("/sync"),
            await client.patch(
                "/transactions/tx-test/category",
                json={"categoryId": "cat-test"},
            ),
        ]
        allowed = await client.get(
            "/accounts",
            headers={"Authorization": f"Bearer {token}"},
        )
        health = await client.get("/health")

    assert all(response.status_code == 401 for response in denied)
    assert all(
        response.json()["error"]["code"] == "bridge_auth_required"
        for response in denied
    )
    assert allowed.status_code == 200
    assert health.status_code == 200


def test_remote_client_fails_closed_if_server_bind_was_overridden(tmp_path):
    local_configuration = BridgeSettings(
        host="127.0.0.1",
        port=8100,
        api_token=None,
        allowed_origins=(),
        session_file=tmp_path / "session.json",
        remote_tls=False,
        max_auth_body_bytes=16384,
    )

    assert local_configuration.request_requires_service_auth("192.0.2.20") is True
    assert local_configuration.authorizes(None, None, required=True) is False


def test_remote_configuration_requires_token_and_tls(tmp_path):
    with pytest.raises(RuntimeError, match="BRIDGE_API_TOKEN"):
        BridgeSettings(
            host="0.0.0.0",
            port=8100,
            api_token=None,
            allowed_origins=(),
            session_file=tmp_path / "session.json",
            remote_tls=True,
            max_auth_body_bytes=16384,
        ).validate()
    with pytest.raises(RuntimeError, match="TLS"):
        BridgeSettings(
            host="0.0.0.0",
            port=8100,
            api_token="a" * 32,
            allowed_origins=(),
            session_file=tmp_path / "session.json",
            remote_tls=False,
            max_auth_body_bytes=16384,
        ).validate()


@pytest.mark.anyio
async def test_cors_only_allows_configured_local_origin(monkeypatch):
    monkeypatch.setattr(main_module, "DEMO_MODE", True)
    transport = ASGITransport(app=main_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        allowed = await client.options(
            "/accounts",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        denied = await client.options(
            "/accounts",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.anyio
async def test_auth_payload_size_is_bounded(live_client, monkeypatch):
    small_limit = BridgeSettings(
        host="127.0.0.1",
        port=8100,
        api_token=None,
        allowed_origins=(),
        session_file=main_module.session_manager.path,
        remote_tls=False,
        max_auth_body_bytes=1024,
    )
    monkeypatch.setattr(main_module, "SETTINGS", small_limit)

    response = await live_client.post(
        "/auth/login-with-cookies",
        json={"cookies": f"opaque={'x' * 2000}"},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"
