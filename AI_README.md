# AI_README.md — Team Brawl Tier List

> **이 문서의 목적**: AI가 `index.html`(860KB)을 다시 통째로 읽지 않고 맥락을 파악하기 위한 단일 진입점.
> 프로젝트 상태가 바뀌면 **이 문서를 먼저 갱신**한다.

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|---|---|
| 무엇 | 브롤스타즈 팀용 **맵별 브롤러 티어 리스트 보드** (World Finals 준비용). 드래그로 S~D 티어 배치·순서 조정, 브롤러/맵 노트, 커스텀 역할(Role) 태그, Export/Import, Share 링크, **맵 카탈로그(69 모드·1,126 맵) + 맵 이미지 그림판** |
| 형태 | 정적 웹앱 — `index.html` (HTML+CSS+UI 스크립트) + `js/` 순수 모듈 4개 + `Brawlstars map/` 이미지(56MB). 빌드·서버 없음 (맵 목록만 `npm run catalog` 로 생성) |
| 배포 | **GitHub Pages (FE 만)**. `index.html`, `js/`, `Brawlstars map/` 를 함께 올린다. (단일 파일 배포는 지원하지 않음 — 사용자 결정) |
| 외부 의존 | 브롤러 목록 `https://api.brawlapi.com/v1/brawlers` (10초 타임아웃, 실패 시 캐시 사용). 초상화 CDN `cdn.brawlify.com` |
| 저장 | 브라우저 `localStorage` (§4) |
| 테스트 | `node --test` (또는 `npm test`). Node ≥ 20, npm 의존성 **0** |
| 로컬 확인 | `.claude/launch.json` 의 `static` (python http.server 8765). `file://` 로 열어도 동작 |
| Git | 2026-10-07 `git init`. **`feature/map-catalog-drawing` → `feature/modernist-design` 모두 `main` 에 merge 완료**(`--no-ff`). **P7(`feature/short-tier-links`, 짧은 티어 링크·역할 고정) · P8(`feature/tournament-map-pool`, 대회 맵 풀)도 `main` 에 merge 완료.** 새 작업은 `feature/`·`fix/`·`docs/` 브랜치에서 하고 `main` 에 직접 커밋하지 않는다. 커밋은 영어 `type(scope): summary` (prompt.md Rule 9). 원격 저장소 없음(push 안 함) |
| 작업 디렉터리 | `C:\KoreaPenguin\Brawler Tier List` |

## 2. 🔴 index.html 읽는 법 (컨텍스트 폭발 주의) · 배포 전 필수

- **`js/`·`css/` 파일을 바꾸면 `index.html` 의 `?v=` 버전을 모두 같은 새 값으로 올린다.** GitHub Pages 는 파일을 ~10분 캐시한다. 새 `index.html` + 캐시된 옛 `js/storage.js` 조합이 부팅에서 앱을 깨뜨린 적이 있다. `tests/assets.test.js` 가 "모든 자산에 같은 버전"까지만 검사한다(올렸는지는 사람이 확인).

- **`SPECIAL_PORTRAITS` 의 두 줄(2026-10-07 P8 현재 363~364행)은 base64 PNG(COSMO·VINCE, 약 830KB)** 다. 파일 크기의 96%. 행 번호는 편집마다 바뀐다.
- 통째로 `Read`/`cat` 하지 않는다. 먼저 위치 확인: `awk 'length($0)>2000{print NR}' index.html` → 그 줄을 건너뛰고 읽는다 (`sed -n '1,360p;363,1500p' index.html` 또는 Read 의 offset/limit).

## 3. 파일 구조

