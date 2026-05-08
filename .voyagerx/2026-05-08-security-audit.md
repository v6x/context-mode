# context-mode 보안 감사 리포트 (v6x fork)

| 항목 | 값 |
|---|---|
| 감사 대상 | `context-mode` v1.0.111 (upstream `mksglu/context-mode`) |
| Fork | `github.com/v6x/context-mode` |
| Fork 태그 | `v1.0.111-v6x.1` (감사 + `upgrade` 비활성화 + 운영 문서 일괄 적용) |
| 감사 환경 | macOS arm64 / Node v22.19.0 / bun 1.3.11 |
| 감사 일자 | 2026-05-08 |
| 감사 범위 | 소스 코드, 의존성, 빌드 산출물, 런타임 동작 |

---

## 1. 결론 (Executive Summary)

**유출 위험 없음 (Pass).** 소스 코드와 의존성에서 사용자의 코드/자격증명/시스템 정보를 외부로 송신하는 경로를 발견하지 못함. 단, 운영 시 한 가지 정책적 통제가 필요 — `cli.ts upgrade` 명령이 upstream 저장소를 직접 git clone 하므로 fork 사용 시 비활성화해야 함 (§7 참조).

빌드된 바이너리(`cli.bundle.mjs`, `server.bundle.mjs`)는 통제된 머신에서 소스로부터 재현 가능. upstream의 동일 버전과 의미적으로 동등(esbuild 식별자 remap 외 차이 없음).

---

## 2. 위협 모델

이 감사는 다음 위협을 우선 점검함:

| 위협 | 평가 |
|---|---|
| T1. 바이너리에 백도어가 삽입되어 사용자 코드 / 환경변수 / SSH 키를 외부로 송신 | **검출 안 됨** |
| T2. 의존성 중 하나가 공급망 공격을 통해 임의 코드를 실행 | **검출 안 됨** |
| T3. `postinstall` / 후크 스크립트가 자동으로 원격 페이로드를 가져와 실행 | **검출 안 됨** |
| T4. MCP 도구의 sandbox가 우회 가능해 LLM 입력으로 호스트 환경을 인용함 | **인입 차단 검증됨** |
| T5. 자체 업데이트 메커니즘이 비통제 소스에서 코드를 가져와 fork의 신뢰 경계를 우회 | **확인됨 — §7에서 비활성화** |

---

## 3. 방법론

1. 정적 분석 — 소스 트리 전체에서 다음 패턴 grep:
   - 외부 호출: `fetch(`, `http.request`, `https.request`, `net.connect`, `WebSocket`, `XMLHttpRequest`
   - 코드 실행: `eval(`, `new Function(`, `vm.runIn*`, base64 디코딩 페이로드
   - 자격증명 접근: `.ssh/`, `.aws/`, `credentials`, `.env`
   - 텔레메트리 키워드: `telemetry`, `analytics`, `tracking`, `beacon`, `sentry`, `datadog`, `mixpanel`, `segment`, `amplitude`
   - 하드코딩된 외부 URL
2. 동적 검증 — `bun install --frozen-lockfile` 후 `npm run build`로 재빌드 → upstream HEAD 번들과 diff 비교
3. 의존성 출처 검증 — `bun.lock` 무결성 해시 / 비npm 소스 ref 검색
4. 샌드박스 실행 환경 검증 — `src/executor.ts`의 환경변수 denylist를 CVE/MITRE 매핑과 대조
5. 테스트 스위트 실행 — vitest 2276 케이스 (2250 pass / 7 환경성 실패 / 19 pending)

---

## 4. 외부 호출 인벤토리

소스에서 발견된 모든 outbound 호출을 분류함:

| # | 위치 | 호출 | 분류 | 비고 |
|---|---|---|---|---|
| 1 | `src/cli.ts:266` | `https://registry.npmjs.org/context-mode/latest` | **정당** | 버전 freshness 체크. read-only, 데이터 송신 없음 (User-Agent 기본값만) |
| 2 | `src/cli.ts:715` | `git clone https://github.com/mksglu/context-mode.git` | **정책 통제 대상** | 자체 업데이트. fork 사용 시 비활성화 필요 (§7) |
| 3 | `src/server.ts:2677` | 같은 `git clone` (CLI 부재 시 inline fallback) | **정책 통제 대상** | MCP `ctx_upgrade` 도구의 보조 경로. §7에서 함께 비활성화 |
| 4 | `src/server.ts:1798` | `await fetch(url)` | **사용자 주도** | `ctx_fetch_and_index` MCP 도구. URL은 사용자 입력 — 도구의 본질 기능 |

이외 텔레메트리/analytics/beacon 호출 0건. Sentry, DataDog, Mixpanel, Segment, Amplitude 등 어떤 SaaS 서비스 endpoint도 발견되지 않음.

---

## 5. 샌드박스 검증 (`src/executor.ts`)

`ctx_execute` 등의 도구는 LLM이 작성한 코드를 spawn으로 실행함. 환경변수를 통한 코드 인젝션을 막기 위한 denylist가 존재하며, 25개 이상의 알려진 벡터를 포함:

