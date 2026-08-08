# Monarch Bridge Service

A lightweight FastAPI microservice that wraps the `monarchmoneycommunity` Python library, providing a REST API for Mission Control to sync and interact with Monarch Money data.

## Why a Separate Service?

- The mature Monarch libraries are Python (not Node.js)
- Isolates authentication/session management from the main app
- Can be restarted independently without affecting Mission Control
- Enables future scaling (e.g., running on a different machine)

## Quick Start (Demo Mode)

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows

# Install dependencies
pip install -r requirements.txt

# Run with mock data (no credentials needed!)
python main.py --demo

# API docs at http://localhost:8100/docs
```

## Production Setup

```bash
# Configure
cp config.example.env .env
# Edit .env with your Monarch credentials

# First run (interactive login for MFA)
python main.py --setup

# Normal run
python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 8100
```

## Running Tests

```bash
python -m pytest test_bridge.py -v
```

Tests run in demo mode and require no credentials.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/contract` | Stable contract version and supported versions |
| GET | `/health` | Health check + session status |
| POST | `/sync` | Trigger full transaction pull (Mission Control calls this) |
| GET | `/transactions` | Fetch transactions with filters |
| GET | `/transactions/{id}` | Single transaction detail |
| PATCH | `/transactions/{id}/category` | Update category (writes to Monarch) |
| GET | `/categories` | All transaction categories |
| GET | `/accounts` | Connected accounts |
| GET | `/recurring` | Recurring/subscription transactions |
| GET | `/cashflow` | Income vs. expenses summary |
| GET | `/budgets` | Budget status per category |
| GET | `/docs` | Interactive API documentation (auto-generated) |

All responses implement contract v1.0, include `contractVersion`, and set the
`X-Monarch-Contract-Version` response header. See
[`docs/API-CONTRACTS.md`](../docs/API-CONTRACTS.md) for DTO and error semantics.

## Demo Mode

Use `--demo` flag or set `DEMO_MODE=true` in your environment. Returns realistic mock financial data so you can develop Mission Control connectors without live credentials.

## Authentication

On first run, the service performs an interactive login (email + password + optional MFA code). The session token is cached at `~/.monarch_session` and auto-refreshed on subsequent starts.

## Architecture

```
Mission Control (Node.js/Next.js)
        │
        │ HTTP (localhost:8100)
        │
   ┌────▼────┐
   │ FastAPI  │ ← Monarch Bridge
   │ Service  │
   └────┬────┘
        │
        │ GraphQL (Monarch's internal API)
        │
   ┌────▼────────────┐
   │ Monarch Money   │
   │ (Cloud Service) │
   └─────────────────┘
```
