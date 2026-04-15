# Orthanc

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

**Lightweight web dashboard for monitoring Claude Code & Codex CLI sessions in real time.**

Orthanc collects Hook events, OpenTelemetry telemetry, and Statusline data from running Claude Code / Codex CLI processes, stores them in SQLite, and streams everything to a browser dashboard via SSE.

[한국어 문서 (Korean)](README.ko.md)

<!-- TODO: Add a screenshot of the dashboard -->
<!-- ![Dashboard Screenshot](docs/screenshot.png) -->

## Features

- **Real-time monitoring** — Live activity feed powered by Server-Sent Events (SSE)
- **Token & cost tracking** — Per-session and per-model token usage with cost estimation
- **Multi-provider support** — Works with both Claude Code and Codex CLI (auto-detected)
- **Three data collection channels** — Hooks, OpenTelemetry (OTLP), and Statusline, each independently installable
- **Harness viewer** — Browse Skills, Agents, Rules, Hooks, and Environment configs at a glance
- **Current tool indicator** — Header shows the currently executing tool with live pulse animation
- **Zero build frontend** — Vanilla JS/CSS/HTML dashboard, no bundler required
- **SQLite persistence** — Events, token usage, and sync state survive restarts

## Quick Start

```bash
# Clone and install
git clone https://github.com/hoisn12/Orthanc.git
cd Orthanc
npm install

# Start the server (default port 7432)
npm start

# Or with options
node dist/bin/cli.js --port 8080
node dist/bin/cli.js --install-hooks
node dist/bin/cli.js --project /path/to/your/project
```

The dashboard opens automatically at `http://localhost:7432`.

## Setup

After launching the server, open the **Settings** page in the dashboard to configure monitoring.

### 1. Set Project Path

Click **Browse...** next to "Project Path" to select the project directory you want to monitor. This setting is persisted in the database and restored on restart.

### 2. Install Monitor Components

Under "Monitor Components", install the data collection channels you need:

| Component | Description | Data Collected |
|-----------|-------------|----------------|
| **HTTP Hooks** | Hook event POST to monitor server | Session lifecycle, tool use, prompts, notifications |
| **OpenTelemetry** | OTLP HTTP/JSON telemetry export | API latency, cost, tool execution stats |
| **Statusline** | Realtime usage script | Model name, cost, context usage, rate limits |

You can install each component individually or use **Install All** to enable everything at once.

### 3. Verify

Switch to the **Monitor** page to confirm events are flowing in the Activity Feed.

## CLI Options

```
orthanc [options]

Options:
  --project <path>         Target project directory (default: cwd)
  --port <number>          Server port (default: 7432)
  --provider <name>        Provider: claude, codex, auto (default: auto)
  --install-hooks          Auto-install monitor hooks on startup
  --no-open                Don't open browser automatically
  --help, -h               Show this help
```

## Architecture

```
Claude Code / Codex CLI
  ├── Hooks (HTTP POST)
  ├── OTel Export (OTLP/JSON)
  └── Statusline Script
        │
        ▼
Express Server (port 7432)
  ├── REST API + SSE Stream
  ├── SQLite (events, tokens, usage)
  └── Static Files (public/)
        │
        ▼
Browser Dashboard (4 pages)
```

For the full architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Dashboard Pages

| Page | Description |
|------|-------------|
| **Monitor** | Active sessions, real-time activity feed with tool event filtering |
| **Tokens** | Token usage & cost analysis by model, session, and time period |
| **Harness** | Skills, Agents, Rules, Hooks, Environment, and CLAUDE.md viewer |
| **Settings** | Project path config, individual monitor component install/uninstall |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/provider` | Current provider info |
| GET | `/api/config` | Project configuration (skills, agents, rules, hooks, env) |
| GET | `/api/sessions` | Active CLI session list |
| GET | `/api/sessions/:pid/config` | Per-session project configuration |
| GET | `/api/events?limit=50` | Recent events |
| GET | `/api/events/stream` | SSE real-time event stream |
| GET | `/api/tokens` | Token usage aggregated stats |
| GET | `/api/metrics/*` | Real-time OTel metrics |
| GET | `/api/usage` | Statusline usage data |
| GET | `/api/file` | Read .md files (provider-scoped security) |
| GET | `/api/directories` | Directory browser |
| GET | `/api/hooks/status` | Monitor component install status |
| POST | `/api/project` | Switch project (persisted to DB) |
| POST | `/api/events/:type` | Receive events from CLI hooks |
| POST | `/api/hooks/install` | Install monitor hooks |
| POST | `/api/hooks/uninstall` | Uninstall monitor hooks |
| POST | `/v1/logs` | OTLP log ingestion |
| POST | `/v1/metrics` | OTLP metrics ingestion |
| POST | `/v1/traces` | OTLP traces ingestion |

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js >= 20 |
| Language | TypeScript (ESM) |
| Framework | Express 5 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Real-time | SSE (Server-Sent Events) |
| Telemetry | OTLP HTTP/JSON |
| Markdown | marked |
| Frontend | Vanilla JS/CSS/HTML |
| Test | `node --test` (built-in runner) |

## Development

```bash
# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:check
```

## License

[MIT](LICENSE) &copy; hoisn12
