# P3 — 맵 카탈로그 · 데이터 모델 v4 · 맵 이미지 보기

> 2026-10-07 · 전체 테스트 `node --test` **300개** 통과 · 브라우저(데스크톱 1280·1500×900 / 모바일 375) 검증
> 리뷰: 4관점(데이터 모델·UI 흐름·신뢰 경계·테스트) 발견 → 관점별 반박 검증. **확인 18건 / 기각 4건**, 확인된 것 전부 수정·커밋.
> 디자인 변경(P5)은 아직 — Claude Design 프로젝트를 읽을 권한이 없어 기존 스타일로 연결했다.

## A. 무엇을 · 왜

**흐름**: `Brawlstars map/` 폴더 → `npm run catalog` → `js/maps-catalog.js` → 사이드바(모드별 접기 + 검색) → 맵 클릭 → 이미지 + 버전 탭 + 티어표 + 노트.

| 변경 | 이유 |
|---|---|
| `tools/build-map-catalog.js` → `js/maps-catalog.js` (84KB, 69 모드 · 1,126 맵 · 1,300 이미지) | GitHub Pages(정적)는 폴더 목록을 못 읽는다. PNG 헤더 24바이트만 읽어 크기까지 기록 → 이미지 로딩 전에 캔버스 자리를 정확히 잡음 |
| `js/catalog.js` | 파일명 파싱(`Name (15000663).png` = 버전), 정렬, 키, URL 인코딩(`&`·공백), 검색, "이름이 정확히 하나의 모드에만 있는가" 조회 |
| 키 `"모드/맵"` | **115개 맵 이름이 여러 모드에 중복**(예: Crossroads = Bounty·Heist·Lone Star) |
| 사이드바 = 전체 카탈로그, Manage Maps 제거 | 사용자 결정. 편집한 맵·노트·그림이 있는 맵은 보라색 점 |
| **보기는 저장하지 않음 / 첫 편집 때 복사** (`placementFor`·`orderFor` / `materializeMap`) | 1,126개 맵을 둘러보기만 해도 티어표가 생기면 localStorage(5MB)가 찬다 |
| `reconcileWithRoster` 는 All Maps 만 채움, 다른 맵은 `tierOf` 로 All Maps 를 따라 보여줌 | 이전 리뷰의 "Import 후 맵 수 × roster 만큼 불어남" 계열 결함을 구조적으로 제거 |
| `upgradeBoard`: 옛 보드 이름이 카탈로그에 **정확히 하나**만 있으면 그 맵으로 이동, 나머지는 **Custom boards** | 기존 데이터 무손실. 기본 6개 맵은 전부 자동 연결됨(실측) |
| Share 링크 = All Maps 티어·순서·노트 + 브롤러 노트 + 역할만 (`shareableState`), 열면 그 부분만 교체 (`mergeSharedBoard`) | 사용자 결정. 맵 20개 편집 시 65,000자 → **약 3,900자**(실측). 받는 사람의 맵 데이터·그림은 유지 |
| `SCHEMA_VERSION` 3 → **4** | v3 앱이 v4 데이터를 저장하면 그림(`drawings`)을 버린다 → v3 앱이 "newer" 로 인식해 원본을 격리하게 |

## C. Critical Path — 데이터 정합성

### C-1. "보기는 쓰지 않는다" 불변식
- 렌더 경로(`renderBoard`, `selectBrawler`, 사이드바)는 `placementFor`/`orderFor`/`tierOf` 만 쓴다. 이것들은 **새 객체를 돌려주고 state 를 건드리지 않는다**(테스트로 고정).
- 편집 경로(드래그, Reset)는 반드시 `editMap()` = `materializeMap()` 을 먼저 부른다. **새 편집 기능을 만들 때 이걸 빼먹으면** 편집 전 맵에 쓰기가 일어나지 않거나(드래그가 사라짐) 공유 객체를 오염시킨다.
- 동작 변화(승인됨): 편집 안 한 맵은 All Maps 를 바꾸면 같이 바뀐다. 첫 편집 순간 그때 보이던 상태로 고정된다.

