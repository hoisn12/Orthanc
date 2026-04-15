# Architecture

## Overview

**orthanc**는 Claude Code / Codex CLI 세션을 실시간으로 모니터링하는 경량 웹 대시보드다. Express 서버가 Hook 이벤트, OpenTelemetry 텔레메트리, Statusline 데이터를 수집하고, SQLite에 저장하며, SSE로 브라우저에 스트리밍한다.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Claude Code / Codex CLI                                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐              │
│  │  Hooks   │  │ OTel Export  │  │  Statusline Cmd  │              │
│  │ (HTTP)   │  │ (OTLP/JSON)  │  │  (bin/statusline │              │
│  └────┬─────┘  └──────┬───────┘  │      .sh)        │              │
│       │               │          └────────┬─────────┘              │
└───────┼───────────────┼──────────────────┼─────────────────────────┘
        │               │                  │
        ▼               ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Express Server (src/server.ts)                          port 7432  │
│                                                                     │
│  POST /api/events/:type ──▶ EventStore                              │
│  POST /v1/{logs,metrics,traces} ──▶ OtelReceiver ──▶ EventStore     │
│                                              └──────▶ MetricsStore  │
│  POST /api/statusline ──▶ SQLite (usage table)                      │
│  POST /api/project ──▶ Provider 재감지 + 프로젝트 전환 + DB 저장    │
│                                                                     │
│  GET  /api/provider ──▶ 현재 Provider 정보                          │
│  GET  /api/events/stream ──▶ SSE (EventStore.subscribe)             │
│  GET  /api/config ──▶ Provider.parseProjectConfig                   │
│  GET  /api/sessions ──▶ SessionWatcher                              │
│  GET  /api/sessions/:pid/config ──▶ 세션별 프로젝트 설정            │
│  GET  /api/tokens ──▶ TokenStore (SQLite 집계 쿼리)                  │
│  GET  /api/metrics/* ──▶ MetricsStore                               │
│  GET  /api/usage ──▶ SQLite (usage table)                           │
│  GET  /api/file ──▶ .md 파일 읽기 (Provider 보안 검증)              │
│  GET  /api/directories ──▶ 디렉토리 탐색                            │
│  GET  /api/hooks/status ──▶ Provider.getMonitorStatus               │
│  POST /api/hooks/install ──▶ Provider.installHooks (컴포넌트별)      │
│  POST /api/hooks/uninstall ──▶ Provider.uninstallHooks (컴포넌트별)  │
│                                                                     │
│  JsonlWatcher ──▶ JSONL 실시간 파싱 ──▶ EventStore + TokenStore     │
│                                                                     │
│  Static: public/ (index.html, app.js, style.css)                    │
│  Vendor: node_modules/marked/lib (Markdown 렌더링)                   │
└─────────────────────────────────────────────────────────────────────┘
        │
        │ SSE + REST
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Browser Dashboard (public/)                                        │
│  4 Pages: Monitor | Tokens | Harness | Settings                    │
└─────────────────────────────────────────────────────────────────────┘
```

## 디렉토리 구조

```
bin/
  cli.ts              # CLI 엔트리포인트 (args 파싱, 서버 시작)
  statusline.sh       # Statusline 스크립트 (Claude Code → monitor 서버로 POST)

src/
  server.ts           # Express 서버, 모든 라우트 정의
  db.ts               # SQLite (better-sqlite3) 초기화, 스키마 관리
  types.ts            # 공유 TypeScript 타입/인터페이스 정의
  event-store.ts      # 순환 버퍼 (max 2000) + pub-sub SSE 전달
  session-watcher.ts  # 세션 디렉토리 폴링, PID 생존 확인
  config-parser.ts    # Provider 위임 wrapper
  hook-installer.ts   # Provider 위임 wrapper + CLI 모드
  token-tracker.ts    # JSONL 세션 로그 → 토큰 사용량/비용 집계 (레거시 인메모리)
  token-store.ts      # SQLite 기반 토큰 사용량 저장/집계 쿼리
  token-sync.ts       # JSONL → SQLite 증분 동기화 (byte-offset 추적)
  jsonl-watcher.ts    # 활성 세션 JSONL 실시간 파싱 (assistant 스트리밍 + 토큰 upsert)
  metrics-store.ts    # 실시간 메트릭 인메모리 저장 (latency, cost, tool stats)
  otel-receiver.ts    # OTLP HTTP/JSON 파서 → EventStore + MetricsStore
  providers/
    provider.ts       # Provider 추상 베이스 클래스
    registry.ts       # Provider auto-detection + factory
    claude-provider.ts # Claude Code 어댑터
    codex-provider.ts  # Codex CLI 어댑터

public/
  index.html          # SPA 셸 (4페이지 nav)
  app.js              # 프론트엔드 로직 (fetch, SSE, 렌더링)
  style.css           # 다크 테마 스타일

data/
  monitor.db          # SQLite DB (런타임 생성, gitignore 대상)

test/
  test-db.ts              # 테스트용 DB 헬퍼
  event-store.test.ts
  config-parser.test.ts
  provider.test.ts
  otel-receiver.test.ts
  metrics-store.test.ts
```

## 핵심 모듈 상세

### Provider 시스템 (`src/providers/`; TypeScript)

Strategy 패턴으로 CLI별 차이를 추상화한다. `Provider` 베이스 클래스가 인터페이스를 정의하고, `ClaudeProvider`와 `CodexProvider`가 구현체다.

| 책임      | 메서드                                                                                  |
| --------- | --------------------------------------------------------------------------------------- |
| 세션 탐색 | `getSessionsDir()`, `listSessionFiles()`, `parseSessionFile()`                          |
| 훅 관리   | `getHookEvents()`, `installHooks(root, port, options)`, `uninstallHooks(root, options)` |
| 훅 상태   | `getMonitorStatus(root)` → `{ hooks, otel, statusline }`                                |
| 설정 파싱 | `getConfigDirName()`, `parseProjectConfig()`                                            |
| 토큰 추적 | `getProjectsDir()`, `getTokenPricing()`, `getDefaultPricing()`, `parseUsageRecord()`    |
| 보안      | `isFileReadAllowed()`                                                                   |

`installHooks`/`uninstallHooks`는 `options` 파라미터로 **3가지 컴포넌트를 개별 제어**:

- `hooks`: HTTP POST 훅 (11개 이벤트 타입)
- `otel`: OpenTelemetry 텔레메트리 환경변수
- `statusline`: Statusline 스크립트 설정

`registry.ts`의 `detectProvider()`가 자동 감지 로직을 수행:

1. 명시적 `--provider` 플래그
2. 프로젝트에 `.codex/` 존재 → Codex
3. 프로젝트에 `.claude/` 존재 → Claude
4. `~/.codex/sessions/`에 활성 세션 → Codex
5. 기본값: Claude

### 데이터 수집 경로

**3가지 독립적 수집 채널 (Settings에서 개별 설치/제거 가능):**

1. **Hook 이벤트** (`POST /api/events/:type`)
   - `settings.local.json`에 HTTP POST 훅 설치 (11개 이벤트)
   - Claude Code가 이벤트 발생 시 JSON payload 전송
   - → `EventStore`에 저장 → SSE로 브라우저 전달

2. **OpenTelemetry** (`POST /v1/{logs,metrics,traces}`)
   - `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP endpoint 설정
   - `OtelReceiver`가 OTLP HTTP/JSON 파싱
   - 로그에서 `claude_code.api_request`, `api_error`, `tool_result` 등 추출
   - → `EventStore` (SSE) + `MetricsStore` (집계) 동시 전달

3. **Statusline** (`POST /api/statusline`)
   - `bin/statusline.sh`가 stdin으로 JSON 수신 → 서버로 POST
   - 모델명, 비용, 컨텍스트 사용률, 레이트 리밋 정보
   - SQLite `usage` 테이블에 세션별 최신 데이터 저장

### 데이터 저장 (SQLite)

`src/db.ts`가 `data/monitor.db`를 관리. WAL 모드 + busy_timeout 설정.

**테이블:**
| 테이블 | 용도 |
|--------|------|
| `events` | 이벤트 영구 저장 (id, timestamp, type, session_id, pid, payload) |
| `usage` | Statusline 실시간 사용량 (session_id → JSON data) |
| `token_usage` | JSONL 파싱 토큰 사용량 (메시지 단위, 모델별 집계 가능) |
| `token_sync_state` | JSONL 증분 동기화 상태 (file_path → byte_offset) |
| `settings` | key-value 설정 저장 (프로젝트 경로 등, 재시작 시 복원) |

### EventStore (`src/event-store.ts`)

- 고정 크기 순환 버퍼 (기본 2000개)
- `add()` → 이벤트 저장 + 모든 subscriber에 실시간 전달
- `subscribe()` → SSE 연결에 사용, unsubscribe 콜백 반환
- ID: `timestamp-randomSuffix` 형태

### TokenStore (`src/token-store.ts`)

- SQLite 기반 토큰 사용량 저장소
- `upsert()` / `bulkUpsert()` — 메시지 단위 레코드 저장
- `queryAggregated()` — totals, byModel, hourly, sessions, recent24h 집계를 SQL로 수행
- 증분 동기화 상태 관리 (`getSyncState` / `setSyncState`)

### TokenSync (`src/token-sync.ts`)

- `syncAll()` — 프로젝트의 모든 JSONL 파일을 DB에 증분 동기화
- byte-offset 추적으로 이전에 파싱한 부분은 건너뜀
- 서버 시작 시 초기 동기화 실행

### JsonlWatcher (`src/jsonl-watcher.ts`)

- 활성 세션의 JSONL 파일을 1초 간격으로 폴링
- 새로운 assistant 메시지를 `assistant-streaming` 이벤트로 EventStore에 전달
- 동시에 token usage를 TokenStore에 실시간 upsert
- 세션 종료 시 자동 정리

### MetricsStore (`src/metrics-store.ts`)

- 시간 윈도우 기반 인메모리 집계 (기본 1시간 retention)
- 3가지 데이터 시리즈: `apiCalls`, `toolExecutions`, `apiErrors`
- 제공 통계: latency percentiles (p50/p95/p99), cost timeline, tool별 stats, model breakdown, error rate
- `_prune()`로 오래된 데이터 자동 제거

### SessionWatcher (`src/session-watcher.ts`)

- `~/.claude/sessions/` (또는 `~/.codex/sessions/`) 폴링 (5초 간격)
- `process.kill(pid, 0)`으로 프로세스 생존 확인
- 프로젝트 경로 필터링 지원 (`setProjectFilter()`)
- dead 세션 자동 정리

### OtelReceiver (`src/otel-receiver.ts`)

- OTLP HTTP/JSON 3가지 시그널 수신: logs, metrics, traces
- `flattenAttributes()`로 OTLP attribute 배열 → flat object 변환
- Span 처리: duration 계산, tool 실행 자동 감지
- 나노초 → 밀리초 BigInt 변환

## 프론트엔드 구조

SPA 방식의 4페이지 구성 (라우터 없음, DOM 토글):

| 페이지       | 내용                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| **Monitor**  | 활성 세션 목록, 실시간 활동 피드 (SSE), tool 이벤트 필터링                   |
| **Tokens**   | 토큰 사용량/비용, 모델별 분석, 세션별 상세, 실시간 OTel 메트릭               |
| **Harness**  | Skills, Agents, Rules, Hooks, Environment, CLAUDE.md 파일 뷰어               |
| **Settings** | 프로젝트 경로 변경, 모니터 컴포넌트 개별 설치/제거 (Hooks, OTel, Statusline) |

### 헤더 Current Tool 인디케이터

헤더 중앙에 현재 실행 상태를 실시간 표시:

| 상태                                      | 표시                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| **Active** (tool 실행 중)                 | 초록 펄스 dot + PID + tool명 + 상세                         |
| **Recent** (세션 alive, 마지막 활동 있음) | 초록 정지 dot + PID + 마지막 이벤트 type + 내용 + 경과 시간 |
| **None** (활성 세션 없거나 stop 이후)     | 인디케이터 숨김                                             |

- Hook 이벤트(`pre-tool-use`/`post-tool-use`)와 OTel 이벤트(`otel-tool-decision`/`otel-tool-result`/`otel-api-request`) 모두 반영
- `post-tool-use` 후 500ms 디바운스로 깜빡임 방지
- `stop`/`session-end` 시 해당 PID의 lastActivity 즉시 삭제 → 모든 세션 종료 시 인디케이터 즉시 사라짐

### Activity Feed 필터링

- `pre-tool-use`/`post-tool-use` 이벤트는 기본 숨김
- "Show tool events" 토글 버튼으로 표시/숨김 전환
- `assistant-streaming` 이벤트로 실시간 응답 스트리밍 표시 (Markdown 렌더링)

## 기술 스택

| 항목        | 선택                                               |
| ----------- | -------------------------------------------------- |
| Runtime     | Node.js >= 20                                      |
| Language    | TypeScript (ESM, `tsc`로 `dist/`에 빌드)           |
| Framework   | Express 5                                          |
| Module      | ESM (`"type": "module"`)                           |
| DB          | SQLite (better-sqlite3, WAL mode)                  |
| 의존성      | express, better-sqlite3, marked                    |
| 테스트      | `node --test` (빌트인 테스트 러너)                 |
| 프론트엔드  | Vanilla JS/CSS/HTML (빌드 도구 없음)               |
| Markdown    | marked (서버에서 정적 제공, 프론트엔드에서 렌더링) |
| 실시간 통신 | SSE (Server-Sent Events)                           |
| 텔레메트리  | OTLP HTTP/JSON                                     |

## 보안 고려사항

- 파일 읽기 API (`GET /api/file`)는 `.md` 파일만 허용, 설정 디렉토리 내부로 제한
- Provider별 `isFileReadAllowed()` 메서드로 경로 검증
- 모니터링 훅은 `_marker` 필드 또는 URL 패턴(`localhost:port/api/events/`)으로 식별
- localhost 바인딩 (외부 접근 차단)
- 모니터 컴포넌트(Hooks, OTel, Statusline) 개별 설치/제거 지원
