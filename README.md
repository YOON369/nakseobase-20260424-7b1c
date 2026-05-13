# 쿠팡 로컬 AI CS (Coupang Local CS) — MVP

쿠팡 판매자용 **로컬** 고객 서비스 보조 도구. Mac mini / 로컬 PC에서 실행되며, 쿠팡 OpenAPI를 통한 문의 수신과 답변 전송을 보조한다.

## 핵심 원칙

- **로컬 우선**. API Key와 고객 문의 데이터는 외부 서버로 나가지 않는다.
- **고정 IP 대응**. 쿠팡 자체개발 방식이 등록된 공인 IP만 호출을 허용하므로 IP Guard가 항상 동작한다.
- **사람 승인 후 전송**. 처음부터 자동 답변은 금지. MVP는 사람 승인 흐름만 동작한다.
- **수집 → AI 초안 → 안전 검사 → 사람 승인 → 답변 전송**

## 빠른 시작

요구사항: Node.js 20+ 이상.

```bash
npm install
cp .env.example .env       # 그대로 비워둬도 mock 모드는 동작
npm start                  # http://127.0.0.1:4100
```

처음 실행 시 `.gnet/coupang-cs/config.json`이 `config.example.json`에서 자동 생성된다.
SQLite DB는 `.gnet/coupang-cs/data.sqlite`로 만들어진다.

## 흐름

1. **Worker**가 `pollIntervalMinutes` 주기로 `Coupang Adapter`(mock)에서 문의를 가져온다.
2. 새 문의는 `inquiries`에 `status='new'`로 저장된다.
3. Worker가 `Classifier → Reply Generator → Safety Guard`를 차례로 실행하고 `ai_reviews`에 결과를 적재한다. 문의 상태는 `awaiting_approval`로 바뀐다.
4. 운영자가 대시보드에서 초안을 확인/수정한 뒤 **승인 후 답변 전송**, **보류**, **직접 답변**을 선택한다.
5. 모든 전송은 `Coupang Adapter`를 통한다. MVP에서는 항상 mock으로 처리되고, `mode='real'` AND `coupang.apiEnabled=true` AND IP Guard `OK`일 때만 실제 어댑터가 호출된다 (실제 어댑터는 현재 스텁이라 명시적 에러).

## 디렉토리

```
src/
  server.js              Express 진입점
  config.js              설정 로더 (env override, masking)
  logger.js              로거 (PII/시크릿 마스킹)
  db.js                  SQLite 마이그레이션 + DAO
  ipGuard.js             공인 IP 확인 + 비교
  worker.js              백그라운드 동기화/분석
  coupang/
    adapter.js           Adapter 팩토리
    mockAdapter.js       Mock 구현
    realAdapter.js       실제 API 스텁 (NotImplemented)
  ai/
    classifier.js        rule-based 한국어 분류기
    replyGenerator.js    카테고리별 한국어 템플릿
  safety/
    safetyGuard.js       약속/PII/위협 검사
  routes/api.js          REST API
  scripts/{seed,reset}.js
public/
  index.html, app.js, styles.css   대시보드 (빌드 단계 없음)
.gnet/
  missions/coupang-cs.json         미션 템플릿 (tracked)
  coupang-cs/
    config.example.json            예시 설정 (tracked)
    mock-inquiries.json            mock 데이터 (tracked)
    config.json                    실제 설정 (gitignored)
    data.sqlite                    DB (gitignored)
    logs/*.log                     일별 로그 (gitignored)
```

## DB 스키마