### C-2. 기존 데이터 이전 (`upgradeBoard`)
- 대상 키에 이미 티어·순서·노트·그림 중 하나라도 있으면 **옮기지 않고 Custom 으로 남긴다**(덮어쓰기 없음).
- 대소문자까지 정확히 같은 이름만 연결한다. 잘못 연결되면 남의 맵에 노트가 붙기 때문.
- 부팅·파일 Import·Undo 복원 때마다 실행되고 **멱등**이다. 그래서 카탈로그가 늘어 이름이 새로 유일해지면 다음 부팅 때 자동 연결된다.
- 카탈로그 파일이 없으면 아무것도 옮기지 않고 전부 Custom 으로 둔다.

### C-3. Share 링크 의미 변경
- **이전 버전이 만든 링크**(모든 맵 포함)를 열어도 이제는 일반 보드 부분만 적용한다. 맵 데이터는 무시된다(받는 사람 데이터 보호).
- 링크로 받은 뒤 'Undo import' 는 **보드 전체**를 백업 시점으로 되돌린다.

### C-4. 저장 용량
- 맵 하나 편집 ≈ 2.9KB(티어+순서), 그림 하나 ≈ 5KB(보통) ~ 240KB(상한). localStorage 는 GitHub Pages 계정 전체가 5MB 를 공유한다.
- 저장 실패는 기존 배너로 알린다. 그림이 많아지면 Export 로 백업을 권한다.

### C-5. 이미지 배포
- `Brawlstars map/` 56MB 를 그대로 Pages 에 올린다. 사이드바는 텍스트만, 이미지는 맵을 열 때만 받는다.
- 맵 이미지를 추가·삭제하면 **`npm run catalog` 필수.** 안 하면 `tests/catalog.test.js` 의 "up to date" 테스트가 실패한다.

### C-6. 리뷰에서 고친 것 (데이터)
- **첫 편집 복사가 정크를 증식시켰다 (중간)**: 악의적 링크/파일이 All Maps 에 이름 1,000개를 넣으면, 맵을 하나 편집할 때마다 그 1,000개가 복사돼 **맵 22개 편집 만에 저장소가 가득** 찼다. → `materializeMap` 은 **roster 브롤러만** 복사. 나머지는 `tierOf` 로 계속 All Maps 를 따라 보임(화면 변화 없음).
- All Maps 를 지웠던 데이터: 다시 만들 때 옛 `placements` 사본·유령 표가 되살아나 모든 맵을 조용히 움직였다 → **빈 All Maps** 로 시작.
- "All maps" 처럼 대소문자만 바꿨던 경우: 다음 로드에서 중복으로 하나가 지워졌다 → All Maps 로 합침.
- 이름이 카탈로그 키와 똑같은 Custom 보드(예: `Heist/Safe Zone`): × 가 **카탈로그 맵 데이터를 지웠다** → Custom 목록에서 뺌(데이터는 이미 그 키에 있음).
- 카탈로그에서 사라진 맵/버전의 데이터: 볼 수도 지울 수도 없었다 → 사이드바 **"No longer in the map list"** 에 표시(열기·삭제).

### C-7. 테스트 환경 주의
- 브라우저 패널이 숨겨지면 `innerHeight=0`·`ResizeObserver`/`requestAnimationFrame` 이 멈춰 캔버스가 0 크기로 보인다. 실제 브라우저에선 정상. 검증은 뷰포트를 에뮬레이션(1280×900, 375×812)해서 했다.

## D. 새로 도입한 것

| 무엇 | 설명 |
|---|---|
| `npm run catalog` | 맵 목록 생성 스크립트. 의존성 없음 |
| `js/catalog.js`, `js/maps-catalog.js` | `window.BrawlCatalog`, `window.BRAWL_MAP_CATALOG`. 로드 순서: drawing → catalog → maps-catalog → storage |
| storage API | `tierOf`, `placementFor`, `orderFor`, `materializeMap`, `upgradeBoard`, `shareableState`, `mergeSharedBoard` |
| 데이터 | `state.drawings`, 키 형식 `"모드/맵"` · `"모드/맵#버전"`, `schemaVersion: 4` |
