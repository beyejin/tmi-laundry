# TMI 세탁실

한 층의 세탁기 2대와 건조기 1대에 붙인 QR을 스캔해 시작을 등록하고, 모두가 같은 남은 시간을 확인하는 시범 운영 웹입니다.

## 배포 주소

- [세탁실 현황](https://tmi-laundry.hanroona8844.workers.dev/)
- [기기별 QR 안내문](https://tmi-laundry.hanroona8844.workers.dev/qr)
- [GitHub 저장소](https://github.com/beyejin/tmi-laundry)

## 이용 방법

1. `/qr`의 안내문 3장을 인쇄해 해당 기기에 붙입니다.
2. 기기를 실제로 켠 다음 QR을 스캔합니다.
3. 세탁기는 **36분 시작**, 건조기는 **45분 시작**을 누릅니다.
4. 현황판에서 기기를 선택하면 남은 시간을 확인하거나 수정할 수 있습니다.

독서실 좌석 현황판처럼 기기 3대를 한 화면에서 확인합니다. 휴대폰에서도 기기 선택과 조작을 나누어 보여줍니다. 다른 화면의 변경은 최대 약 10초 뒤 반영되며, 새로고침 버튼으로 바로 확인할 수 있습니다.

**표시되는 시간은 사용자가 등록한 예상값입니다.** 미등록 기기는 `미확인`, 타이머가 끝난 기기는 `예상 종료`로 표시합니다. 빨래가 수거됐거나 기기가 비었다는 뜻은 아닙니다. 예약이나 대기 순번 기능은 없습니다.

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

단위 검증은 실제 SQLite에서 종료 시각, 중복 등록, 동시 수정, 입력값 검사를 확인합니다. API 검증은 로컬 서버의 세탁기 2와 건조기 1을 잠시 변경한 뒤 등록을 취소합니다. 운영 서버를 수정하지 않도록 로컬 주소로 고정했습니다.

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

인증 정보는 Git에 저장하지 않습니다. 이 저장소는 유료 플랜 변경이나 도메인 구매를 포함하지 않습니다.

## 코드 구조

- `app/page.tsx`: 기기 현황판과 시작 및 수정 화면
- `hooks/use-laundry.ts`: 서버 동기화, 시간 보정, 요청 중복 및 오래된 응답 방지
- `lib/laundry.ts`: 기기 정의, 입력 검증, 동시에 등록할 때 충돌을 막는 SQL
- `lib/laundry-store.ts`: D1 접근과 API 응답
- `app/api/machines/`: 현황 조회 및 변경 API
- `app/qr/`: 기기별 QR 안내문과 인쇄
- `drizzle/`: 데이터베이스 스키마

React와 Vinext, Cloudflare Workers 및 D1을 사용합니다. UI는 Astryx 컴포넌트와 토큰을 사용합니다.

## 시범 운영 범위

로그인 없이 기기 상태를 등록하고 수정할 수 있습니다. 등록 누락과 잘못된 입력을 사람이 확인하는 소규모 시험용입니다. 현재 한 층의 3대만 다루며 층 이름은 `시범 운영층`으로 표시합니다. 기기 자동 감지, 카메라, 알림, 예약 기능은 포함하지 않습니다.

다음 단계는 실제 한 층에서 QR 3장을 붙이고 여러 휴대폰으로 등록 누락과 시간 오차를 확인하는 것입니다. 확대 운영 전에는 시험 결과에 따라 수정 권한과 실제 수거 확인 방식을 결정합니다.
