# P1 — localStorage 저장 보강 + 노트 자동 저장

> 2026-10-06 · 테스트 `node --test` 74개 통과 · 브라우저(로컬 서버) 수동 검증 완료
> 근거: 기존 코드 감사 워크플로(발견 3관점 → 관점별 반박 검증) — 확인된 결함 대부분이 이 Phase 범위

## A. 무엇을 · 왜

**흐름 (boot)**: `localStorage` 먼저 읽기 → 정규화 → 캐시된 roster 로 즉시 렌더 → API fetch(10초 타임아웃) → roster 대조 → 저장 → 재렌더.
기존에는 fetch 가 끝나야 저장 데이터를 읽었고(그동안 `state=null` 이라 버튼이 예외를 던짐), API 가 실패하면 저장 데이터를 깎아냈다.

| 변경 | 이유 |
|---|---|
| `js/storage.js` 신설 — `normalizeState` / `createStore` / `syncOrder` / `reconcileWithRoster` / `createDebouncer` | 저장·검증 로직을 DOM 없이 테스트하기 위해 (승인된 구조) |
| `normalizeState` 가 모든 필드를 **타입 검사** | 기존 `x \|\| 기본값` 은 truthy 면 통과 → 잘못된 타입이 저장된 뒤 렌더에서 터져 **매 새로고침마다 빈 화면** |
| `createStore` 가 모든 storage 예외를 결과값으로 변환 | 차단된 저장소(SecurityError)·용량 초과(Quota)가 핸들러 중간에서 throw 되어 화면·저장 불일치 |
| 손상/신버전 데이터는 `team-brawl-v2:recovery` 로 **격리 후** 진행 | 기존엔 손상 JSON 을 조용히 기본 보드로 덮어써 복구 불가 |
| `syncOrder` — 순서 목록을 **절대 가지치기하지 않음** | API 실패(roster=[]) 시 모든 맵의 카드 순서가 `[]` 로 저장되던 버그 (감사에서 재현됨) |
| `reconcileWithRoster` — 기존 맵에도 새 브롤러 채움 | 새로 출시된 브롤러가 'All Maps' 외 맵에서 **영영 안 보이던** 버그 |
| roster 를 `team-brawl-v2:roster` 에 캐시 | API 장애 시에도 보드를 쓸 수 있게. ⚠️ 승인 항목 "데이터 유실 버그"에 묶어 넣은 **추가 판단** — 원치 않으면 제거 가능 |
| 노트: 입력 즉시 `state` 반영 + 500ms 디바운스 저장, `pagehide`/탭 숨김 시 즉시 flush | 패널 문구("자동 저장")가 거짓이었고, 브롤러/맵 전환·재렌더가 입력 중인 텍스트를 덮어씀 |
| 역할 칩을 `innerHTML` → DOM API, 색상은 `#rrggbb` 만 허용 | 색상 값이 이스케이프 없이 `innerHTML` 에 들어가던 **저장형 XSS 싱크** (Import 도입 전 선제 차단) |
| 렌더 경로(`getMapPlacement`)에서 `persist()` 제거 | 맵을 *보기만* 해도 저장 → 오래된 탭이 최신 데이터를 덮어씀 |
| 'All Maps' 를 이름 변경/삭제한 경우 유령 보드를 되살리지 않음 (`baseTable`) | 오래된 `placements` 로 숨은 'All Maps' 가 재생성되고 새 맵이 그걸 복사하던 버그 |
| `__proto__`·`constructor` 등 예약어 맵 이름 차단 + `hasOwn` 조회 | 맵 이름이 객체 키로 쓰여 프로토타입 오염·렌더 크래시 |
| `schemaVersion: 3` 저장 (필드 없음 = v2) | 이후 Import·마이그레이션이 버전을 판별하도록 |

## C. Critical Path — 데이터 정합성

### C-1. "UI 가 만들 수 있는 데이터는 정규화에서 1바이트도 안 바뀐다" 가 핵심 불변식
`normalizeState` 는 부팅 때마다 **사용자 본인 데이터**에 실행된다. 여기서 뭔가를 버리면 그게 곧 데이터 유실이다.
- 테스트 `keeps everything the current UI can produce, unchanged` 가 이를 고정한다. UI 가 실제로 만들 수 있는 이상한 값(이름 변경으로 생긴 **중복 역할명**, 은퇴 브롤러가 남은 순서, `constructor` 라는 이름의 맵, 한글·이모지)을 일부러 넣었다.
- 그래서 일부러 **하지 않은 것**: 역할 중복 제거, 이름 trim, 이름 길이 제한, roster 에 없는 브롤러 키 삭제.
- 🔴 **새 필드를 state 에 추가할 때는 `normalizeState` 에도 반드시 추가**해야 한다. 안 그러면 다음 부팅에서 조용히 사라진다(알 수 없는 최상위 필드는 버린다).

