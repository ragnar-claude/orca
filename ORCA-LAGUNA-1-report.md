# ORCA-LAGUNA-1: LM Studio Model Admission & Runtime Integration Report

- **Task ID:** `task_2cd4cab3ca93`
- **Dispatch ID:** `ctx_ef19a04cd944`
- **Date:** 2026-09-18
- **Author:** Worker `term_bc6a603d-ffa0-4357-9a23-3e1c92b2bd27`
- **Coordinator Handle:** `term_83168430-60ec-400d-8042-9ba7bb6b4bb4`
- **Target Environment:** `m5max` (Orca environment `ws://100.85.173.96:6768`, local LM Studio `http://localhost:1234`)

---

## 1. Executive Summary

1. **What was done:** We identified Laguna S 2.1's LM Studio model identity (`poolside/laguna-s-2.1`) and real context configuration (loaded at 32,768 tokens, max 262,144 tokens, Q4_K_M GGUF), updated `launch_guard.py` and the Orca runtime (`local-lm-studio-admission.ts` and `local-lm-studio-context-budget.ts`) to dynamically admit any LM Studio model with Laguna prioritized first in the fallback sequence, and verified all tests and code quality gates to green.
2. **What was found:** OpenCode launch-time model rejection (`Agent opencode does not support launch-time model selection`) on `m5max` is caused by the installed Orca version (1.4.201) lacking the OpenCode launch preference catalog flag implemented in source commit `ca0d808ee5`; when `--model` is omitted, OpenCode reads its default model from `~/.config/opencode/opencode.json` (`model: "lmstudio/qwen/qwen3-coder-30b"`).
3. **What is left:** Build and package the candidate Orca branch (`ragnar-claude/orca-laguna-1`, commit `b0aa775a2d`) for deployment to `m5max`, or temporarily update `~/.config/opencode/opencode.json` on `m5max` to `"lmstudio/poolside/laguna-s-2.1"` until desktop promotion is complete.

---

## 2. Model Discovery & Verification

### 2.1 Laguna S 2.1 Inventory Identity
From preserved evidence (`api-models-during-validtrial.json` and `LAGUNA-CANARY-REPORT.md`) corroborated with coordinator ruling:
- **Model ID:** `poolside/laguna-s-2.1`
- **Publisher:** `poolside`
- **Architecture:** `laguna`
- **Compatibility Type:** `gguf` (MLX builds of Laguna do not load)
- **Quantization:** `Q4_K_M` (~66 GB resident, ~70.9 GB advertised)
- **Context Lengths:**
  - `loaded_context_length`: `32768` (default JIT load window)
  - `max_context_length`: `262144`
- **State & Lifecyle:** JIT load on first OpenAI-compatible request to `http://127.0.0.1:1234/v1` with a 60-minute idle TTL.
- **Tool Use Metadata:** Advertises no `tool_use` capability in `/api/v0/models`, but demonstrated full native tool-calling agentic execution in canary tests.

### 2.2 Probe Attempt & Consumer Fencing
A worker-start probe command was executed from this dispatched worker:
```sh
orca orchestration worker-start --on m5max \
  --spec "print curl -s http://localhost:1234/api/v0/models and /v1/models" \
  --repo id:e74edeb7-157c-4ae5-93f4-a3687ab3e0ad \
  --worktree new-top-level --name laguna-probe \
  --agent opencode --model lmstudio/qwen/qwen3-coder-next --json
```
This returned typed error `consumer_fenced`:
> `worker-start requires the coordinator terminal currently bound to the Task Run. Orchestration mutation request ID: ...`

Because worker dispatches are strictly non-coordinator terminals, worker-start mutations cannot be initiated from a worker. As specified in the instructions, the question was escalated to the coordinator via `orca orchestration ask`, and the coordinator responded with instructions and the subsequent owner ruling.

---

## 3. Owner Ruling & Dynamic Admission Architecture

### 3.1 Owner Ruling (2026-09-18 04:25Z)
> *"we should be able to access all the models on the m5 max. why are we limiting the options???"*

Requirements applied:
1. **Dynamic Model Admission:** Any model reported by LM Studio's `/api/v0/models` inventory is admissible when requested.
2. **Preferred Fallback Sequence:** When no model is explicitly named, admission walks preferred fallbacks in order:
   1. `poolside/laguna-s-2.1`
   2. `qwen/qwen3-coder-30b`
   3. `qwen/qwen3-coder-next`
