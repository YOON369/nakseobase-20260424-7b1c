# 낙서베이스 (Nakseobase)

> 냅킨에 그린 한 장이 곧 프로덕션 DB가 된다.

## Context

주말 카페에서 냅킨에 ERD를 스케치하고, 월요일 아침 사무실에 앉아 그걸 다시 `CREATE TABLE` 구문과 `ALTER TABLE ... ADD FOREIGN KEY`, RLS `USING ( auth.uid() = user_id )`로 옮기는 작업은 1인 개발자와 인디해커에게 반복되는 고통이다. 스케치는 아이디어의 속도로 흐르지만, 그 아이디어를 실제 마이그레이션·정책·엔드포인트로 옮기는 구간은 여전히 손맛 없는 YAML과 psql의 영역이다. 낙서와 프로덕션 사이의 거리는 좁혀지지 않는다.

낙서베이스는 이 거리를 0으로 만든다. Excalidraw 스타일 화이트보드에 박스를 그리면 Supabase Postgres에 테이블이 `CREATE`되고, 화살표를 그으면 FK가 붙고, 화살표에 자물쇠를 그리면 그 관계를 기반으로 RLS 정책이 컴파일되어 즉시 적용된다. 도형은 단순한 그림이 아니라 라이브 데이터 뷰가 되어, realtime insert가 발생하면 새 row가 종이처럼 팔랑이며 박스 안으로 떨어진다.

타겟은 "ERD 먼저, SQL 나중"이 자연스러운 1인 개발자와 인디해커다. 그들에게 낙서베이스는 아이디어를 식히지 않고 바로 DB로 굳히는 도구다. 그리고 프로덕션 직전에는 화이트보드 구석의 갈색 '커피 얼룩 스티커' 위에 올려둔 테이블만 `experimental` 태그로 스테이징까지 나가는, 작지만 의식적인 안전장치를 둔다.

## Stack

- **Next.js 16 (App Router) + TypeScript**: Server Actions로 마이그레이션 트리거를, Route Handlers로 webhook/stream을 처리. Vercel Fluid Compute 기본 런타임.
- **Excalidraw (`@excalidraw/excalidraw`)**: 손그림 느낌의 화이트보드. `onChange`로 요소 delta를 뽑아 도형 → DDL 변환기에 먹인다.
- **Yjs + y-websocket**: 화이트보드 실시간 협업과 "연필 커서" 구현. Supabase Realtime은 DB row용, Yjs는 도형 편집용으로 분리.
- **Supabase (Postgres 16 + Auth + Realtime + Edge Functions)**: 진짜 DB. 스키마 DDL은 `supabase-js` + Management API(또는 `postgres-meta`)로 실행. 라이브 row는 Realtime `postgres_changes` 채널.
- **pg-query-emscripten**: 생성된 SQL을 클라이언트에서 파싱/검증해서 DDL 적용 전 드라이런.
- **Vercel AI Gateway + Claude Sonnet 4.6 (`anthropic/claude-sonnet-4-6`)**: 말풍선에 적힌 자연어 규칙을 Edge Function TypeScript + SQL로 컴파일. Gateway의 `provider/model` 문자열로 라우팅, 스위칭 여지 확보.
- **Zustand**: 도형 ↔ 스키마 IR(중간표현) 매핑 상태. Excalidraw 상태와 DB 스냅샷을 분리해 관리.
- **Tailwind + shadcn/ui**: 사이드패널, 토스트, 마이그레이션 diff 뷰.

선택 이유 요약: Supabase는 한 벤더 안에 Postgres·Auth·Realtime·Edge Function이 다 있어 "도형 하나 = 기능 한 조각"을 1:1로 매핑하기 쉽고, Excalidraw는 파서가 단순하고(`elements[]`만 보면 됨) 손그림 감성이 제품 아이덴티티와 정확히 맞물린다.

## MVP Scope

