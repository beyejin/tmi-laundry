# TMI 세탁실

2생활관과 3생활관을 남녀 구역으로 나누고, 층별 세탁실의 QR로 시작을 등록해 예상 남은 시간을 공유하는 시범 운영 웹입니다.

## 배포 주소

- [세탁실 현황](https://tmi-laundry.hanroona8844.workers.dev/)
- [기기별 QR 안내문](https://tmi-laundry.hanroona8844.workers.dev/qr)
- [GitHub 저장소](https://github.com/beyejin/tmi-laundry)

## 이용 방법

1. 현황판에서 생활관, 남녀 구역, 층을 선택합니다.
2. `QR 안내문`에서 해당 위치의 안내문 3장을 인쇄해 기기에 붙입니다.
3. 기기를 실제로 켠 다음 QR을 스캔합니다.
4. 세탁기는 **36분 시작**, 건조기는 **45분 시작**을 누릅니다.
5. 현황판에서 기기를 선택하면 남은 시간을 확인하거나 수정할 수 있습니다.

독서실 좌석 현황판처럼 선택한 층의 기기 3대를 한 화면에서 확인합니다. 다른 층의 같은 번호 기기는 별도 기록을 사용합니다. 휴대폰에서도 기기 선택과 조작을 나누어 보여줍니다. 다른 화면의 변경은 최대 약 10초 뒤 반영되며, 새로고침 버튼으로 바로 확인할 수 있습니다.

**표시되는 시간은 사용자가 등록한 예상값입니다.** 미등록 기기는 `미확인`, 타이머가 끝난 기기는 `예상 종료`로 표시합니다. 빨래가 수거됐거나 기기가 비었다는 뜻은 아닙니다. 건조기는 층별 대기자 명단(최대 8명, 별명만 사용, 3시간 뒤 자동 삭제)을 제공하며, 차례 시각은 등록된 시간 기준 추정입니다. 기기 예약 기능은 없습니다.

## 로컬 실행

Node.js 24 이상이 필요합니다.

```sh
npm ci
npm run db:migrate:local
npm run build
npm run preview
```

`http://127.0.0.1:5173`에 접속합니다. 개발 중에는 `npm run dev`를 쓸 수 있습니다. 로컬 QR은 같은 컴퓨터에서만 접근할 수 있으므로 기숙사에 붙일 QR은 배포한 웹사이트의 `/qr`에서 인쇄해 주세요.

## 검증

```sh
npm run typecheck
npm test
npm run build
# 별도 터미널에서 npm run preview를 실행한 뒤
npm run test:api
```

탭이 숨겨져 있으면 10초 자동 확인을 멈추고, 다시 보이는 즉시 갱신해요. 종료 시각이 30분 이상 지난 기기는 `예상 종료` 대신 `확인 필요`로 표시하며 미확인 개수에 합산해요.

단위 검증은 실제 SQLite에서 종료 시각, 중복 등록, 동시 수정, 입력값 검사를 확인합니다. API 검증은 로컬 서버의 3생활관 여자 2층 세탁기 2와 건조기 1, 3층 세탁기 2를 잠시 변경한 뒤 등록을 취소합니다. 건조기 시작과 함께 내 대기 항목이 정리되는지(실패한 시작은 명단 유지)는 5층 건조기로 확인합니다. 운영 서버를 수정하지 않도록 로컬 주소로 고정했습니다.

이용 횟수는 `npx wrangler d1 execute DB --local --command "SELECT kind, COUNT(*) FROM event_log GROUP BY kind"`로 확인합니다(운영은 `--remote`). 배포 전 `npm run db:migrate:remote`로 0002와 0003을 적용해야 해요.

## 관리자 화면

`/admin`은 로그인 없이 쓰는 일반 화면과 별개로, 운영진이 고장 기기를 점검 중으로 바꾸고, 잘못된 등록을 초기화하고, 멈춘 대기 항목을 지우고, 이용 숫자를 내려받는 화면입니다. 메인 화면에는 링크가 없고 검색에 잡히지 않게(`noindex`) 해 두었습니다.

- `ADMIN_TOKEN`이 없거나 24자 미만이면 `/api/admin/*` 전체가 항상 401이라 관리자 기능이 꺼집니다.
- 토큰은 `/admin`에서 한 번 입력하면 그 탭의 `sessionStorage`에만 보관하고, 탭을 닫으면 사라집니다.
- 점검 중으로 바꾸면 그 기기의 시작, 수정, 취소가 막히고 화면에 `점검 중`과 메모가 보입니다. 층의 건조기가 모두 점검 중이면 대기 등록도 받지 않습니다. 이용자의 `고장 신고`는 기록만 남고 점검 상태를 바꾸지 않으며, 기기당 10분에 3건까지 받습니다.
- 초기화와 대기 항목 삭제는 브라우저 확인 창 없이 같은 버튼을 한 번 더 눌러야 실행됩니다.
- 이용 기록 CSV(`/api/admin/events.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`, 한국 시간, 최대 180일)에는 별명과 토큰이 들어 있지 않습니다.

운영 토큰 설정(24자 이상 무작위 값을 팀 비밀 채널로만 공유):

```sh
npx wrangler secret put ADMIN_TOKEN
```

로컬에서는 저장소 루트의 `.dev.vars`(Git 제외)에 `ADMIN_TOKEN=24자_이상의_값`을 적습니다. `npm run preview`는 `dist/server/wrangler.json`을 쓰는데, wrangler는 이 설정 파일 옆의 `.dev.vars`만 읽습니다. 그래서 `preview` 스크립트가 서버를 띄우기 전에 `.dev.vars`를 `dist/server/`로 복사합니다(빌드할 때마다 `dist`가 새로 만들어지므로 매번 복사). 파일이 없으면 관리자 기능은 꺼진 채로 뜹니다. `test:api`에 `ADMIN_TOKEN` 환경변수를 같은 값으로 주면 관리자 API 시험까지 실행하고, 없으면 그 시험만 건너뛰고 401 확인은 실행합니다.

```sh
echo "ADMIN_TOKEN=local-admin-$(openssl rand -hex 16)" > .dev.vars
npm run build && npm run preview
# 다른 터미널에서
ADMIN_TOKEN=$(sed 's/^ADMIN_TOKEN=//' .dev.vars) npm run test:api
```

## Cloudflare 배포

Cloudflare Workers가 웹과 API를 제공하고 D1이 공용 상태를 보관합니다. 로컬 저장소만 쓰는 데모가 아니므로 서로 다른 휴대폰에서도 같은 현황을 볼 수 있습니다.

최초 설정:

```sh
npx wrangler login
npx wrangler d1 create tmi-laundry
```

생성된 database_id를 `wrangler.jsonc`의 D1 바인딩에 넣은 다음 배포합니다.

```sh
npm run db:migrate:remote
npm run deploy
```

관리자 기능(0003)을 처음 배포할 때의 순서: `npx wrangler secret put ADMIN_TOKEN` → `npm run db:migrate:remote`(0003은 `ALTER TABLE ... ADD`만 있어 이전 코드도 그대로 동작) → `npm run deploy`. 토큰을 넣지 않고 배포하면 코드는 동작하지만 `/admin`은 401만 돌려줍니다. 배포 뒤에는 `/admin`에서 토큰 없이 401이 나오는지, `GET /api/machines`에 `outOfService` 필드가 있는지 확인합니다.

인증 정보는 Git에 저장하지 않습니다. 이 저장소는 유료 플랜 변경이나 도메인 구매를 포함하지 않습니다.

## 코드 구조

- `app/page.tsx`: 기기 현황판과 시작 및 수정 화면
- `hooks/use-laundry.ts`: 서버 동기화, 시간 보정, 요청 중복 및 오래된 응답 방지
- `lib/laundry.ts`: 기기 정의, 입력 검증, 동시에 등록할 때 충돌을 막는 SQL, 상태 판정(`machineStatus`: 미확인/사용 중/예상 종료/확인 필요)
- `lib/laundry-store.ts`: D1 접근, API 응답, POST 공통 가드(`readJsonBody`), 이용 기록(`logEvent`)
- `app/api/machines/`: 현황 조회 및 변경 API. 건조기 시작 요청에 내 대기 항목(`waitlist`)을 함께 보내면 같은 D1 batch에서 명단을 정리해요.
- `lib/events.ts`, `event_log` 테이블: 이용 기록(시작·수정·취소·대기 등록·대기 빠짐·차례 정리). 별명, 토큰, IP는 기록하지 않고 정리 쿼리(`eventCleanupQuery`, 120일 경과 행 삭제)는 만들어 두었고, 관리자가 전체 통계를 불러올 때(`/api/admin/overview`, `stats=0`인 30초 폴링에서는 실행하지 않아요) 함께 실행해요. 시범 운영 기간이 120일보다 짧아 이것으로 충분해요. 기록 실패는 요청을 막지 않아요.
- `app/api/waitlist/`, `lib/waitlist.ts`, `hooks/use-waitlist.ts`, `app/waitlist-panel.tsx`: 건조기 대기자 명단과 맨 앞 대기자 건너뛰기
- `lib/admin.ts`, `app/admin/`, `app/api/admin/`: 관리자 인증(`isAdmin`), 점검 전환·초기화·통계·CSV 순수 함수와 화면, API
- `app/api/machines/[id]/report/`, `hooks/use-reports.ts`: 이용자 고장 신고
- `app/qr/`: 기기별 QR 안내문과 인쇄
- `drizzle/`: 데이터베이스 스키마(0002가 `event_log`, 0003이 `machine_state.out_of_service`·`service_note`). 테스트는 `tests/schema.mjs`가 이 마이그레이션을 그대로 적용해 메모리 DB를 만들어요.
- `.github/workflows/ci.yml`: PR과 main push마다 타입 검사, 테스트, 빌드, 로컬 API 검증을 실행(배포는 포함하지 않음)

React와 Vinext, Cloudflare Workers 및 D1을 사용합니다. UI는 Astryx 컴포넌트와 토큰을 사용합니다.

## 대기자 건너뛰기 규칙

맨 앞 대기자가 건조기가 비었는데도 오지 않을 때, 누구나(토큰 없이) 그 사람을 명단에서 뺄 수 있습니다. 판정은 화면과 서버가 같은 순수 함수(`lib/waitlist.ts`의 `canSkip`)로 합니다.

- 건조기는 층의 첫 번째 건조기입니다. 사용 중이면 건너뛸 수 없고(표시 없음), 점검 중이어도 건너뛸 수 없습니다.
- 차례가 시작된 시각은 `max(등록 시각, 건조기가 빈 시각, 마지막 명단 변동 시각)`이고, 거기서 `SKIP_AFTER_MS`(10분)가 지나야 `건너뛰기`가 나타납니다. 그 전에는 `차례예요 · N분 안에 시작해 주세요`로 표시합니다. 내 항목이면 버튼 대신 `지금 시작해 주세요`입니다.
- 버튼은 한 번 더 눌러야 실행됩니다(4초 안에 다시 누르지 않으면 원래대로).
- 서버는 맨 앞 항목인지, 건조기가 사용·점검 중이 아닌지를 삭제 SQL 안에서 한 번 더 확인합니다. 그 사이 바뀌었으면 409 `그 사이 차례가 바뀌었어요.`입니다.
- 마지막 명단 변동 시각은 `event_log`(`waitlist_leave`, `waitlist_turn`, `waitlist_skip`, `admin_remove`)에서 읽어 `/api/machines` 응답의 `waitlistLastChange`로 내려줍니다. 이 조회가 실패하면(예: 마이그레이션 0002 전 DB) 현황 조회는 그대로 성공하고 빈 값으로 처리합니다.
- **알려진 한계**: 이용 기록은 best-effort라 기록이 누락되면 마지막 변동 시각이 실제보다 이르게 잡혀 10분이 되기 전에 건너뛰기가 허용될 수 있습니다.

## 시범 운영 범위

로그인 없이 기기 상태를 등록하고 수정할 수 있습니다. 등록 누락과 잘못된 입력을 사람이 확인하는 소규모 시험용입니다. 현재 시설 구성이 확인된 곳은 **3생활관 여자 2층부터 5층**이며, 각 층에 세탁기 2대와 건조기 1대를 등록했습니다. 2생활관 남녀 구역과 3생활관 남자 구역도 선택할 수 있지만, 시설 구성을 확인하기 전에는 현황 대신 안내를 표시합니다. 기기 자동 감지, 카메라, 알림, 예약 기능은 포함하지 않습니다.

위치 정보가 없던 이전 QR은 새 위치별 QR로 다시 인쇄해 주세요. 이전 시범 기록은 데이터베이스에 보존하며, 실제 위치를 알 수 없으므로 특정 층으로 자동 이전하지 않습니다.

다음 단계는 나머지 구역의 층과 기기 수를 확인하고, 실제 한 층에 QR 3장을 붙여 여러 휴대폰으로 등록 누락과 시간 오차를 확인하는 것입니다. 확대 운영 전에는 시험 결과에 따라 수정 권한과 실제 수거 확인 방식을 결정합니다.
