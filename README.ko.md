# Orthanc

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

**Claude Code & Codex CLI 세션을 실시간으로 모니터링하는 경량 웹 대시보드.**

Orthanc는 실행 중인 Claude Code / Codex CLI 프로세스에서 Hook 이벤트, OpenTelemetry 텔레메트리, Statusline 데이터를 수집하고, SQLite에 저장하며, SSE를 통해 브라우저 대시보드로 스트리밍합니다.

[English](README.md)

<!-- TODO: 대시보드 스크린샷 추가 -->
<!-- ![Dashboard Screenshot](docs/screenshot.png) -->

## 주요 기능

- **실시간 모니터링** — SSE(Server-Sent Events) 기반 라이브 활동 피드
- **토큰 & 비용 추적** — 세션별, 모델별 토큰 사용량 및 비용 추정
- **멀티 프로바이더 지원** — Claude Code와 Codex CLI 모두 지원 (자동 감지)
- **3가지 데이터 수집 채널** — Hooks, OpenTelemetry(OTLP), Statusline 각각 독립 설치 가능
- **Harness 뷰어** — Skills, Agents, Rules, Hooks, Environment 설정을 한눈에 확인
- **현재 도구 인디케이터** — 헤더에서 실행 중인 도구를 펄스 애니메이션과 함께 실시간 표시
- **빌드 도구 불필요** — Vanilla JS/CSS/HTML 대시보드, 번들러 없음
- **SQLite 영속성** — 이벤트, 토큰 사용량, 동기화 상태가 재시작 후에도 유지

## 빠른 시작

```bash
# 클론 및 설치
git clone https://github.com/hoisn12/Orthanc.git
cd Orthanc
npm install

# 서버 시작 (기본 포트 7432)
npm start

# 옵션 지정
node dist/bin/cli.js --port 8080
node dist/bin/cli.js --install-hooks
node dist/bin/cli.js --project /path/to/your/project
```

대시보드가 자동으로 `http://localhost:7432`에서 열립니다.

## CLI 옵션

```
orthanc [options]

Options:
  --project <path>         대상 프로젝트 디렉토리 (기본값: cwd)
  --port <number>          서버 포트 (기본값: 7432)
  --provider <name>        프로바이더: claude, codex, auto (기본값: auto)
  --install-hooks          시작 시 모니터 훅 자동 설치
  --no-open                브라우저 자동 열기 비활성화
  --help, -h               도움말 표시
```

## 아키텍처

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
Browser Dashboard (4페이지)
```

전체 아키텍처 문서는 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.

## 대시보드 페이지

| 페이지 | 설명 |
|--------|------|
| **Monitor** | 활성 세션 목록, 실시간 활동 피드 (도구 이벤트 필터링) |
| **Tokens** | 모델별, 세션별, 시간대별 토큰 사용량 및 비용 분석 |
| **Harness** | Skills, Agents, Rules, Hooks, Environment, CLAUDE.md 뷰어 |
| **Settings** | 프로젝트 경로 설정, 모니터 컴포넌트 개별 설치/제거 |

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/config` | 프로젝트 설정 (skills, agents, rules, hooks, env) |
| GET | `/api/sessions` | 활성 CLI 세션 목록 |
| GET | `/api/events?limit=50` | 최근 이벤트 |
| GET | `/api/events/stream` | SSE 실시간 이벤트 스트림 |
| GET | `/api/tokens` | 토큰 사용량 집계 통계 |
| GET | `/api/metrics/*` | 실시간 OTel 메트릭 |
| GET | `/api/usage` | Statusline 사용량 데이터 |
| GET | `/api/hooks/status` | 모니터 컴포넌트 설치 상태 |
| POST | `/api/events/:type` | CLI 훅에서 이벤트 수신 |
| POST | `/api/hooks/install` | 모니터 훅 설치 |
| POST | `/api/hooks/uninstall` | 모니터 훅 제거 |
| POST | `/v1/logs` | OTLP 로그 수집 |
| POST | `/v1/metrics` | OTLP 메트릭 수집 |
| POST | `/v1/traces` | OTLP 트레이스 수집 |

## 기술 스택

| 항목 | 선택 |
|------|------|
| 런타임 | Node.js >= 20 |
| 언어 | TypeScript (ESM) |
| 프레임워크 | Express 5 |
| 데이터베이스 | SQLite (better-sqlite3, WAL 모드) |
| 실시간 통신 | SSE (Server-Sent Events) |
| 텔레메트리 | OTLP HTTP/JSON |
| Markdown | marked |
| 프론트엔드 | Vanilla JS/CSS/HTML |
| 테스트 | `node --test` (빌트인 러너) |

## 개발

```bash
# 빌드
npm run build

# 테스트 실행
npm test

# 타입 체크
npm run typecheck

# 린트
npm run lint
npm run lint:fix

# 포맷
npm run format
npm run format:check
```

## 라이선스

[MIT](LICENSE) &copy; hoisn12