**들어가는 것**
- Excalidraw 캔버스 + Yjs 기반 실시간 협업 커서("연필 커서")
- 사각형 = 테이블, 사각형 내부 텍스트 = 컬럼 정의 (`name:type` 한 줄씩)
- 화살표 = FK (출발 박스 → 도착 박스의 PK)
- 도형/화살표 변경 → Postgres DDL diff 생성 → 적용 (Supabase Management API)
- 지우개로 도형 위 3회 스트로크가 감지되어야만 `DROP TABLE` 실행 (안전장치)
- 테이블 박스 안 라이브 row 뷰 (Realtime `postgres_changes` 구독, 최신 10건 팔랑임 애니메이션)
- 화살표 위 자물쇠 아이콘 → 해당 FK를 축으로 한 RLS 정책 템플릿 자동 생성·적용
- 말풍선(타원 + 텍스트) → Claude로 자연어 → Edge Function SQL 컴파일 + 배포
- '커피 얼룩 스티커' 위에 올라간 테이블은 `nb_experimental = true` 태그 + 스테이징 스키마(`staging`)에만 반영
- 프로젝트당 단일 Supabase 프로젝트 연결 (OAuth + access token 저장)

**안 들어가는 것**
- 멀티 테넌시, 팀/조직 권한, 청구
- 인덱스·체크 제약·파티셔닝·트리거 UI (DDL은 테이블/컬럼/FK/RLS/Edge Function까지만)
- 스키마 버저닝/브랜치/롤백 UI (일단 linear apply만, diff 프리뷰는 있음)
- 모바일/태블릿 최적화
- 자체 데이터 마이그레이션(ALTER COLUMN type 변환) — 이번 MVP는 추가·삭제 위주
- 그려진 도형 외 컬럼 타입 상세 편집기 (텍스트 한 줄 파서가 끝)

## File Layout

```
nakseobase/
├── app/
│   ├── (marketing)/page.tsx            # 랜딩
│   ├── board/[boardId]/page.tsx        # 메인 화이트보드 (Excalidraw + 라이브 뷰)
│   ├── api/
│   │   ├── migrate/route.ts            # DDL diff 적용 엔드포인트
│   │   ├── rls/compile/route.ts        # 자물쇠 → RLS 컴파일
│   │   ├── nl/compile/route.ts         # 말풍선 자연어 → Edge Function 컴파일 (Claude)
│   │   └── supabase/oauth/route.ts     # Supabase 프로젝트 연결 OAuth
│   └── layout.tsx
├── components/
│   ├── canvas/NakseoCanvas.tsx         # Excalidraw 래퍼 + Yjs 바인딩
│   ├── canvas/LiveRowsOverlay.tsx      # 테이블 박스 안 row 팔랑 애니메이션
│   ├── canvas/PencilCursors.tsx        # 협업자 연필 커서
│   ├── canvas/CoffeeStainSticker.tsx   # 커피 얼룩 드롭존
│   └── panels/MigrationDiffPanel.tsx   # 적용 전 SQL diff 프리뷰
├── lib/
│   ├── ir/parseElements.ts             # Excalidraw elements → 스키마 IR
│   ├── ir/diffSchema.ts                # 이전 IR vs 현재 IR → DDL 문자열
│   ├── ir/guards.ts                    # 3회 지우개 카운터, 커피얼룩 hit-test
│   ├── supabase/admin.ts               # Management API 클라이언트
│   ├── supabase/realtime.ts            # postgres_changes 구독 헬퍼
│   ├── rls/fromArrowLock.ts            # 자물쇠 화살표 → RLS SQL
│   └── ai/compileNL.ts                 # Claude 호출 (AI Gateway)
├── supabase/
│   ├── migrations/0001_nb_meta.sql     # nakseobase 자체 메타 테이블
│   └── functions/_template/            # NL 컴파일 결과가 배포될 템플릿
├── stores/useBoardStore.ts             # Zustand: 현재 IR, 지우개 카운터 등
├── vercel.ts
├── package.json
└── README.md
```

## Implementation Steps

