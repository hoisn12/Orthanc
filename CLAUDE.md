# orthanc

Claude Code 세션을 실시간으로 모니터링하는 웹 대시보드.

## Quick Start

```bash
npm start                          # 서버 시작 (기본 포트 7432)
node bin/cli.js --port 8080        # 포트 지정
node bin/cli.js --install-hooks    # 모니터링 훅 설치 후 시작
node bin/cli.js --project /path    # 특정 프로젝트 대상
npm test                           # 테스트 실행
```

## Architecture

```
CLI (bin/cli.js)
 ├── Express Server (src/server.js)
 │    ├── REST API + SSE Stream
 │    └── Static Files (public/)
 ├── EventStore (src/event-store.js)      — 이벤트 순환 버퍼 (max 500)
 ├── SessionWatcher (src/session-watcher.js) — ~/.claude/sessions/ 폴링 (5s)
 ├── ConfigParser (src/config-parser.js)  — .claude/ 디렉토리 설정 파싱
 └── HookInstaller (src/hook-installer.js) — settings.local.json 훅 관리
```

## API Endpoints

| Method | Path                   | Description                                       |
| ------ | ---------------------- | ------------------------------------------------- |
| GET    | `/api/config`          | 프로젝트 설정 (skills, agents, rules, hooks, env) |
| GET    | `/api/sessions`        | 활성 Claude Code 세션 목록                        |
| GET    | `/api/events?limit=50` | 최근 이벤트                                       |
| GET    | `/api/events/stream`   | SSE 실시간 이벤트 스트림                          |
| POST   | `/api/events/:type`    | Claude Code 훅에서 이벤트 수신                    |
| POST   | `/api/hooks/install`   | 모니터링 훅 설치                                  |
| POST   | `/api/hooks/uninstall` | 모니터링 훅 제거                                  |

## Key Modules

### config-parser.js

대상 프로젝트의 `.claude/` 디렉토리를 읽어서 다음을 파싱:

- **Skills**: `.claude/skills/*/SKILL.md` 프론트매터에서 이름/설명 추출
- **Agents**: `.claude/agents/*.md` 에이전트 파일 목록
- **Rules**: `.claude/rules/*.md` 규칙 파일 (glob 매처 포함)
- **Hooks**: `settings.json` + `settings.local.json` 병합
- **Env**: 환경변수 추출

### hook-installer.js

11가지 이벤트 타입에 대한 HTTP POST 훅을 `settings.local.json`에 설치:
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, Notification

### session-watcher.js

`~/.claude/sessions/` 디렉토리를 폴링하여 활성 세션 추적.
PID 존재 여부로 프로세스 생존 확인.

### event-store.js

고정 크기 순환 버퍼. pub-sub 패턴으로 SSE 구독자에게 실시간 전달.

## Frontend (public/)

4패널 그리드 대시보드:

1. **좌상단**: 활성 세션 + 서브에이전트
2. **우상단**: 활동 피드 (실시간 SSE)
3. **좌하단**: 설정 (Skills, Agents, Environment)
4. **우하단**: Hooks & Rules

## Development

- **Runtime**: Node.js >= 20
- **Framework**: Express 5
- **Test**: `node --test` (built-in test runner)
- **Module**: ESM (`"type": "module"`)
- **Style**: 별도 빌드 도구 없음, vanilla JS/CSS/HTML

## Work Instructions

코드 수정/추가/삭제를 수반하는 작업에 한해 아래 5단계를 순서대로 따른다.
단순 질문, 파일 조회, 설명 요청 등에는 적용하지 않는다.

### 1. Plan (계획 수립)

- 작업 요청을 분석하고 변경 대상 파일, 영향 범위, 구현 순서를 정리
- 기존 코드 패턴과 유틸리티를 먼저 파악하여 재사용
- 계획을 사용자에게 제시하고 승인을 받은 후 다음 단계로 진행

### 2. Plan Review (계획 리뷰)

- Plan 완료 후 자동으로 `/plan-review` 스킬을 실행하여 계획을 검증
- **미통과 시**: 미통과 항목을 수정하여 Plan 단계로 돌아간 뒤 재검증

### 3. Act (계획 실행)

- 승인된 계획에 따라 코드 변경 수행
- 계획 범위를 벗어나는 변경 금지
- 단계별 진행 상황을 사용자에게 공유

### 4. Code Review (코드 리뷰)

- Act 완료 후 자동으로 `/code-review` 스킬을 실행하여 변경 코드를 검토
- **미통과 시**: 미통과 항목을 수정한 뒤 Code Review를 재실행

### 5. Risk Review (리스크 리뷰)

- Code Review 통과 후 자동으로 `/risk-review` 스킬을 실행하여 위험 요소를 점검
- **High 리스크 발견 시**: 사용자에게 보고하고 승인을 받은 후 완료 처리
