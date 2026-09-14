# Orca control-plane gap repair

Date: 2026-09-14 UTC  
Task: `task_8480bcf0aa45` / dispatch `ctx_d63dd8a91541`  
Candidate: `candidate/control-plane-gaps-20260914`  
Base: `9f237c596468b6991dd44c51b72fb9211f7ea787`

## Result

This isolated candidate consolidates the reviewed OpenCode/DeepSeek/M5 work with the
LM Studio admission, provider-neutral lifecycle, and coordinator rotation candidates.
No dirty source worktree was reset, cleaned, staged, or overwritten, and no productive
worker or running Orca relay was restarted.

The candidate now provides:

- live OpenCode (`opencode models`), Antigravity (`agy models`), and Grok (`grok models`)
  catalogs; Antigravity's tabular output is parsed into the real launch id plus label;
- structured worker model selection and requested/effective receipts for OpenCode, Grok,
  and Antigravity;
- pre-allocation LM Studio admission with one inventory fetch, exact 65,536-token Qwen
  window, 49,152 input tokens, and 8,192-token tool/output reserves; refusal codes retain
  `effectsApplied=false` through RPC;
- OpenCode/DeepSeek standalone-submit recovery and capability minting for pane/process-
  bound manual dispatches, so `worker_done` can authenticate;
- verified interactive DeepSeek launch (`deepseek run --yolo --skip-onboarding --fresh`);
- exact remote `/root` placement translation, keeping One's visible root workspace while
  mapping M5 to its registered visible root;
- provider-neutral worker lifecycle, automatic post-settlement release/archive intent,
  rotation at 50% context remaining, fail-closed telemetry, preserved mailbox/handoff
  planning, and quota-aware replacement selection that refuses Kimi unless quota is
  positively available;
- a CLI enumeration surface: `orca terminal quick-command list --json` (alias
  `orca terminal quick-commands`).

## Host configuration correction

The live OpenCode config was backed up byte-for-byte at
`/root/orca-control/evidence/task_8480bcf0aa45/opencode.json.pre-20260914`
(SHA-256 `3f57d753d9083ba253c9639eb835a2fb915b672d7d83f6e261f18933ea822109`).
Two obsolete Hermes-named model entries were removed and the provisional local default
was set to `lmstudio/qwen/qwen3-coder-30b`; resulting config SHA-256 is
`6e2fdaa331f9c47ce598895311304de7a610c85ce480b7eaa5c4cfc2cc54bb6a`.
Rollback is an exact copy from that evidence file back to
`/root/.config/opencode/opencode.json`.

## Proof

- Focused Vitest: 15 files, 299 tests passed.
- CLI TypeScript closure: `npx tsc -p config/tsconfig.cli.json --noEmit` passed.
- Relay packaging: all seven targets built; linux-x64 and darwin-arm64 `relay.js` are
  byte-identical at SHA-256 `f30c475978aa862006814b5e936f717d780bd36aa5b4b577d4058dc6c8817bc5`.
- Live read-only catalogs returned current OpenCode, Antigravity, and Grok inventories;
  DeepSeek reports wrapper/binary v0.8.20.
- Live LM Studio `/v1/models` returned both Qwen coder variants. Native inventory shows
  Qwen 30B installed with `tool_use`; it was not loaded or otherwise mutated by this task.
- Candidate `src/` and `config/` contain zero matches for the removed stale Hermes ids.
- Existing structured Antigravity and Grok live lifecycle receipts remain at
  `/root/orca-control/audit-receipts/task_13d91d2b9d5f-item-065-antigravity-lifecycle-receipt-20260914T020830Z.md`
  and
  `/root/orca-control/audit-receipts/task_8e059656f127-item-066-corrective-grok-lifecycle-receipt-20260914T022449Z.md`.

## Promotion boundary

This task produced and proved a reversible source candidate. It deliberately did not
replace or restart the active relay while productive workers were present. Serving
installation must use this candidate's built artifact during the coordinator's controlled
handoff window, retain the current `0.1.0+6e854f36b859` relay as rollback, and then run a
fresh bounded worker canary for quick-command enumeration, Qwen admission, prompt submit,
`worker_done`, auto-release, and coordinator rotation.
