---
name: ctx-upgrade
description: |
  DISABLED in v6x fork. Automatic upgrade is blocked because it would clone
  upstream mksglu/context-mode and bypass the v6x security audit.
  Trigger: /context-mode:ctx-upgrade
user-invocable: true
---

# Context Mode Upgrade — DISABLED in v6x fork

Automatic upgrade is disabled in this fork.
See `.voyagerx/2026-05-08-security-audit.md` §7 for rationale.

## Instructions when invoked

1. Call the `ctx_upgrade` MCP tool. It returns a disabled notice with the
   manual update flow.
2. Relay that notice to the user verbatim and stop.
3. Do **NOT** attempt any of these fallbacks:
   - Running `node cli.bundle.mjs upgrade` directly
   - Running `node build/cli.js upgrade` directly
   - `git clone https://github.com/mksglu/context-mode` manually
   - npm/bun install of upstream `context-mode` package

## Manual update flow (for operators)

The operator — not the agent — performs these on a controlled machine:

1. `cd <fork checkout>`
2. `git fetch upstream && git log <last-tag>..upstream/main --stat`  *(review)*
3. **Re-audit** changed source for new outbound calls, eval, postinstall changes
4. `git merge upstream/main`
5. `bun install --frozen-lockfile && npm run build`
6. `npx vitest run`  *(regression check)*
7. `git tag vX.Y.Z-v6x.N && git push origin vX.Y.Z-v6x.N`
8. `gh release create vX.Y.Z-v6x.N -F notes.md ./*.tar.gz`