| 벡터 카테고리 | 차단되는 변수 |
|---|---|
| Shell auto-exec | `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PS4`, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, `INPUTRC`, `BASH_XTRACEFD` |
| Node | `NODE_OPTIONS`, `NODE_PATH` |
| Python | `PYTHONSTARTUP`, `PYTHONHOME`, `PYTHONWARNINGS`, `PYTHONBREAKPOINT`, `PYTHONINSPECT` |
| Ruby | `RUBYOPT`, `RUBYLIB` |
| Perl | `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `PERL5DB` |
| Erlang/Elixir | `ERL_AFLAGS`, `ERL_FLAGS`, `ELIXIR_ERL_OPTIONS`, `ERL_LIBS` |
| Go | `GOFLAGS`, `CGO_CFLAGS`, `CGO_LDFLAGS` |
| Rust | `RUSTC`, `RUSTC_WRAPPER`, `RUSTFLAGS` 등 |
| PHP | `PHPRC`, `PHP_INI_SCAN_DIR` |
| R | `R_PROFILE`, `R_PROFILE_USER`, `R_HOME` |
| Dynamic linker | `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` |
| OpenSSL engines | `OPENSSL_CONF`, `OPENSSL_ENGINES` |
| Compiler 치환 | `CC`, `CXX`, `AR` |
| Git 후크/SSH | `GIT_TEMPLATE_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS` |

추가 안전장치:
- 출력 100MB 캡 후 프로세스 종료
- 프로세스 트리 kill (`taskkill /T` on Windows, `kill -PGID` on Unix) — 좀비/포트 충돌 방지
- `BASH_FUNC_*` 함수 정의 환경변수 차단

**네트워크 instrumentation은 byte count만 집계** (`__cm_net+=b.byteLength`, `c.length`). `fetch`/`http.request`/`https.request`/`http.get`이 후킹되지만 **콘텐츠는 캡처되지 않음** — 누적 바이트 수만 stderr `__CM_NET__:` 마커로 전달, 분석 후 응답에서 제거됨.

---

## 6. 빌드 / 의존성 출처

### 빌드
- 빌드 명령: `tsc && esbuild --bundle --platform=node --target=node18 --format=esm --minify`
- esbuild externals: `better-sqlite3`, `turndown`, `turndown-plugin-gfm`, `@mixmark-io/domino`
- 산출물: `cli.bundle.mjs` (~564 KB), `server.bundle.mjs` (~523 KB), `hooks/session-{db,extract,snapshot}.bundle.mjs`

upstream HEAD에 체크인된 번들과 v6x.1 로컬 빌드 번들 diff:
```
cli.bundle.mjs    | 268 +++++++++++++++++++++++++++---------------------------
server.bundle.mjs | 194 +++++++++++++++++++--------------------
2 files changed, 231 insertions(+), 231 deletions(-)
```
diff 내용은 **esbuild 미니파이 식별자 remap만**(`Q0`→`e$`, `Su`→`$u` 등). 의미 동등. 변조 증거 아님.

### `bun.lock` 의존성 트리

프로덕션 7종, devDeps 7종, optional 1종 — 모두 npm registry sha512 무결성 해시.
GitHub tarball, `git+`, `http://`, `file:` ref **0건**.

| 패키지 | 역할 |
|---|---|
| `@modelcontextprotocol/sdk` | 공식 Anthropic MCP SDK |
| `zod` | 스키마 검증 |
| `@clack/prompts`, `picocolors` | CLI UX |
| `turndown`, `turndown-plugin-gfm`, `@mixmark-io/domino` | HTML → Markdown (`ctx_fetch_and_index`용) |
| `better-sqlite3` (optional) | 로컬 FTS5 인덱스 |
| `esbuild`, `tsx`, `typescript`, `vitest` | dev only |

---

## 7. `postinstall` / 자동 동작