1. **GitHub 리포 초기화 + Next.js 16 + Supabase 프로젝트 연결 스켈레톤**
   `git init` 후 GitHub에 `nakseobase` 리포를 만들어 remote 푸시한다. `create-next-app`으로 App Router·TS·Tailwind 프로젝트 생성, shadcn/ui 초기화. Supabase CLI로 로컬 프로젝트 연결, `.env.local`에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_ACCESS_TOKEN`(Management API용)을 넣는다. `supabase/migrations/0001_nb_meta.sql`에 `nb_boards`, `nb_table_map`(board_id, excalidraw_element_id, real_table_name, is_experimental)을 정의한다.

2. **Excalidraw + Yjs 캔버스와 연필 커서 구현**
   `components/canvas/NakseoCanvas.tsx`에 `@excalidraw/excalidraw`를 mount하고, `y-websocket` 서버(로컬은 `npx y-websocket`)에 붙어 `elements` 배열을 공유한다. `PencilCursors.tsx`는 각 피어의 pointer 좌표를 읽어 손그림 스타일 연필 SVG를 따라가게 그린다. 이 단계에서는 DB와는 전혀 연결하지 않고 순수 협업 캔버스만 성립시킨다.

3. **도형 → 스키마 IR 파서와 DDL diff 엔진**
   `lib/ir/parseElements.ts`에서 Excalidraw `elements`를 순회하며 rectangle+내부 text를 테이블로, arrow의 `startBinding`/`endBinding`을 FK로 해석해 `{tables:[{name, columns:[{name,type,pk}]}], fks:[...]}` IR을 만든다. `diffSchema.ts`는 이전 IR과 비교해 `CREATE TABLE`/`ALTER TABLE ADD COLUMN`/`ALTER TABLE ADD CONSTRAINT` SQL 문자열 배열을 반환한다. `pg-query-emscripten`으로 파싱 검증 후 `MigrationDiffPanel`에 프리뷰.

4. **안전장치가 붙은 마이그레이션 적용 엔드포인트**
   `app/api/migrate/route.ts`는 IR diff를 받아 Supabase Management API(`/v1/projects/{ref}/database/query`)로 실행한다. `DROP TABLE`은 `lib/ir/guards.ts`의 지우개 카운터가 해당 element 위 3회 이상 스트로크를 기록했을 때만 diff에 포함되게 한다. 모든 성공한 DDL은 `nb_table_map`에 기록해 다음 diff의 기준 상태로 삼는다.

5. **테이블 박스 내부 라이브 row 뷰**
   `LiveRowsOverlay.tsx`는 `nb_table_map`에서 element→real_table 매핑을 읽어 Supabase Realtime `postgres_changes` 채널을 구독한다. INSERT 이벤트가 오면 해당 Excalidraw 박스의 스크린 좌표를 계산해 그 안에서 새 row를 "종이처럼 팔랑"(framer-motion `rotate: [-8, 6, 0]`, `y: [-40, 0]`) 떨어뜨린다. 최신 10건만 DOM에 유지.

6. **자물쇠 화살표 → RLS 정책 자동 생성**
   화살표 위에 자물쇠 아이콘(특정 customData 플래그가 붙은 작은 rectangle hit-test)이 올라가면 `lib/rls/fromArrowLock.ts`가 해당 FK를 축으로 기본 RLS 템플릿을 만든다. 예: 자물쇠가 `posts.user_id → users.id` 화살표 위면 `CREATE POLICY nb_posts_owner ON posts FOR ALL USING (user_id = auth.uid())`. `/api/rls/compile`가 해당 SQL을 Management API로 `ENABLE ROW LEVEL SECURITY` + 정책 생성까지 원자적으로 실행한다.

7. **말풍선 자연어 → Edge Function 컴파일 (Claude via AI Gateway)**
   타원(ellipse) + 텍스트는 말풍선으로 간주. `/api/nl/compile`에서 AI Gateway로 `anthropic/claude-sonnet-4-6`을 호출, 시스템 프롬프트에 현재 IR(JSON)과 허용 가능한 Deno Edge Function 템플릿을 주입한다. 프롬프트 캐시를 IR 블록에 걸어 반복 호출 비용을 줄인다. 응답으로 받은 `{fileName, tsSource, sqlHelpers}`를 `supabase functions deploy`(REST) 경로로 배포하고, 말풍선 옆에 배포 URL을 작은 메모로 붙인다.

8. **커피 얼룩 의식 — 실험 태그와 스테이징 분리**
   `CoffeeStainSticker.tsx`는 갈색 blob SVG 스티커를 드래그로 캔버스 아무 곳에나 붙일 수 있게 한다. IR 파서가 bounding-box 교차를 판정해 해당 테이블의 `is_experimental`을 `true`로 표시하고, 마이그레이션 엔드포인트는 그 테이블을 `public` 대신 `staging` 스키마에만 적용한다. `MigrationDiffPanel` 상단에 "☕ 2개 테이블이 커피 얼룩 위에 있습니다 — 스테이징까지만 나갑니다" 토스트를 띄운다.

9. **보드 영속화 + 복구**
   Excalidraw `elements`, Yjs doc snapshot, 마지막 IR을 `nb_boards.state_jsonb`에 debounce 저장(2초). 재접속 시 snapshot을 로드한 뒤 Management API로 현재 DB 실제 상태를 읽어 IR과 비교, 드리프트가 있으면 캔버스 우측에 "DB가 캔버스와 다릅니다 — pull / push" 배너를 띄운다.

10. **Vercel 배포와 `vercel.ts` 구성**
    `vercel.ts`에 `framework: 'nextjs'`, `/api/nl/compile`에 대해 `maxDuration: 60` 설정, Supabase Management API 키는 `vercel env add` 로 Production/Preview에 분리 주입. 배포 후 Preview URL에서 협업 세션을 띄워 두 브라우저로 도형→DDL 플로우가 실제로 작동하는지 확인한다.

## Verification

- **1단계**: `pnpm dev` 실행 시 빈 Next.js 페이지가 뜨고, GitHub 리포에서 첫 커밋이 보이며, `supabase db remote commit`으로 `nb_boards` 테이블이 원격에 생성되었는지 Supabase Studio로 확인.
- **2단계**: 두 개의 브라우저 탭에서 같은 `/board/[id]`를 열어 한쪽에서 사각형을 그리면 다른 쪽에도 같은 사각형이 나타나고, 상대 마우스 위치에 연필 아이콘이 따라다니는지 확인 (DB는 아직 아무 변화 없음).
- **3단계**: 사각형 하나와 화살표 하나를 그린 뒤 `MigrationDiffPanel`에 `CREATE TABLE` + `ALTER TABLE ... ADD CONSTRAINT` SQL이 정확히 렌더되는지, 컬럼 텍스트를 수정했을 때 `ADD COLUMN`만 diff에 뜨는지 확인.
- **4단계**: diff 패널에서 "Apply" 눌렀을 때 Supabase Studio에 실제 테이블이 생성되고, 사각형을 지우개로 1–2회 문질러선 `DROP`이 diff에 나타나지 않으며 3회째에만 나타나는지 확인.
- **5단계**: Supabase Studio에서 해당 테이블에 수동으로 `INSERT`하면, 캔버스 속 박스 안에서 row 카드가 회전하며 떨어지는 애니메이션이 즉시 보이는지 확인 (지연 1초 이내).
- **6단계**: 자물쇠 아이콘을 화살표 위에 올린 뒤 Apply → `pg_policies` 뷰에 새 정책이 생성되고, 익명 키로 `select` 시 다른 사용자 row가 0건 반환되는지 `curl`로 확인.
- **7단계**: 말풍선에 "매일 자정에 30일 지난 posts를 삭제해줘"라고 적고 Apply → Supabase Functions 목록에 새 함수가 배포되고 `supabase functions invoke`로 드라이런했을 때 오류 없이 의도한 SQL을 실행하는지 로그 확인.
- **8단계**: 테이블 박스를 커피 얼룩 스티커 위로 옮기면 박스 테두리가 갈색 점선으로 바뀌고 Apply 시 `public`이 아닌 `staging` 스키마에 들어가는지 Studio에서 확인.
- **9단계**: 탭을 새로고침해도 캔버스가 복구되고, Supabase Studio에서 테이블을 수동으로 지운 뒤 돌아오면 "DB가 캔버스와 다릅니다" 배너가 뜨는지 확인.
- **10단계**: Vercel Preview URL에서 1–9단계 플로우를 end-to-end로 다시 돌렸을 때 로컬과 동일하게 동작하는지, 함수 로그에 AI Gateway 호출과 Management API 호출이 기록되는지 확인.
