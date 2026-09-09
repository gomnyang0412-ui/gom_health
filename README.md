# 오늘의 운동

모바일 우선 개인 운동 기록 앱. Next.js App Router, Turso/libSQL, Gemini, Chart.js를 사용합니다.

## 실행

Node.js 22 이상과 pnpm을 사용합니다.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Windows PowerShell에서는 `Copy-Item .env.example .env.local`을 사용하세요. http://127.0.0.1:3000 에서 확인합니다.

DB 설정이 없으면 개발용 `local.db` 파일을 사용합니다. Gemini 키가 없으면 기본 형식 파서와 직접 기록 기능을 사용할 수 있습니다. 실제 AI와 클라우드 저장은 아래 환경변수가 필요합니다. 로컬 DB는 Vercel에 업로드되지 않습니다.

## 환경변수

- `GEMINI_API_KEY`: 서버 전용 Gemini API 키
- `GEMINI_MODELS`: 쉼표로 구분한 API 모델 ID. 왼쪽부터 시도하며 429에서만 다음 모델로 이동합니다. 사용자 지정 여섯 모델의 순서는 `.env.example`에 있습니다.
- `GEMINI_TIMEOUT_MS`: 모델별 타임아웃, 기본 8000ms
- `GEMINI_TOTAL_TIMEOUT_MS`: 호출 체인 전체 타임아웃, 기본 25000ms
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`: Turso 연결 정보. Vercel에서는 URL이 없으면 저장을 거부합니다.

`.env.local`은 Git에서 제외됩니다. 환경변수를 바꾼 후 개발 서버를 재시작하고, 배포 환경에서는 재배포하세요. 결제 수단 등록은 필요하지 않습니다.

## 사용법

- `사이드 레터럴 레이즈 25kg x 20`, `벤치프레스 40kg x 10 3세트`
- `턱걸이 10회`, `천국의 계단 15분`, `인터벌러닝 15분`
- `끝`: 오늘 요약. AI 피드백이 실패해도 요약은 표시합니다.
- 입력창의 + 또는 기록 탭의 +: 직접 기록
- 요약의 운동 행 또는 통계의 최근 기록 선택: 수정·삭제
- 자동 인식 실패 시 원문 아래 `직접 기록하기`: 보관된 입력을 기록으로 전환

시스템 라이트/다크 모드를 따릅니다. 첨부한 KCC-Hanbit, SOYO-Maple 폰트를 변환 없이 사용했습니다. 배포 전 해당 파일의 배포처 라이선스를 확인하세요.

하루 한 번, Asia/Seoul 날짜 기준입니다. 근력 볼륨은 입력 무게×횟수×세트이며 맨몸은 볼륨에서 제외합니다. 유산소는 시간으로 별도 집계합니다. 주간 통계는 월요일부터 일요일까지입니다. 스트릭은 오늘 기록이 없으면 어제까지의 연속 일수를 보여줍니다. 시간은 첫 기록부터 첫 `끝`까지이며, 새 운동이 추가된 후 다시 `끝`을 보내면 갱신합니다. 종료 전 달력의 시간은 첫 기록부터 마지막 기록까지입니다. 요약 카드는 날짜별 최신 기록을 반영합니다.

운동 이름은 공백 차이를 서버에서도 통합하며, 표현 차이는 기존 운동 목록을 Gemini에 제공해 정규화합니다. 오타 병합 UI는 포함하지 않습니다. 그래프는 서로 다른 날짜 3일 이상부터 표시하고, 근력 최고 무게/총 볼륨, 맨몸 총 횟수, 유산소 총 시간을 사용합니다.

## 검증

```sh
pnpm test
pnpm typecheck
pnpm build
```

테스트는 임시 DB와 가짜 Gemini 응답을 사용하며 실제 API 키·개인 기록에 접근하지 않습니다. 로그인은 없으며 URL을 아는 사람은 조회·수정·삭제할 수 있습니다. 검색 제외 설정과 동일 출처 요청 검사를 적용했습니다.

## Vercel 배포 준비

승인 후 Next.js 프로젝트로 배포하고 서버 환경변수를 입력합니다. 함수 최대 실행 시간은 60초로 선언했습니다. 공개 URL을 아는 사람의 접근을 허용하는 설계입니다. Turso 스키마는 첫 요청에 `CREATE TABLE IF NOT EXISTS`로 초기화합니다. 이미 배포한 스키마를 변경할 때는 별도 마이그레이션이 필요합니다.

참고: [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling), [Turso TypeScript](https://docs.turso.tech/sdk/ts/reference), [Vercel 함수 실행 시간](https://vercel.com/docs/functions/configuring-functions/duration).


## 요청 상태와 요약 개선

요청 상태, 90초 처리 만료 복구, 날짜별 요약, 운영 DB의 추가 마이그레이션과 검증 범위는 [신뢰성 개선 기록](docs/reliability-changes.md)을 참고하세요. 수정·삭제 후에는 수치 갱신 문구를 표시하고, 새로운 `끝` 요청에서만 AI 피드백을 생성합니다.