| 파일 | 내용 |
|---|---|
| `index.html` | UI 전부. 아래 함수 지도 참고 |
| `css/modernist.css` | Claude Design 의 Modernist 디자인 시스템 원본 복사. **직접 수정 금지** |
| `js/drawing.js` | `window.BrawlDrawing`. 벡터 그림 엔진(도형 생성·검증·판정·실행취소·렌더). **DOM 접근 금지** (렌더는 받은 ctx 에만) |
| `js/catalog.js` | `window.BrawlCatalog`. 맵 파일명 파싱·정렬·키·URL·검색(이름·라벨)·유일 이름 조회 + **맵 풀**: `poolEntries`(풀 → `{mode,name,label,tiebreaker}`), `poolKeys`, `poolCatalog(catalog,pool)` → `{catalog, missing}` (풀 순서, 버전 복사), `poolKeyForName(fullIndex, poolIndex)`(옛 보드 이동: **전체 카탈로그에서 유일 + 풀에 있음**일 때만). 검색은 대소문자·아포스트로피 무시 |
| `js/map-pool.js` | `window.BRAWL_MAP_POOL` — **대회 맵 풀(P8). 시즌마다 이 파일만 고친다.** 모드별 맵 순서대로, 첫 맵 = Tiebreaker. 맵 = 파일 이름 또는 `{name, label}`(표기가 다를 때). `tests/mappool.test.js` 가 모든 이름이 이미지와 맞는지 확인 |
| `js/maps-catalog.js` | `window.BRAWL_MAP_CATALOG` — **생성 파일, 직접 편집 금지.** `npm run catalog` |
| `js/storage.js` | `window.BrawlStorage` (Node 에선 `require`, drawing.js 의존). **DOM 접근 금지.** 상태 검증·저장소 래퍼·전송 형식·v4 맵 모델 |
| `tools/build-map-catalog.js` | `Brawlstars map/` → `js/maps-catalog.js` (PNG 헤더에서 크기까지) |
| `Brawlstars map/<모드>/<맵>[ (<버전id>)].png` | 맵 이미지 1,300장 |
| `tests/storage.test.js` · `transfer.test.js` · `board.test.js` · `catalog.test.js` · `drawing.test.js` | 저장 · 전송 · v4 맵 모델 · 카탈로그(폴더와 생성 파일 일치 포함) · 그림 엔진. 합계 294개 |
| `package.json` | `test`, `catalog` 스크립트. 의존성 없음 |
| `tests/roles.test.js` · `tests/assets.test.js` · `tests/tierlink.test.js` · `tests/mappool.test.js` | 공식 클래스 역할 · 자산 버전 쿼리 · `#t=` 링크 · 실제 맵 풀 파일 |

로드 순서(index.html): `drawing.js` → `catalog.js` → `maps-catalog.js` → `map-pool.js` → `storage.js` → 인라인 스크립트.
| `result reports/` | Phase 별 리뷰 |

### `js/storage.js` 공개 API