3. **Dynamic Context-Window Inspection:** Read `loaded_context_length` (or `context_length` / `max_context_length` when `not-loaded`) from the inventory record at admission time rather than hard-coding static 65,536 or 262,144 limits. Fail closed only when the window is below what the prompt needs or lacks tool/output headroom.

### 3.2 Context Window & Reserve Rules
- **Large windows ($\ge$ 262,144 tokens, e.g. Qwen 256K, Mistral 1M):**
  - Tool reserve: 16,384 tokens
  - Output reserve: 32,768 tokens
  - Input budget: $\text{window} - 49,152$ tokens
- **Moderate windows ($<$ 262,144 tokens, e.g. Laguna 32,768, standard 65,536):**
  - Tool reserve: 8,192 tokens
  - Output reserve: 8,192 tokens
  - Input budget: $\text{window} - 16,384$ tokens (e.g. 16,384 tokens for Laguna 32K; 49,152 tokens for 65K)
- **Insufficient windows ($\le$ 16,384 tokens, e.g. 8,192):**
  - Input budget evaluates to $\le 0$, triggering fail-closed refusal `context_unsafe`.

---

## 4. OpenCode Model Selection on m5max

### 4.1 Why `worker-start --on m5max --model ...` Rejects OpenCode
When invoking `worker-start --agent opencode --model lmstudio/...`, Orca validates agent launch capabilities in `worker-launch-preferences.ts`:
```typescript
const catalog = getAgentSessionOptionCatalog(args.agent)
if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
  throw new OrchestrationError(
    'invalid_argument',
    `Agent ${args.agent} does not support launch-time model selection.`
  )
}
```
In the installed desktop app 1.4.201 on `m5max`, `supportsWorkerLaunchPreferences` was not enabled for OpenCode. That feature was implemented in candidate commit `ca0d808ee5` (`feat(orchestration): forward explicit OpenCode --model and recover unproven prompt submission`), which exists in this source worktree but has not yet been deployed to the signed desktop on `m5max`.

### 4.2 How OpenCode Resolves Models Without `--model`
Per OpenCode configuration schema and CLI documentation (`opencode --help`):
- OpenCode supports explicit launch selection via `-m, --model <provider/model>`.
- When `-m / --model` is omitted, OpenCode loads configuration from:
  1. Path pointed to by `$OPENCODE_CONFIG` (or `$OPENCODE_CONFIG_DIR/opencode.json`)
  2. Default user configuration: `~/.config/opencode/opencode.json`
- Within `opencode.json`, the default model is specified by the top-level `"model"` key:
  ```json
  {
    "model": "lmstudio/qwen/qwen3-coder-30b"
  }
  ```
On `m5max`, `~/.config/opencode/opencode.json` is set to `"lmstudio/qwen/qwen3-coder-30b"`. Hence, any worker started without `--model` runs on Qwen 30B.

### 4.3 Coordinator Workarounds on m5max Prior to Orca Desktop Promotion
Until the updated Orca runtime is promoted to `m5max`:
1. **Config Update (Smallest working intervention):**
   Edit `~/.config/opencode/opencode.json` on `m5max` to:
   ```json
   {
     "model": "lmstudio/poolside/laguna-s-2.1"
   }
   ```
   Subsequent worker launches without `--model` will immediately run on Laguna S 2.1.
2. **Environment Overlay:**
   Set `OPENCODE_CONFIG_DIR` in the execution shell to an isolated directory containing a custom `opencode.json`.
3. **Full Desktop Promotion:**
   Build and deploy the updated Orca package containing commit `b0aa775a2d` to `m5max`.

---

## 5. Implementation Details

### 5.1 Python Guard (`/root/orca-control/local-model-guard`)
- **`launch_guard.py`:**
  - Updated `FALLBACK_MODELS` to `("poolside/laguna-s-2.1", "qwen/qwen3-coder-30b", "qwen/qwen3-coder-next")`.
  - Added `resolve_context_reserves(window)` to dynamically apportion token reserves based on window size.
  - Updated `_record_context_window(item)` to inspect `loaded_context_length`, `context_length`, `max_context_length`, and `max_model_len`.
  - Updated `prompt_split_plan(prompt, spec, context_window=None)` and `is_context_unsafe(item, prompt, spec)` to calculate input budget and chunk plans per model window.
  - Updated `admit_local_model` to admit any inventory model dynamically and return the split plan for the model's actual context window.