### C-2. 저장 실패는 이제 throw 하지 않고 `persist()` 가 `false` 를 반환한다
- 실패 시 상단 배너(빨강)가 뜨고, "Saved …" 토스트는 성공했을 때만 뜬다.
- `saveBlocked`: 손상 데이터를 **격리하는 것마저 실패**하면(용량 부족 등) 이번 세션은 저장을 멈춘다. 원본을 덮어쓰는 것보다 저장 안 하는 게 낫다는 판단. 배너가 Export 를 안내한다.
- 격리 키 `:recovery` 는 **최신 1건만** 보관한다(두 번째 손상 시 첫 번째 사본은 덮어씀).

### C-3. "newer" 상태 (신버전이 저장한 데이터를 구버전이 읽음)
GitHub Pages 에서는 롤백할 때만 발생. 원본을 `:recovery` 에 격리한 뒤, 이 버전이 이해하는 부분만 로드해서 계속 쓴다. 롤백 후 되돌릴 때 `:recovery` 에서 수동 복구가 필요할 수 있다.

### C-4. ⚠️ 남은 위험 — 여러 탭 (사용자 결정으로 미구현)
여전히 **마지막에 저장한 탭이 전체 state 를 덮어쓴다.** 이번에 렌더 경로의 저장을 없애서 "보기만 해도 덮어씀"은 사라졌지만, 오래된 탭에서 드래그·노트 입력을 하면 다른 탭의 변경이 사라진다.
P2 에서 Share 링크를 새 탭으로 열면 이 상황이 자연스럽게 생긴다(기존 탭이 열린 채로 새 탭에서 import). **최소 대책(`storage` 이벤트로 "다른 탭에서 변경됨 — 새로고침" 배너 + 그 탭 저장 중지)을 권한다.** 결정 필요.

### C-5. 노트 디바운스의 경계
- 키 입력마다 `state` 는 즉시 바뀌고 **저장만** 500ms 지연된다. 그래서 "어느 브롤러의 노트인가"는 입력 시점에 결정된다(전환 경쟁 조건 없음).
- 탭을 강제 종료(프로세스 kill)하면 마지막 500ms 이내 입력은 잃을 수 있다. `pagehide`/`visibilitychange` 로 일반적인 닫기·탭 전환은 flush 된다.

### C-6. GitHub Pages 의 localStorage 범위
`<user>.github.io` 아래 **모든 저장소가 같은 origin** 이라 localStorage 를 공유한다. 키 접두사 `team-brawl-v2` 로 구분되지만, 같은 계정의 다른 Pages 프로젝트가 같은 키를 쓰면 충돌한다. 5MB 한도도 공유한다.

### C-7. 동작 변경 (사용자 체감)
- 기존에 'All Maps' 외 맵에서 **안 보이던 브롤러가 나타난다** (All Maps 의 티어로, 없으면 B). 버그 수정이지만 처음 보면 "갑자기 생겼다"고 느낄 수 있다.
- 'All Maps' 를 지웠거나 이름을 바꾼 사용자는, 새 맵이 오래된 데이터 대신 **전부 B 티어**로 시작한다.
- 브롤러를 선택하기 전에는 노트 입력칸이 비활성화된다(입력해도 갈 곳이 없어 사라지던 문제).

## D. 새로 도입한 것

| 무엇 | 설명 |
|---|---|
| `js/storage.js` (UMD 형태 일반 script) | 브라우저에선 `window.BrawlStorage`, Node 에선 `require`. ES module 이 아닌 이유: `file://` 에서도 열리게 |
| `node --test` (Node 내장 테스트 러너) | npm 의존성 0. `npm test` 또는 `node --test` 로 실행 (Node ≥ 20) |
| `package.json` | 의존성 없음. `test` 스크립트만 |
| `.claude/launch.json` | 로컬 확인용 정적 서버 (`python -m http.server 8765`). 배포와 무관 |
| localStorage 키 2개 추가 | `team-brawl-v2:recovery` (격리 사본), `team-brawl-v2:roster` (roster 캐시, 약 20KB) |

### 작업 중 눈에 띈 것 (범위 밖, 감사에서 확인됨)
- 역할 이름 변경에 중복 검사가 없어, 중복된 둘 중 하나를 지우면 **다른 쪽의 브롤러 지정까지 지워진다.**
- 활성 필터인 역할의 이름을 바꾸면 보드가 비어 보인다(`activeRole` 미갱신).
- Manage Maps / Roles 모달에서 다른 행의 저장 안 한 편집이 조용히 버려진다.
- 브롤러 데이터가 API 표시 이름을 키로 쓴다 → 공식 이름이 바뀌면 노트·티어가 고아가 된다.