| 함수 | 역할 |
|---|---|
| `normalizeState(raw)` → `{state, warnings}` | 어떤 값이든 타입이 맞는 보드로. **UI 가 만들 수 있는 데이터는 무손실** (테스트로 고정). 잘못된 타입·`__proto__` 키만 버림 |
| `createStore(storage, key)` | `load()` → `{status: ok\|empty\|corrupt\|newer\|unavailable}`, `save()` → `{ok, reason}`, `quarantine()`, `saveBackup/loadBackup/hasBackup/clearBackup/readBackupRaw/writeBackupRaw`, `saveRoster/loadRoster`. **절대 throw 안 함** |
| `reconcileWithRoster(state, names)` | **All Maps 에만** 새 브롤러 채움. 다른 맵은 `tierOf` 로 All Maps 를 따라 보여줌 |
| `tierOf` / `placementFor` / `orderFor` | **읽기 전용 뷰** (새 객체 반환, state 불변). 렌더는 이것만 쓴다 |
| `materializeMap(state, key, names)` | 편집 직전 호출: 보이는 상태를 그 맵에 복사해 독립(**roster 브롤러만** 복사). 반환 `{table, order}` 를 수정 |
| `upgradeBoard(state, uniqueKeyForName, isCatalogKey)` | All Maps 보장(대소문자 변형은 합침, 지워졌던 경우 빈 표로 새로) + 옛 보드를 유일한 카탈로그 맵으로 이동(충돌 시 Custom 유지) + 카탈로그 키와 같은 이름의 Custom 은 목록에서 제거. 멱등 |
| `encodeTierLink(state, roster)` / `decodeTierLink(hash)` / `applyTierLink(state, link, roster)` / `brawlerCode(b)` | **현재 Share 링크 `#t=`** (P7). 형식: `#t=` + 코드 폭(16진 1자리, 2~6) + S·A·B·C·D 의 브롤러 코드를 카드 순서대로, 티어 사이 `g` + (있으면) `r` + `코드+역할마스크(2자리)` — **공식 클래스와 역할이 다른 브롤러만**. 코드 = API id − 16000000 (16진수). 노트·역할 목록·맵 데이터 없음. 108명 ≈ 226자. 디코드는 roster 없이 구조만 검사(길이 8192자 상한, 잘못되면 `{ok:false}`), 적용은 받는 사람 보드 **사본**의 All Maps 만 교체 — 링크에 없는 브롤러는 **B 맨 뒤(받는 사람의 기존 순서)**, 모르는 코드는 세고 건너뜀. 반환 `{state, listed, unknown, missing}` |
| `pruneToMapPool(state, poolKeys)` | 풀 밖 맵의 `mapPlacements`·`mapOrders`·`mapNotes`·`drawings` 삭제(All Maps·Custom 보드·풀 맵의 모든 버전 그림은 유지). **풀 키가 비면 아무것도 안 함**(풀 파일 누락이 전체 삭제로 이어지지 않게). 반환 `{maps: 내용 있던 삭제 맵, drawings}`. 멱등 |
| `ensureClassRoles(state, roster)` | **역할 = 공식 클래스 7종 고정**. 사용자 역할은 버림, 클래스 이름은 대소문자 정규화, 항목 없는 브롤러는 자기 클래스로 태그, 일부러 비운 `[]` 은 유지. 멱등 |
| `shareableState` / `mergeSharedBoard` | **구형 링크(`#z=`/`#data=`) 열기 전용**: 그 부분(All Maps·브롤러 노트·역할)만 교체 |
| `syncOrder(order, names)` | 카드 순서 동기화. **가지치기 안 함** (API 실패 시 순서 소실 방지) |
| `baseTable(state)` | 새 맵·새 브롤러가 복사할 'All Maps' 표. All Maps 가 `maps` 에 없으면 `null` |
| `parseBoardJson(text)` | 외부 JSON 검증 → `{ok, state, warnings, exportedAt}` 또는 `{ok:false, code, error}`. 외부 데이터 상한: 2M자, 맵 ≤ 200, 역할 ≤ 200, 브롤러 키 표·목록 ≤ 1000, 이름 ≤ 100자 (자기 저장 데이터엔 상한 없음) |
| `buildExportJson(state, at)` / `encodeShareHash(state)` / `decodeShareHash(hash)` | 전송 형식. 링크는 base64url, 구형 표준 base64 도 읽음 |
| `encodeShareHashAsync` / `decodeShareHashAsync` / `isShareHash` / `inflateCapped` | (P6, 이제 **열기만**) **압축 링크 `#z=…Z`** (deflate-raw, 끝 표시 `Z` 필수). 해제는 2M자×3바이트 상한에서 중단(zip bomb 방어). `deflate-raw` 미지원이면 `#data=` 로 대체. 구형 `#data=` 도 열림 |
| `addClassRoles(state, roster, {newOnly})` / `CLASS_ORDER` / `CLASS_ROLE_COLORS` / `labelInkFor(hex)` | 공식 클래스 7종을 역할로 만들고 전원 배정(기존 유지·대소문자 무관 재사용·멱등). `newOnly`: 역할 항목이 없는 신규 브롤러만, 역할 생성 없이. `labelInkFor`: 역할 색 위 글자색(WCAG 대비) |
| `createDebouncer(fn, ms, timers?)` | 노트 자동 저장용 |
| `isReservedName(name)` | `constructor` 등 `Object.prototype` 멤버 이름 — 맵 이름으로 금지 |

### `index.html` 함수 지도 (이름으로 찾을 것)

