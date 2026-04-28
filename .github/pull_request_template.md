<!-- PR 유형에 맞는 섹션만 남기고 나머지는 삭제하세요 -->
<!-- 티켓이 있으면 PR title에 scope로 포함: feat(ABC-123): 설명 -->

## Summary

<!-- 변경 사항을 1-3줄로 요약 -->

## Type

<!-- 해당하는 항목에 x 표시 -->

- [ ] Bug Fix
- [ ] Feature
- [ ] Figma Implementation
- [ ] Refactor
- [ ] Docs
- [ ] Chore

---

<!-- ==================== Bug Fix ==================== -->
<!-- Bug Fix가 아니면 이 섹션을 삭제하세요 -->

### Root Cause

<!-- 근본 원인 (파일:라인, 원인 설명, 발생 조건) -->

### Fix

<!-- 수정 내용 요약 -->

### Regression Test

<!-- 추가된 회귀 테스트 설명 -->

<!-- ==================== Feature ==================== -->
<!-- Feature가 아니면 이 섹션을 삭제하세요 -->

### Requirement

<!-- 구현한 요구사항 요약 -->

### Changes

## <!-- 주요 변경 사항 목록 -->

<!-- ==================== Figma Implementation ==================== -->
<!-- Figma Implementation이 아니면 이 섹션을 삭제하세요 -->

### Design Reference

<!-- Figma URL -->

### Visual Fidelity

| 항목              | 상태        | 비고 |
| ----------------- | ----------- | ---- |
| 레이아웃/스페이싱 | Pass / Fail |      |
| 타이포그래피      | Pass / Fail |      |
| 색상              | Pass / Fail |      |
| 컴포넌트 상태     | Pass / Fail |      |
| 반응형            | Pass / Fail |      |

### Intentional Deviations

<!-- Figma와 의도적으로 다르게 구현한 부분 + 사유. 없으면 "없음" -->

### DS Gap

<!-- DS에 없어서 커스텀으로 구현한 컴포넌트. 없으면 "없음" -->

---

## Scope

<!-- 변경된 모듈에 x 표시 -->

- [ ] Frontend (`chat-client-vue`)
- [ ] Backend (`client-api`)
- [ ] Design System (`chat-client-design-system`)
- [ ] Infra / CI
- [ ] Data Pipeline

## Risk Assessment

<!-- 해당 없으면 "없음"으로 기재 -->
<!-- risky-change 감지 항목: DB 마이그레이션, enum 변경, 인증/인가, @Transactional, Port 시그니처, API 경로, 설정 변경 등 -->

- **Level**: None / MEDIUM / HIGH / CRITICAL
- **Detail**:

## Test Plan

- [ ] 단위 테스트 통과
- [ ] 타입 체크 통과
- [ ] 린트/포맷 통과
- [ ] 수동 검증: <!-- 수동 확인이 필요한 항목 기술 -->
