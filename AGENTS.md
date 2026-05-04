# Repository Guidelines

Orthanc는 Claude Code/Codex CLI 세션을 실시간으로 모니터링하는 Node.js 20+ TypeScript ESM 웹 대시보드입니다.

## Quick Start

```bash
npm install                         # 의존성 설치
npm start                           # 빌드 후 서버 시작, 기본 포트 7432
node dist/bin/cli.js --port 8080    # 빌드된 CLI를 특정 포트로 실행
npm test                            # 빌드 후 node:test 실행
```

## Project Structure & Module Organization

- `bin/cli.ts`: CLI 진입점.
- `src/server.ts`: Express 서버, REST API, SSE 스트림, 정적 파일 서빙.
- `src/event-store.ts`: 이벤트 저장 및 SSE 구독자 알림.
- `src/session-watcher.ts`: CLI 세션 감시.
- `src/config-parser.ts`: 대상 프로젝트의 Claude/Codex 설정 파싱.
- `src/hook-installer.ts`: 모니터링 훅 설치 및 제거.
- `src/providers/`: Claude/Codex provider 어댑터.
- `public/`: 번들러 없는 vanilla JS/CSS/HTML 대시보드.
- `test/`: `node:test` 기반 테스트. `dist/`와 `data/`는 생성물/런타임 데이터로 취급한다.

## Build, Test, and Development Commands

- `npm run ensure:worktree`: 현재 경로가 `../Orthanc-worktrees/<branch-or-ticket>` worktree인지 검증.
- `npm run build`: TypeScript를 `dist/`로 컴파일.
- `npm run typecheck`: emit 없이 타입 검사.
- `npm run lint` / `npm run lint:fix`: ESLint 검사 및 자동 수정.
- `npm run format` / `npm run format:check`: Prettier 적용 및 검증.

## Git Worktree Guidelines

- worktree는 저장소 내부가 아닌 sibling 디렉터리 `../Orthanc-worktrees/<branch-or-ticket>`에 만든다.
- 새 브랜치 작업은 `git worktree add ../Orthanc-worktrees/<branch-or-ticket> -b <branch>` 형식을 사용한다.
- 기존 브랜치 작업은 `git worktree add ../Orthanc-worktrees/<branch-or-ticket> <branch>` 형식을 사용한다.
- `Orthanc/` 내부에는 worktree를 만들지 않는다. 검색, watcher, 테스트, IDE 인덱싱에 중첩 저장소가 섞일 수 있다.
- `npm start`, `npm test`, `npm run build/typecheck/lint/format` 계열 명령은 `scripts/ensure-worktree.sh`를 먼저 실행한다.
- guard 실패 시 작업 위치를 `../Orthanc-worktrees/<branch-or-ticket>`로 옮긴 뒤 다시 실행한다.
- CI 환경(`CI=true`)은 자동 검증 경로 호환성을 위해 guard를 통과시킨다.

## Coding Style & Naming Conventions

TypeScript ESM을 사용하며 로컬 import는 기존 코드처럼 `.js` 확장자를 명시한다. Prettier 규칙은 2-space indentation, single quotes, trailing commas, print width 120이다. 파일명은 `event-store.ts`, `session-watcher.ts`처럼 kebab-case를 사용한다. 사용하지 않는 인자는 `_` prefix를 붙인다.

## Testing Guidelines

테스트 파일은 `test/*.test.ts` 패턴을 따른다. `node:test`와 `node:assert/strict`를 사용하고, DB가 필요한 테스트는 `test/test-db.ts` 같은 헬퍼를 재사용한다. 변경 전후로 최소 `npm test`를 실행하고, 타입/스타일 변경이 있으면 `npm run typecheck`와 `npm run lint`도 확인한다.

## Commit & Pull Request Guidelines

### 커밋 메시지

- 형식: `<type>(<scope>): <설명>`
- scope: fe, be, ds, infra 등
- 티켓 번호가 대화 컨텍스트, 브랜치명, 또는 커밋에 존재하면 scope를 티켓 번호로 사용 (예: `feat(ABC-123): 설명`)

### PR 생성

- PR title: 70자 이내. 단일 커밋이면 커밋 메시지 재사용, 복수 커밋이면 전체 변경을 요약
- 티켓 번호 scope 규칙은 커밋 메시지와 동일
- 기존 PR이 있는 브랜치: `gh pr list --head <branch> --state open`으로 확인 후 push만 수행, 새 PR 생성하지 않음

## Work Instructions

코드 수정/추가/삭제 작업은 `CLAUDE.md`와 동일한 절차를 따른다: Plan, Plan Review, Worktree Setup, Act, Code Review, Risk Review. 계획 범위를 벗어난 변경은 하지 말고, 단계별 진행 상황을 공유한다. High 리스크가 발견되면 완료 전에 사용자에게 보고하고 승인을 받는다.

## Shared Skills

공통 skill 원본은 `.shared/skills/`에 둔다. Claude는 `.claude/skills/*` 링크로, Codex는 `.codex/skills/orthanc-*` 링크로 같은 원본을 사용한다.

## Security & Configuration Tips

훅 설치, 파일 읽기 API, 프로젝트 경로 처리 변경은 보안 영향을 먼저 확인한다. `data/`, 불필요한 `dist/` 변경, 로컬 credentials, 개인 Claude/Codex 설정은 커밋하지 않는다.

## Pull request guidelines

- Use a concise PR title.
- Include:
  - Summary
  - Changes
  - Tests
  - Risk / rollback notes
- Link the Linear issue in the PR body.

## UI verification rules

When a task changes the frontend:

- Start the local app if needed.
- Use Playwright to verify the changed screen.
- Save screenshots under `artifacts/screenshots/`.
- Always capture:
  - desktop home
  - mobile home
  - affected feature completion screen
- Mention screenshot paths in the final summary.
- If the app cannot run, explain why and stop before claiming success.