| 영역 | 함수 / 핸들러 |
|---|---|
| 부팅 | `boot()` — 저장 데이터 동기 로드 → 캐시 roster 로 렌더 → Share 해시 확인 → `fetchRoster()` → 대조·역할 고정·저장·재렌더 → `rosterSettled()` (기다리던 `#t=` 링크 진행) |
| 저장 | `loadSavedState()`, `persist()` (**false 반환 = 저장 실패**, 배너 표시), `showStorageNotice()`, `saveBlocked`/`storageFailing` |
| 맵 키 | `FULL_CATALOG`(전체) / `MAP_POOL`·`POOL_KEYS` / `CATALOG`(**풀만** — 풀 파일이 없으면 전체) / `catalogIndex`(CATALOG 색인). `catalogEntry`, `isValidMapKey`, `mapLabel`(라벨 우선), `mapContext`(모드 + Tiebreaker), `upgradeLoadedBoard`(**옛 보드 이동(`adoptKeyForName`) + 풀 밖 데이터 삭제**, 부팅·파일 가져오기·Undo 에서 호출, 삭제 결과 반환 — 부팅 삭제는 `showBanner` 로 알림), `splitImageKey`, `isVisibleImageKey`, `unlistedMapKeys`/`unlistedDrawingKeys` (카탈로그에서 사라진 데이터) |
| 보드 | `viewPlacement`/`viewOrder` (읽기), `editMap` (편집 전 필수), `moveBrawlerBefore`, `moveBrawlerToTierEnd`, `renderBoard`, `selectBrawler`, `renderNotes`, `renderAll` |
| 사이드바 | `renderSidebar` (All Maps → **Tournament map pool**: 모드별, 기본 모두 펼침, Map 1 에 TIEBREAKER 태그 → Custom boards → No longer in the map list), `openMap`, `deleteCustomBoard`, `deleteUnlisted`, `expandedModes` |
| 맵 보기·그림 | `renderMapView` (버전 탭·이미지), `layoutCanvas`, `redraw`, `startGesture`/`moveGesture`/`finishGesture`, `commitDrawing`/`storeDrawing`, `undoDrawing`/`redoDrawing`, `exportMapPng`, `portraitImage`, `drawState`, `drawHistories` |
| 역할 | `renderRoleFilters` (필터 칩, 잘못된 `activeRole` 은 해제), `openRoleAssignment` (선택한 브롤러의 역할 켜고 끄기). **Manage roles(만들기·이름 변경·삭제·색) 기능은 P7 에서 삭제** |
| 역할 고정 | `BrawlStorage.ensureClassRoles(state, roster)` 를 **부팅 2단계·`replaceBoard`·Undo import** 에서 호출 → 어떤 보드가 들어와도 공식 7종 |
| 디자인·접근성 (P5) | `css/modernist.css`(디자인 시스템 원본, 수정 금지) + 인라인 `<style>` 앱 층. `icon(name)`(Lucide 스프라이트), `readableOn(hex)`, `openDialog/closeDialog`, `keepFocus`(렌더러 래핑, `data-focus-key`), `renderTierPicker`, `--top-h` |
| 노트 자동 저장 | `noteSaver` (500ms 디바운스), `#brawlerNote`/`#mapNote` 의 `input`, `pagehide`/`visibilitychange` flush |
| Export | `#exportBtn`, `localDateStamp` |
| Import·Share | `#importFile` change → `offerBoard()` → `replaceBoard()` (**순서가 안전장치** — P2 리뷰 §C-1); `openSharedBoardFromHash()` (+ `hashchange`) → `#t=` 면 `rosterReady`(부팅의 네트워크 시도 후 settle)를 기다려(대기 중엔 안내 토스트, 대기 링크는 `pendingTierLink` 하나 — 마지막 것이 이김) `offerTierLink()` → `replaceBoard`, 구형이면 `offerBoard()`; `rosterHasIds`; `#undoImportBtn`, `renderUndoImport()`, `resetViewForNewBoard()` (Share 모달도 닫음); `#shareBtn` (`encodeTierLink`, roster 없으면 토스트), `#copyShare`. Export/Share 는 자기 출력을 같은 검증기로 재검사 |

## 4. 데이터 모델

