# context-mode 설치 가이드 (v6x fork)

VoyagerX 사내 사용자용. 감사 완료된 fork **`v6x/context-mode@v1.0.111-v6x.2`**를 설치한다.

| 항목 | 값 |
|---|---|
| Fork 저장소 | https://github.com/v6x/context-mode |
| 권장 태그 | `v1.0.111-v6x.2` |
| 감사 리포트 | [`2026-05-08-security-audit.md`](./2026-05-08-security-audit.md) |
| 사전 조건 | Node.js 18+, `gh` CLI (인증 완료), `tar`, `shasum` |

> **upstream `mksglu/context-mode`는 사용 금지.** npm registry, 마켓플레이스 직접 추가 모두 비대상.

---

## 권장 설치: Tarball + SHA-256 검증

전체 흐름을 한 번에 검증 가능한 유일한 방법. 릴리스 자산을 받아 hash 일치를 확인한 뒤 압축 해제 → 의존성 설치.

### 1. 환경변수 (이후 명령에서 재사용)

```bash
export CTXM_VERSION="v1.0.111-v6x.1"
export CTXM_DIR="$HOME/.local/share/context-mode-v6x"

# SHA-256는 릴리스 본문에서 자동 추출 (gh CLI 사용)
export CTXM_SHA256=$(
  gh release view "$CTXM_VERSION" -R v6x/context-mode --json body --jq .body \
    | grep -oE '[a-f0-9]{64}' | head -1
)
[ -n "$CTXM_SHA256" ] || { echo "SHA 추출 실패 — 릴리스 본문을 직접 확인"; return 1; }
echo "Expected SHA: $CTXM_SHA256"
```

> SHA-256은 tarball에 박을 수 없다 (tarball이 본 문서를 포함 → self-reference). 릴리스 본문이 권위 있는 출처. 강한 out-of-band 검증이 필요하면 본 값을 [`2026-05-08-security-audit.md`](./2026-05-08-security-audit.md)나 사내 Slack 공지의 hash와 대조한다.

### 2. 다운로드 + SHA 검증

```bash
gh release download "$CTXM_VERSION" -R v6x/context-mode -p '*.tar.gz' -D /tmp

actual=$(shasum -a 256 "/tmp/context-mode-${CTXM_VERSION}.tar.gz" | awk '{print $1}')
[ "$actual" = "$CTXM_SHA256" ] || { echo "SHA mismatch — abort"; exit 1; }
echo "SHA OK: $actual"
```

SHA 불일치 시 즉시 중단 — 자산 위변조 가능성. 보안 담당자에게 보고.

### 3. 압축 해제

```bash
mkdir -p "$CTXM_DIR"
tar -xzf "/tmp/context-mode-${CTXM_VERSION}.tar.gz" -C "$CTXM_DIR" --strip-components=1
```

### 4. 의존성 설치 (frozen lockfile)

```bash
cd "$CTXM_DIR"
bun install --frozen-lockfile
# bun이 없으면: npm ci  (bun.lock은 무시되지만 직접 deps는 동일 버전 설치됨)
```

### 5. 바이너리 무결성 재확인 (선택)

설치된 번들이 git tag의 그것과 동일한지 확인:

```bash
git_sha=$(curl -fsSL "https://raw.githubusercontent.com/v6x/context-mode/${CTXM_VERSION}/cli.bundle.mjs" | shasum -a 256 | awk '{print $1}')
local_sha=$(shasum -a 256 "$CTXM_DIR/cli.bundle.mjs" | awk '{print $1}')
[ "$git_sha" = "$local_sha" ] && echo "bundle OK" || echo "bundle MISMATCH"
```

이 단계는 tarball 재패킹 검증과 무관 — 별도로 raw GitHub 콘텐츠와 비교한다.

### 6. 동작 확인

```bash
node "$CTXM_DIR/cli.bundle.mjs" doctor
```

기본 진단 통과해야 함. `upgrade` 명령이 막혀있는지도 함께 확인:

```bash
node "$CTXM_DIR/cli.bundle.mjs" upgrade
# → "DISABLED in v6x fork" 박스 + exit 1
```

---

## 플랫폼별 등록

`$CTXM_DIR`에 설치된 바이너리를 각 클라이언트에 연결.

### Claude Code

마켓플레이스 자동 라우팅을 쓰지 않고, **로컬 설치본**을 MCP로만 등록한다 (자동 풀링 차단).

```bash
claude mcp add context-mode -- node "$CTXM_DIR/start.mjs"
```

전체 hook(PreToolUse/PostToolUse/PreCompact/SessionStart) 활성화는 `~/.claude/settings.json`에 다음 추가:

```json
{
  "mcpServers": { "context-mode": { "command": "node", "args": ["$CTXM_DIR/start.mjs"] } },
  "hooks": {
    "PreToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/hooks/pretooluse.mjs" }] }],
    "PostToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/hooks/posttooluse.mjs" }] }],
    "PreCompact":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/hooks/precompact.mjs" }] }],
    "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/hooks/sessionstart.mjs" }] }],
    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/hooks/userpromptsubmit.mjs" }] }]
  }
}
```

`$CTXM_DIR`을 실제 절대 경로로 치환해 저장. Claude Code 재시작 후 `/mcp list`에서 `context-mode: connected` 확인.

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "context-mode": { "command": "node", "args": ["$CTXM_DIR/start.mjs"] }
  },
  "hooks": {
    "BeforeTool": [{
      "matcher": "run_shell_command|read_file|read_many_files|grep_search|search_file_content|web_fetch|activate_skill|mcp__plugin_context-mode",
      "hooks": [{ "type": "command", "command": "node $CTXM_DIR/cli.bundle.mjs hook gemini-cli beforetool" }]
    }],
    "AfterTool":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/cli.bundle.mjs hook gemini-cli aftertool" }] }],
    "PreCompress": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/cli.bundle.mjs hook gemini-cli precompress" }] }],
    "SessionStart":[{ "matcher": "", "hooks": [{ "type": "command", "command": "node $CTXM_DIR/cli.bundle.mjs hook gemini-cli sessionstart" }] }]
  }
}
```

### Cursor / VS Code Copilot / 기타

각 플랫폼 템플릿: `$CTXM_DIR/configs/<platform>/`. 파일 내 placeholder 경로를 `$CTXM_DIR`로 치환해 해당 클라이언트 설정에 병합.

---

## 업데이트

**자동 업데이트 사용 금지.** 새 fork 태그가 발표되면 [§권장 설치] 절차를 다시 수행한다 (CTXM_VERSION/CTXM_SHA256만 갱신, 나머지 동일). `node $CTXM_DIR/cli.bundle.mjs upgrade`는 v6x.2부터 코드 자체가 막혀 있음.

새 태그 생성은 보안 담당자가 [감사 리포트 §9 운영 가이드](./2026-05-08-security-audit.md)의 절차로 수행.

---

## 트러블슈팅

| 증상 | 조치 |
|---|---|
| `gh: command not found` | `brew install gh` 후 `gh auth login` |
| `SHA mismatch — abort` | 자산 변조 가능성. 보안 담당자에게 즉시 보고. 임시방편 설치 금지 |
| `bun: command not found` | `npm ci`로 대체 (위 4단계 주석 참조) |
| `better-sqlite3` 로드 실패 | `cd "$CTXM_DIR" && npm install better-sqlite3 --no-save` |
| `doctor`에서 hook 미등록 표시 | `upgrade` 명령 사용 금지. §플랫폼별 등록의 JSON을 직접 settings에 추가 |
| Claude Code 플러그인 버전이 `1.0.111`로 표시 | 정상. v6x 패치는 git tag로 추적 (package.json 버전은 upstream 그대로) |
| `~/.claude/hooks/context-mode-cache-heal.mjs` 자동 생성 | `start.mjs` Layer 4 (캐시 self-heal). 인라인 코드 — 감사 완료, 무해 |

---

## 제거

```bash
rm -rf "$CTXM_DIR"

# Claude Code MCP 등록 제거
claude mcp remove context-mode

# settings.json의 hook/mcp 항목은 수동 편집

# 자동 배포된 self-heal hook 정리
rm -f ~/.claude/hooks/context-mode-cache-heal.mjs

# 데이터/인덱스 정리 (필요 시)
rm -rf ~/.context-mode
```

---

## 대안 설치 방법 (참고용)

상황별 trade-off. **권장하지 않음** — SHA 검증 단계가 빠지거나 태그 고정이 약함.

| 방법 | 명령 | 약점 |
|---|---|---|
| Git tag clone | `git clone -b v1.0.111-v6x.2 --depth 1 https://github.com/v6x/context-mode "$CTXM_DIR" && cd "$CTXM_DIR" && bun install --frozen-lockfile` | tarball SHA 비교 단계 없음 (git의 commit hash 검증으로 갈음 가능하지만 사람이 잘 안 함) |
| Claude Code 마켓플레이스 | `/plugin marketplace add v6x/context-mode` → `/plugin install context-mode@context-mode` | **태그 고정 안 됨** — 마켓플레이스가 main 브랜치 추적. v6x 내부 push가 즉시 반영됨 |
| npm via GitHub | `npm install -g github:v6x/context-mode#v1.0.111-v6x.2` | npm global bin 위치가 PATH에 따라 다름. SHA 검증 단계 없음 |

이 셋도 **소스는 v6x fork**이므로 위협 모델상 acceptable이지만, 권장 흐름은 tarball + SHA 검증으로 통일한다.