- **`test_launch_guard.py`:**
  - Updated fallback order test.
  - Added tests verifying Laguna S 2.1 admission at 32,768 tokens, fail-closed refusal on oversized inputs, preference of Laguna over Qwen when unspecified, dynamic inventory model admission, and unloaded model context inspection.
  - All 40 tests in `test_launch_guard.py` pass (56/56 across all test suites in the directory).
- **`README.md`:** Updated documentation for Laguna and dynamic context window admission.

### 5.2 Orca Source Repo (`/root/orca/workspaces/orca-source-publication-20260912/orca-laguna-1`)
- **`local-lm-studio-context-budget.ts`:**
  - Added `resolveContextReserves(contextWindow)` dynamically scaling tool/output token reserves.
  - Enhanced `recordContextWindow(item)` to read `loaded_context_length`, `context_length`, `max_context_length`, and `max_model_len`.
  - Updated `localLmStudioPromptSplitPlan` and `isContextUnsafe` to accept dynamic context windows.
- **`local-lm-studio-admission.ts`:**
  - Added `poolside/laguna-s-2.1` to `LOCAL_LM_STUDIO_FALLBACKS`.
  - Updated candidate loop in `admitLocalLmStudio` to evaluate context safety and split plan using the record's actual context window.
  - Optimized type definitions and error payload construction to ensure the file complies with the 300 max-lines lint rule (294 lines total).
- **`local-lm-studio-admission.test.ts`:**
  - Added unit tests for Laguna S 2.1 32K context admission, oversized prompt fail-closed refusal, fallback precedence, dynamic model admission, and unloaded model inspection.
  - All 12 unit tests pass (`pnpm test src/main/runtime/rpc/methods/orchestration/worker/local-lm-studio-admission.test.ts`).
  - Related tests `local-worker-start-lm-studio-admission.test.ts` and `federated-worker-start-lm-studio-admission.test.ts` pass.
  - Code quality checks (`pnpm run check:code-quality:changed`) pass with 0 findings.
  - Committed on branch `ragnar-claude/orca-laguna-1` as commit `b0aa775a2d`.

---

## 6. Runtime Enforcement vs. Canary Distinction

- **Runtime Enforcement in Orca:**
  The launch guard is enforced directly in Orca's TypeScript runtime. In `src/main/runtime/rpc/methods/orchestration/worker/local-worker-start.ts`, `assertLocalWorkerStartLmStudioAdmission` is called before `db.createStartingWorkerDispatch`. If LM Studio is unreachable, returns malformed data, or if the model context is unsafe, Orca aborts worker creation with a typed `OrchestrationError` without allocating any database records, worker processes, terminals, or worktrees.
- **Role of `launch_guard.py`:**
  `launch_guard.py` is an independent Python canary verification tool used in pre-flight checks, automated canary test scripts, and diagnostic pipelines. It is not called directly by the Electron/Node app at runtime.
- **Role of `canary_orca_cli_node.cjs`:**
  `canary_orca_cli_node.cjs` is test-only harness plumbing. It acts as an executable shim that points `ORCA_RELAY_NODE_PATH` to an isolated exact-source runtime (bypassing the installed desktop binary) and expands `--spec-file` arguments to bypass Linux command-line length limits during automated test runs.

---

## 7. How Changes Reach Installed Orca

1. **Source Commits:**
   Branch `ragnar-claude/orca-laguna-1` in `/root/workspaces/orca-source-publication-20260912`:
   - `9fb2bd795c`: `feat(orchestration): gate local LM Studio workers at 65K`
   - `0e28d24394`: `fix(orchestration): preserve LM Studio admission receipts`
   - `b0aa775a2d`: `feat(orchestration): admit Laguna S 2.1 and dynamic LM Studio inventory models`
2. **Build and Packaging:**
   - Run `pnpm build` to compile main process, preload scripts, and renderer assets.
   - Run `pnpm pack` (or packaging scripts) to generate version-stamped distribution artifacts (`app.asar`, `orca-ide` executable).
3. **Deployment / Release:**
   - Create PR to merge `ragnar-claude/orca-laguna-1` into the release branch (`candidate/terminal-lifecycle-release-20260912` or `main`).
   - Run signed release pipeline to produce desktop release $\ge$ 1.4.202.
   - Install or auto-update the signed release on `m5max` and reload the Orca server service.