```js
// localStorage["team-brawl-v2"] — 메타 필드는 최상위에 섞여 있다(구버전 코드 호환)
{
  app: "team-brawl", schemaVersion: 4,              // 없으면 v2. 4 = 카탈로그 키 + drawings
  project: "World Finals Prep",
  maps: string[],                                  // "All Maps" + Custom 보드만 (카탈로그 맵은 여기 없음)
  tiers: ["S","A","B","C","D"],                    // 항상 고정
  placements: { [brawler]: tier },                 // 레거시. persist() 가 'All Maps' 사본으로 유지
  mapPlacements: { [mapKey]: { [brawler]: tier } },// mapKey = "All Maps" | "모드/맵"(P8: 대회 맵 풀만) | Custom 이름. 편집한 맵만 존재
  mapOrders: { [mapKey]: brawler[] },              // 맵별 카드 순서 (은퇴 브롤러도 유지). 편집한 맵만
  notes: { [brawler]: string },                    // 브롤러 노트 — 맵과 무관(전역)
  mapNotes: { [mapKey]: string },
  roles: { name: string, color: "#rrggbb" }[],     // P7: 항상 공식 클래스 7종(CLASS_ORDER·CLASS_ROLE_COLORS). ensureClassRoles 가 고정
  brawlerRoles: { [brawler]: roleName[] },
  drawings: { [imageKey]: shape[] },              // imageKey = "모드/맵" | "모드/맵#버전id". 도형은 js/drawing.js 형식
  classRolesAdded: boolean                         // P6 레거시. P7 부터 ensureClassRoles 가 항상 true 로 둠 (의미 없음)
}
```

| localStorage 키 | 내용 |
|---|---|
| `team-brawl-v2` | 보드 (위) |
| `team-brawl-v2:recovery` | 손상·신버전 데이터를 덮어쓰기 전에 격리한 원문 `{reason, at, raw}` (최신 1건) |
| `team-brawl-v2:import-backup` | Import 직전 보드 `{savedAt, source, board}` (1단계, Undo 시 삭제) |
| `team-brawl-v2:roster` | 브롤러 목록 캐시 `{savedAt, list}` (~20KB) |

- 브롤러 데이터의 키는 **API 표시 이름**이다(id 아님).
- UI 전용 상태(저장 안 됨): `currentMap`, `activeRole`, `selected`, 검색어, 펼친 모드, 버전 선택, 그림 도구·색·크기, 실행취소 기록.
- 🔴 **state 에 필드를 추가하면 `normalizeState` 에도 추가할 것** — 안 그러면 다음 부팅에서 사라진다.

## 5. 알려진 위험 · 남은 일

| 항목 | 상태 |
|---|---|
| **여러 탭 동시 사용** | 마지막에 저장한 탭이 전체를 덮어씀. 사용자가 동기화 기능은 제외함. Share 링크를 새 탭에서 열면 쉽게 발생 → **최소 가드(다른 탭 변경 감지 배너 + 저장 중지) 결정 대기** |
| 역할 이름 변경·관리 모달 | **해소** — P7 에서 Manage roles 기능 자체를 삭제(역할 고정) |
| 브롤러 코드 | 링크는 **API id** 에 의존. API 가 id 를 바꾸거나 빼면 그 브롤러는 링크에 안 들어가고(보낼 때) "모르는 코드"로 건너뜀(받을 때) |
| 브롤러 공식 이름 변경 | 노트·티어가 고아가 됨 (이름 키) |
| Share 링크 | P7: `#t=` 약 226자(108명). 노트는 Export 로만 |
| 디자인 변경 (P5) | 완료 (Modernist). 디자인을 바꾸려면 Claude Design 쪽 시스템을 고친 뒤 `css/modernist.css` 를 다시 복사 |
| `Coding_Convention.md` | prompt.md 가 참조하지만 **없음** |

## 6. 문서 맵

