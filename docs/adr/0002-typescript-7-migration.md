# ADR 0002: TypeScript 7 migration plan (proposed)

- Status: proposed
- Date: 2026-10-11
- Tracking: #20 (supersedes automated upgrade #12)

## Context

Dependabot PR #12 upgraded `typescript` from 5.9.x to 7.0.2. Type checking then failed because Node
globals and modules (`node:fs/promises`, `Buffer`, `process`, `NodeJS`) no longer resolved, followed by
downstream implicit-any errors. The supported runtime contract is Node.js `>=22.12.0`.

## Hypothesis (to verify before implementation)

The failures match a change in how ambient `@types/*` packages are included by default (for example a
changed default for `compilerOptions.types`). This has not been confirmed in this repository; the first
implementation step is to reproduce #12 and read the official TypeScript 6/7 release notes.

## Plan

1. Reproduce on a branch: bump `typescript` only, run `pnpm typecheck`, and save the full diagnostic list
   grouped by class.
2. If the hypothesis holds, add an explicit `"types": ["node"]` to each Node-facing tsconfig
   (`packages/core`, `packages/codex-adapter`, `packages/plugin-sdk`, `packages/server`, `apps/cli`),
   leaving `apps/web` on `["vite/client"]`.
3. Fix remaining implicit-any and module-resolution errors with source annotations, not by loosening
   `strict` settings.
4. Keep `@types/node` aligned with the Node 22 runtime contract (see #20); evaluate separately whether the
   current `^24` range should be narrowed.
5. Upgrade `vitest`/`@vitest/coverage-v8` in a separate PR so failures stay attributable.

## Acceptance

Same as #20: `pnpm install --frozen-lockfile`, `pnpm check`, all CI jobs (Node 22.12 on Ubuntu, Windows,
macOS; Node 24; Windows acceptance) green, and no hidden runtime-contract change.

## Not decided here

Raising the Node.js baseline, or changing module/target settings beyond what TypeScript 7 requires.
