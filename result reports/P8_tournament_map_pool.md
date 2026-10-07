# P8 — 대회 맵 풀만 적용

> 2026-10-07 · 브랜치 `feature/tournament-map-pool` · 테스트 **410개** 통과 · 브라우저 확인
> 리뷰: 워크플로 — 3관점(데이터 안전·화면·풀 데이터와 테스트) 탐색 → 발견마다 반박 검증. **확인 4건(중복 보고 7건) 전부 수정 / 기각 3건**(Undo 때 풀 밖 데이터 삭제 = 사용자 결정대로).

## A. 무엇을 · 왜

| 요청 · 결정 | 한 일 |
|---|---|
| "대회 맵도 이것뿐이니까 이것만 적용" | 사이드바 맵 = **대회 맵 풀 18개**(6모드 × 3맵), 표 순서 그대로. 제목 "Tournament map pool", 모드는 처음부터 모두 펼침 |
| 표의 "Map 1 (Tiebreaker Map)" | 각 모드 첫 맵에 **TIEBREAKER** 태그, 맵을 열면 제목 위에 "모드 · Tiebreaker map" |
| 표의 표기 | 화면에는 표 표기("Ring of Fire", "Out in the Open", "Belle’s Rock"), 이미지는 파일 이름(`Ring Of Fire`, `Out In The Open`, `Belles Rock`)으로 찾음 |
| 풀 밖 맵의 저장 데이터 → **삭제** (사용자 선택) | 보드를 불러올 때마다(부팅 · 파일 가져오기 · Undo) 풀 밖 맵의 티어 · 카드 순서 · 맵 노트 · 그림을 지움. 부팅 때 지웠으면 **배너**(닫기 전까지 유지)로 지운 맵 이름까지 알림, 가져오기 확인 창에는 "Left out: N maps" |
| 이미지 파일 → **그대로** (사용자 선택) | 1,300장은 그대로 두고 목록만 줄임 |

**다음 시즌에 맵 풀이 바뀌면** `js/map-pool.js` 한 파일만 고친다:

```js
{ mode: "Knockout", maps: [{ name: "Out In The Open", label: "Out in the Open" }, { name: "Belles Rock", label: "Belle’s Rock" }, "Goldarm Gulch"] },
//                          └ 파일 이름(Brawlstars map/Knockout/…png)  └ 화면 표기      첫 번째 = Tiebreaker ┘
```

`npm test` 가 모든 이름이 실제 이미지와 맞는지 확인한다(`tests/mappool.test.js`).

## C. Critical Path

### C-1. 🔴 삭제는 되돌릴 수 없다
- 지우는 것: 풀 밖 맵의 `mapPlacements` · `mapOrders` · `mapNotes` · `drawings`.
- 지우지 않는 것: **All Maps**, **Custom 보드**, 풀 맵의 **모든 버전** 그림(`모드/맵#버전id`), 브롤러 노트 · 역할.
- 이 버전을 처음 여는 순간 그 브라우저의 풀 밖 데이터가 지워진다. 필요하면 **이전 버전에서 Export 를 먼저** 해 둘 것.
- 파일 가져오기는 확인 창이 뜨기 *전에* 정리하므로, 창에 보이는 맵 보드 수가 실제로 들어올 수다.

### C-2. 풀 파일이 없으면 아무것도 지우지 않는다
`js/map-pool.js` 가 로드되지 않으면(배포 누락 등) 풀 키가 비고, `pruneToMapPool` 은 **빈 풀이면 아무것도 하지 않는다**(테스트로 고정). 그때 사이드바는 예전처럼 전체 카탈로그를 보여 준다. "목록이 비었으니 전부 삭제"가 일어날 수 없다.

### C-3. 같은 이름, 다른 모드
`Hideout` 은 Bounty 와 Wipeout 에, `Deathcap Trap` 은 Bounty 와 Gem Grab 에 있다. 풀은 **모드/맵 키**로 정하므로 표의 모드만 남는다(Wipeout/Hideout 데이터는 삭제 대상).

### C-4. 자산 버전
새 스크립트 `js/map-pool.js` 포함, 모든 자산 `?v=20261007.4`.

### C-5. 리뷰에서 고친 것
| 발견 | 고침 |
|---|---|
| 카탈로그 이전에 만든 Custom 보드 "Hideout"·"Deathcap Trap"·"Dry Season"·"Layer Cake" 가 **풀 맵으로 조용히 옮겨짐**. 풀 안에서는 이름이 하나뿐이라 "유일"로 판단했기 때문(전체 카탈로그에선 두 모드에 있음 → 원래 Custom 유지가 규칙) | `poolKeyForName`: **유일성은 전체 카탈로그로, 소속은 풀로** 판단. 겹치는 이름·풀 밖 맵 이름은 Custom 보드로 남음 |
| 부팅 삭제 알림(토스트)이 `#t=` 링크의 "불러오는 중"·오프라인 토스트에 즉시 덮임 | 되돌릴 수 없는 일이므로 **배너**로(닫을 때까지 유지, 지운 맵 이름 최대 5개). 저장소 문제 배너가 이미 있으면 그쪽 우선 |
| 820px 이하(사이드바 210px)에서 TIEBREAKER 태그 때문에 이름이 "Kaboo…" 로 잘림 | 좁은 화면에선 **TB**(화면낭독기는 "Tiebreaker"), 휴대폰 1열 레이아웃에선 다시 전체 단어 |
| 키보드 ' 로 "Belle's" 검색 시 못 찾음(라벨은 ’) | 검색에서 아포스트로피 무시 — "belle's"·"belle’s"·"belles" 모두 찾음 |

## D. 새로 도입한 것

| 무엇 | 설명 |
|---|---|
| `js/map-pool.js` (`BRAWL_MAP_POOL`) | 대회 맵 풀 데이터 — 시즌마다 고치는 유일한 파일 |
| `poolEntries` / `poolKeys` / `poolCatalog` (catalog.js) | 풀 정리(잘못된 항목 · `/` 포함 이름 · 중복 건너뜀) · 키 목록 · 전체 카탈로그를 풀 순서로 잘라 낸 카탈로그(+ 이미지 없는 항목 `missing`) |
| `pruneToMapPool` (storage.js) | 풀 밖 맵 데이터 삭제, 빈 풀이면 무동작, 멱등 |
| `searchCatalog` 라벨 검색 | 표 표기로도 검색, 대소문자·아포스트로피 무시 |
| `poolKeyForName(fullIndex, poolIndex)` | 옛 보드를 풀 맵으로 옮길지 판단(전체에서 유일 + 풀에 있음) |
| `showBanner(text)` | 상단 배너에 임의 문구(삭제 알림). `showStorageNotice` 도 이것을 씀 |
| 사이드바 280px | TIEBREAKER 태그를 붙여도 이름이 잘리지 않게(264 → 280px) |