| 문서 | 내용 |
|---|---|
| [prompt.md](prompt.md) | 일하는 방식 (Core Rules). **모든 작업 전 준수** |
| [result reports/P1_storage_hardening.md](result%20reports/P1_storage_hardening.md) | P1 — 저장 보강·노트 자동 저장. **§C-1 무손실 불변식** |
| [result reports/P2_export_import_share.md](result%20reports/P2_export_import_share.md) | P2 — Export/Import/Share. **§C-1 교체 순서, §C-4 탭 덮어쓰기 시나리오** |
| [result reports/P3_map_catalog.md](result%20reports/P3_map_catalog.md) | P3 — 카탈로그·v4 모델. **§C-1 "보기는 쓰지 않는다" 불변식, §C-2 데이터 이전** |
| [result reports/P4_map_drawing.md](result%20reports/P4_map_drawing.md) | P4 — 그림판. **§C-1 크기 상한** |
| [result reports/P5_modernist_design.md](result%20reports/P5_modernist_design.md) | P5 — 디자인. **§C-1 의도적 예외, §C-2 `[hidden]` 규칙** |
| [result reports/P6_dark_roles_links.md](result%20reports/P6_dark_roles_links.md) | P6 — 다크·클래스 역할·압축 링크. **§C-1 자산 버전 쿼리, §C-4 다크 램프** |
| `AI_README.md` | 이 문서 |

## 7. 작업 이력

- **2026-10-06 요청**: ① localStorage 브라우저 저장 ② 결과 Export & Import.

| 결정 (사용자 승인) | 내용 |
|---|---|
| 저장 보강 | 오류 처리 + API 실패 데이터 유실 수정 + `schemaVersion` — 항상 포함 |
| 추가 저장 기능 | **노트 자동 저장**만 (마지막 화면 기억·스냅샷·탭 동기화 **제외**) |
| Import | **전체 교체 + 자동 백업 + Undo import** |
| 전송 범위 | JSON 파일 + **Share 링크 열기** (붙여넣기·맵 단위·PNG **제외**) |
| 구조 | 순수 로직 `js/storage.js` 분리 + `node --test` |
| 배포 | GitHub Pages |

- **Phase 1 완료** — 저장 보강 + 노트 자동 저장.
- **Phase 2 완료** — Export/Import/Undo/Share 링크.
- **리뷰 완료** — 1차(4관점 + 반박 검증) 확인 23건 전부 수정 → 2차(수정 검증) 23건 수정 확인 + 새로 확인된 중간 1·낮음 3·테스트 공백 4 수정. **테스트 162개.**
- 사용자 승인 없이 추가한 것: **roster 캐시**(API 장애 시 보드 사용 가능하게) — 원치 않으면 `saveRoster/loadRoster` 호출 제거.

### 2026-10-07 요청: 디자인 변경 + 맵 카탈로그 + 맵 이미지 그림판

| 결정 (사용자 승인) | 내용 |
|---|---|
| 디자인 | Claude Design 프로젝트 `d3429653-…` ("Index.html 미리보기"). 2026-10-07 사용자 `/design-login` 후 읽음. 내용 = 원본 index.html(변경 없음) + **Modernist 디자인 시스템**(`_ds/modernist-…/styles.css`·`readme.md`) + 옛 화면 스크린샷(역할 필터 "All" 칩에 빨간 동그라미). → **Modernist 를 앱 전체에 적용** (`css/modernist.css` 로 원본 복사, 앱 CSS 는 그 토큰만 사용). 지도·초상화는 흑백 처리하지 않음(게임 정보 색 유지) |
| 맵 목록 | **사이드바 = 전체 카탈로그** (`Brawlstars map/` 69 모드 · 1,300 PNG · 56MB, 버전 묶으면 1,126 맵). 모드별 접기 + 검색. Manage Maps 없어짐 |
| 키 | **`"모드/맵"`** (115개 이름이 여러 모드에 중복). 티어표·맵 노트는 맵 단위(버전 공유), **그림은 이미지(버전) 단위** |
| 지연 생성 | **맵을 열기만 해서는 저장하지 않음.** 편집 전에는 All Maps 티어를 따라가고, 첫 드래그 때 복사되어 독립 |
| 기존 데이터 | 카탈로그에 이름이 하나만 맞는 맵은 자동 연결, 나머지는 사이드바 하단 **Custom** 에 보존 |
| 같은 이름 다른 버전 | 하나로 묶고 버전 탭 (`Backyard Bowl (15000663).png` → 버전 `15000663`) |
| 그림판 | 펜(색·굵기)·지우개(획 단위)·실행취소·전체 지우기 + **직선/화살표·텍스트·브롤러 아이콘·PNG 저장 전부** |
| 그림 저장 | localStorage + **Export 만** (벡터 좌표 0~10000, 점 단순화, 이미지당 점 20,000개 상한) |
| Share 링크 (2026-10-07 변경) | **맵 데이터는 링크에 넣지 않음** — 링크 = All Maps 티어·순서·노트 + 브롤러 노트 + 역할만. 맵별 티어·순서·노트·그림은 **Export 파일로만**. 링크를 열면 그 부분만 교체하고 받는 사람의 맵 데이터·그림은 유지(실측: 맵 20개 편집 시 링크 65,000자 → 약 3,200자) |
| 진행 순서 | P3 카탈로그+데이터 v4 → P4 그림 엔진(`js/drawing.js`) → P5 디자인 적용 + UI |