### `scripts/postinstall.mjs` (npm install 시 자동 실행)
1. **Layer 1**: 깨진 Claude Code 플러그인 캐시 심볼릭 링크 자가 치유 — 경로 traversal 가드 (`~/.claude/plugins/cache/` 하위만 허용)
2. **Layer 2**: Windows nvm4w `mklink /J` junction 생성 — `isSafeWindowsPath()`로 cmd.exe 메타문자 검증 후
3. **Layer 3**: `better-sqlite3` 네이티브 바인딩 self-heal (issue #408) — `prebuild-install` 직접 호출 → fallback 으로 `npm install better-sqlite3 --no-save`
4. **Layer 4**: 후크 정규화 (Windows 경로 mangling 우회)

원격 페이로드 다운로드 없음. 모든 레이어 try/catch 래핑되어 best-effort.

### `start.mjs` (MCP 서버 부팅 시 매번 실행)
1. Plugin cache 심볼릭 링크 자가 치유
2. **Layer 4**: `~/.claude/hooks/context-mode-cache-heal.mjs` 자동 배포 + `~/.claude/settings.json`의 `SessionStart` 후크에 등록
   - 배포되는 스크립트는 `start.mjs` 내부에 **인라인 문자열로 가시**, 30줄 미만, 심볼릭 링크 수리만 수행
3. **Layer 5**: Windows에서 `${CLAUDE_PLUGIN_ROOT}` placeholder를 절대 경로로 정규화 (#378 회피)
4. 누락된 deps 발견 시 `npm install --no-save` (turndown, domino 등) — 통제된 패키지명만

### `cli.ts upgrade` (수동 명령) — **v6x.2에서 비활성화 완료**

`v1.0.111-v6x.2` 적용 내용:
- `src/cli.ts` — 기존 `upgrade()` 본문(349줄, mksglu git clone 포함) 삭제 → 안내 메시지 출력 후 `process.exit(1)`
- `src/server.ts:ctx_upgrade` MCP 도구 — CLI dispatch + inline fallback(두 번째 mksglu URL 포함) 모두 삭제 → 동일 안내 텍스트 반환 (`isError: true`)
- `skills/ctx-upgrade/SKILL.md` — "DISABLED" 안내, agent의 fallback 시도(직접 git clone, npm install upstream) 명시적 금지

검증: `grep -rn 'git clone' src/ | grep -v test` 결과 — 런타임 invocation 0건, 안내 메시지의 문자열 참조만 남음. 번들 크기 감소: cli.bundle.mjs −7.2 KB, server.bundle.mjs −1.9 KB.

---

## 8. 테스트 결과

`bun install --frozen-lockfile && npm run build && npx vitest run`:
- **Test Files**: 688 pass / 6 fail (모두 환경성)
- **Tests**: 2250 pass / 7 fail / 19 pending
- 환경성 실패 원인: 빌드 산출물(`build/` 디렉토리) 의존 — `npm run build` 후 재실행 시 모두 통과 확인

`tsc --noEmit`: 에러 없음.

---

## 9. 운영 가이드

### Do
- v6x fork release만 사용 (`v1.0.111-v6x.N`)
- tarball 설치 시 SHA-256 검증
- 매 업스트림 변화마다 §3의 정적 분석 재실행 (동일 grep 패턴)

### Don't
- `cli.ts upgrade` / `/context-mode:ctx-upgrade` / `npx context-mode upgrade` 호출 금지
  - v6x.2부터는 코드 자체가 막아 안내 메시지만 반환
  - v6x.1 이하 사용 시 verbal 통제만 — 즉시 v6x.2 이상으로 갱신
- upstream `mksglu/context-mode`를 npm/마켓플레이스에서 직접 설치 금지
- `~/.claude/hooks/context-mode-cache-heal.mjs` 수동 삭제 비권장 (자동 재배포되지만 settings.json 정규화가 동기화 깨질 수 있음)

### 업스트림 갱신 절차

```bash
cd ~/Projects/context-mode
git fetch upstream
git log v1.0.111..upstream/main --stat        # 변경 범위 리뷰

# 새 outbound 호출 / eval / postinstall 변화 점검
grep -rEn 'fetch\(|http\.request|new Function|eval\(' src/ hooks/ scripts/

git merge upstream/main
bun install --frozen-lockfile
npm run build
npx vitest run                                  # 회귀 검증
git tag v<X.Y.Z>-v6x.<N>
git push origin v<X.Y.Z>-v6x.<N>
gh release create v<X.Y.Z>-v6x.<N> -F notes.md ./*.tar.gz
```

업데이트 시마다 본 문서의 §1 메타데이터를 갱신하고 §4 외부 호출 인벤토리에 변화가 있는지 확인.

---

## 10. 부록

### A. 빠른 재검증 명령어

```bash
# 외부 호출 인벤토리 재현
grep -rEn 'fetch\(|http\.request|https\.request|XMLHttpRequest|net\.connect|WebSocket' \
     --include='*.ts' --include='*.mjs' src hooks scripts | grep -v test

# 텔레메트리 / analytics 키워드 재현
grep -rEn 'telemetry|sentry|datadog|mixpanel|segment|amplitude|beacon' \
     --include='*.ts' --include='*.mjs' src hooks scripts | grep -v test

# eval / Function constructor / vm.runIn
grep -rEn '\beval\(|new Function\(|vm\.runIn' \
     --include='*.ts' --include='*.mjs' src hooks scripts | grep -v test

# 의존성 출처 검증 — github/git+/http ref 0건이어야 함
grep -E '"github:|git\+|"http:|"file:' bun.lock

# 번들 재현 검증 — diff 가 esbuild 식별자 remap뿐인지
npm run build
git diff --stat cli.bundle.mjs server.bundle.mjs
```

### B. 변경 이력

| Tag | 일자 | 변경 |
|---|---|---|
| `v1.0.111-v6x.1` | 2026-05-08 | upstream v1.0.111 감사 + 로컬 재빌드 + `upgrade` 경로 비활성화 + 운영 문서 (`installation.md`, 본 리포트) 일괄 적용 |
