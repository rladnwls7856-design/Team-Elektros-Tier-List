# P6 — 다크 모드 · 공식 클래스 역할 · Share 링크 압축

> 2026-10-07 · 브랜치 `feature/modernist-design` · 테스트 **343개** 통과 · 브라우저 확인
> 리뷰: 3관점(다크 대비·역할 의미·압축 견고성) 발견 → 반박 검증. **확인 9건 / 기각 7건**, 확인된 것 전부 수정 + 기각됐지만 재현된 포커스 링 1건도 수정.

## A. 무엇을 · 왜

| 요청 | 한 일 |
|---|---|
| "왜 다크 모드에서 바뀌었냐, 다크로" | Modernist 의 구조(Archivo·모서리 0·2px 규칙선·빨강 강조)는 그대로, **바탕만 어둡게**. `css/modernist.css` 는 손대지 않고 앱 층에서 토큰을 다시 정의 |
| 역할을 브롤스타즈 기준으로 | API 의 공식 `class` 7종(**Damage Dealer · Tank · Assassin · Marksman · Artillery · Controller · Support**)을 역할로 만들고 **108명 전원 배정** |
| 링크 압축 | `#z=` 압축 링크(deflate-raw). 실측: 역할·노트 포함 보드 **8,580자 → 1,892자** |

**역할 자동 생성 규칙**
- 역할이 하나도 없는 보드의 첫 실행에서 1회 생성(`classRolesAdded` 플래그).
- 이미 자기 역할이 있는 보드는 건드리지 않음 → Manage roles 의 **"Add Brawl Stars classes"** 버튼으로 직접 추가.
- 이후 실행에서는 **새로 출시된 브롤러만**(역할 항목이 아예 없는 브롤러) 기존 클래스 역할로 태그. 사용자가 지운 역할·태그는 되살리지 않음.
- 링크로 받은 역할은 최종(보낸 사람의 선택을 덮지 않음).

## C. Critical Path

### C-1. 🔴 자산 버전 쿼리 — 배포할 때마다 올릴 것
테스트 중 **캐시된 옛 `js/storage.js` + 새 `index.html`** 조합이 부팅에서 앱을 멈췄다(`isShareHash is not a function`). GitHub Pages 는 파일을 ~10분 캐시하므로 실제 배포에서도 생긴다.
→ 모든 `js/`·`css/` 참조에 `?v=YYYYMMDD.N`. **자산을 바꾸면 버전을 올린다.** `tests/assets.test.js` 는 "모두 같은 버전인지"만 확인한다 — 올렸는지는 사람이 본다.

### C-2. 압축 링크의 안전장치
- **압축 폭탄**: 작은 링크가 수 GB 로 풀리는 공격 → 스트림을 조각 단위로 읽다가 6MB(2M자×3바이트)에서 중단.
- **끝 표시 `Z`**: base64url 은 `_`·`-` 로 끝날 수 있는데 GitHub 같은 자동 링크가 끝의 `_` 를 빼먹어 링크가 깨진다 → 항상 `Z` 로 끝내고, 없으면 "손상된 링크".
- **미지원 브라우저**: `deflate-raw` 가 없는 브라우저(Chromium 80–102)는 스트림을 실제로 만들어 보고 판단 → 압축 없는 `#data=` 링크로 대체. 받는 쪽은 "브라우저 업데이트 또는 Export 파일" 안내.
- 옛 `#data=` 링크는 계속 열린다.

### C-3. 역할 라벨 대비
사용자 색 위 글자색을 감마 밝기 0.55 기준으로 고르던 방식이 틀려 **Support 2.95:1, Controller 3.30:1** 이었다 → WCAG 대비를 직접 계산해 더 나은 쪽 선택(`labelInkFor`). Damage Dealer·Tank·Marksman·기본색은 어떤 글자색으로도 4.5:1 이 안 나와 색 자체를 어둡게 바꿨다. 테스트가 "모든 클래스 색 ≥ 4.5:1" 을 고정한다.

### C-4. 다크 토큰
램프를 다크 바탕용으로 다시 깔았다: 낮은 단계 = 채움, 높은 단계 = 글자. 그래서 `accent-700` 은 이제 **밝은** 빨강(작은 강조 글자용). 앱 CSS 를 고칠 때 "700 = 어두운 색" 이라고 가정하지 말 것.

## D. 새로 도입한 것

| 무엇 | 설명 |
|---|---|
| `CompressionStream` / `DecompressionStream` (`deflate-raw`) | 브라우저 내장 압축. 라이브러리 없음 |
| `encodeShareHashAsync` / `decodeShareHashAsync` / `isShareHash` / `inflateCapped` | 압축 링크 |
| `addClassRoles(state, roster, {newOnly})`, `CLASS_ORDER`, `CLASS_ROLE_COLORS`, `labelInkFor` | 공식 클래스 역할, 라벨 글자색 |
| `state.classRolesAdded`, roster 캐시의 `className` | 데이터 필드 |
| `?v=` 자산 버전 + `tests/assets.test.js` | 캐시 불일치 방지 |