- **P3 완료**(기존 스타일로 UI 연결) · **P4 완료** · P5 대기(디자인 접근).
- **리뷰 완료** — 4관점 + 반박 검증, 확인 18건 전부 수정. **테스트 300개.** git 커밋 단위로 반영.
- **2026-10-07 후속 요청 (승인 = 사용자 지시)**: ① **다크 모드로** — Modernist 의 구조(각진 모서리·2px 규칙선·Archivo·빨강 강조)는 유지하고 바탕만 어둡게(밝은 테마 없음) ② **공식 브롤러 클래스로 역할 기본 생성**(영어) — API 의 `class`: Damage Dealer·Tank·Assassin·Support·Controller·Marksman·Artillery, 108명 전원 배정 ③ **Share 링크 압축**(deflate, 실측 7,968자 → 약 2,130자)
- **2026-10-07 링크 재설계 요청 (사용자 지시)**: 링크 = **All Maps 티어+순서를 브롤러 16진수 코드(공식 ID−16000000, `00`=Shelly … `6e`=Vince)로 티어별 나열** + **공식 클래스와 다른 역할만**. 노트·역할 목록 제외. **역할은 공식 클래스 7종 고정, Manage roles 기능 삭제**(브롤러별 역할 켜고 끄기는 유지). 링크에 없는 브롤러는 B 티어 맨 뒤. 예전 `#z=`/`#data=` 링크는 계속 열림
- **2026-10-07 대회 맵 풀 요청 (사용자 지시, P8)**: 사이드바 맵은 **대회 맵 풀 18개만**(6모드 × 3맵, 표 순서: Bounty·Heist·Hot Zone·Gem Grab·Knockout·Brawl Ball, 모드 안은 Map 1·2·3). Map 1 = **Tiebreaker** 표시. 표기는 표를 따름(예: "Ring of Fire", "Belle’s Rock" — 파일 이름은 `Ring Of Fire`, `Belles Rock`). **풀 밖 맵의 저장 데이터(티어·순서·맵 노트·그림)는 삭제**(사용자 선택: 부팅·가져오기·Undo 때 정리, Custom 보드와 All Maps 는 유지). **이미지 파일은 그대로**(목록만 줄임 → 다음 시즌엔 `js/map-pool.js` 만 고치면 됨). 브랜치 `feature/tournament-map-pool`
- **P7 완료** — 짧은 티어 링크 `#t=`(1,892자 → 약 226자) + 역할 공식 7종 고정 + Manage roles 삭제. [P7 리뷰](result%20reports/P7_short_tier_links.md)
- **P6 완료** — 다크 테마·공식 클래스 역할·압축 링크 + 리뷰 확인 9건 수정. **테스트 343개.** [P6 리뷰](result%20reports/P6_dark_roles_links.md)
- **P5 완료** — 브랜치 `feature/modernist-design`(`feature/map-catalog-drawing` 기반). Modernist 적용 + 리뷰 확인 31건 중 30건 수정(1건 시스템 규칙상 유지). [P5 리뷰](result%20reports/P5_modernist_design.md)

- 확인된 사실: brawlify 초상화 CDN 은 `Access-Control-Allow-Origin: *` → PNG 저장 시 초상화 포함 가능.