`src/db.js`의 `migrate()`를 참조. 테이블: `inquiries`, `ai_reviews`, `reply_actions`, `ip_guard_logs`.

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/dashboard/stats` | 대시보드 카드 수치 |
| GET | `/api/inquiries?status=...` | 문의 목록 |
| GET | `/api/inquiries/:id` | 문의 상세 + 최신 AI 리뷰 + 액션 로그 |
| POST | `/api/inquiries/:id/approve` | 승인 후 답변 전송 (`{reply, approvedBy?}`) |
| POST | `/api/inquiries/:id/direct` | 직접 답변 (high risk 우회 허용) |
| POST | `/api/inquiries/:id/hold` | 보류 |
| POST | `/api/inquiries/:id/reanalyze` | AI 재분석 |
| GET | `/api/ip-guard/status` | IP Guard 마지막 상태 |
| POST | `/api/ip-guard/check` | IP Guard 즉시 점검 |
| GET | `/api/worker/status` | Worker 상태 |
| POST | `/api/worker/run-now` | Worker 즉시 실행 |
| GET | `/api/config` | 마스킹된 설정 |
| PATCH | `/api/config` | 허용 필드만 수정 |
| GET | `/api/missions` | `.gnet/missions/*.json` 미션 목록 |

## 데모 테스트

```bash
npm start
# 다른 터미널에서:
curl -s http://127.0.0.1:4100/api/dashboard/stats | jq
curl -s http://127.0.0.1:4100/api/inquiries | jq '.[0]'
curl -s http://127.0.0.1:4100/api/worker/status | jq
curl -s -X POST http://127.0.0.1:4100/api/ip-guard/check | jq
curl -s http://127.0.0.1:4100/api/ip-guard/status | jq

# 브라우저: http://127.0.0.1:4100
```

대시보드에서 임의 문의를 클릭 → AI 분석 / 초안 / safety flags 확인 → **승인 후 답변 전송**.

### IP Guard BLOCKED 시뮬레이션

설정 화면에서 `coupang.registeredIp`를 임의 값(예: `1.2.3.4`)으로 저장한 뒤 “지금 확인”을 누르면 `BLOCKED` 상태로 바뀐다.

## 보안

- API key / secret key는 `.env`에만 저장한다. `config.json`에는 절대 기록하지 않는다 (서버가 명시적으로 제거).
- `/api/config` 응답과 로그에는 키가 마스킹된다 (`********xxxx`).
- 고객 메시지의 전화번호 / 이메일 / 주민번호는 로그에 기록되기 전 `[PHONE]/[EMAIL]/[RRN]`으로 마스킹된다.
- `order_id`는 DB에 `XXXX****XXXX` 형식으로만 저장된다.

## 아직 mock 인 부분

- `src/coupang/realAdapter.js` — 실제 Coupang Wing OpenAPI 호출. 현재 호출 시 NotImplemented.
- `src/ai/classifier.js` / `src/ai/replyGenerator.js` — 룰 기반 / 템플릿 기반. LLM 미연결.
- 외부 IP 조회는 `api.ipify.org` 사용. 네트워크 차단 환경에서는 `UNKNOWN`이 될 수 있다.

## 다음 단계 (실제 Coupang OpenAPI 연결)

1. Coupang Wing OpenAPI 계약/사용 가능 키 확보 (vendorId / accessKey / secretKey).
2. `realAdapter.js`에 HMAC 서명 생성기 구현 (`signature` = `HMAC-SHA256(secretKey, datetime + method + path + query)` — 공식 문서 기준으로 확정 필요).
3. 문의 조회 / 답변 전송 엔드포인트와 응답 스키마를 문서 확인 후 정규화.
4. 403 / `NOT_ALLOWED_IP` 류 응답을 잡아 IP Guard 상태를 BLOCKED로 전이.
5. `config.mode='real'` + `coupang.apiEnabled=true` + IP Guard `OK` 통과 시에만 실제 어댑터 동작 — 운영자가 명시적으로 켜기 전까지는 mock 유지.
6. LLM 연결 (OpenAI / Claude / 로컬 ollama 등) — `classifier.js`와 `replyGenerator.js`를 동일 인터페이스로 교체.

## 운영 명령

```bash
npm start          # 서버 시작
npm run dev        # --watch 모드
npm run seed       # 서버 없이 1회 동기화+분석 (DB만 채움)
npm run reset      # data.sqlite + logs/ 삭제 (config.json은 보존)
```
