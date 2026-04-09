# clawd-builder

An AI agent that automatically builds Ethereum dApps for [LeftClaw Services](https://leftclaw.services) (service type 6). It reads a build job from the Base blockchain, plans the implementation across multiple AI models, then executes the full build — scaffolding, writing contracts, deploying, building the frontend, and shipping to IPFS.

## How it works

The agent runs a multi-stage pipeline using a tiered LLM strategy to keep costs low:

| Model | Tier | Used for |
|---|---|---|
| `minimax-m2.7` | cheap | Orchestration, planning, step extraction, boilerplate |
| `claude-sonnet-4.6` | medium | Detailed planning, evaluation, fixing TypeScript errors |
| `claude-opus-4.6` | expensive | Smart contracts, complex full-stack code |

### Pipeline stages

```
read_job         → Fetch job spec from Base blockchain
read_messages    → Fetch client chat from LeftClaw API
fetch_skills     → Download 13 SKILL.md reference files
orchestrate      → cheap LLM analyzes requirements → analysis.json
simple_plan      → cheap LLM outlines build steps → step-outline.md
smart_plan       → medium LLM writes detailed plan → plan.md
extract_steps    → cheap LLM converts plan to JSON steps → steps.json
evaluate         → medium LLM scores the plan → evaluation.json
ensure_deployer  → Set up Foundry keystore for live deploys (if needed)
execute          → Run all steps in topological order with retry + auto-fix
audit            → Write LLM cost/token report → llm-audit.md
```

Each stage caches its output. Re-runs skip completed stages automatically.

## Setup

**Prerequisites:** Node.js 20+, Foundry installed (`curl -L https://foundry.paradigm.xyz | bash`)

```bash
git clone <repo>
cd clawd-builder
npm install
cp .env.example .env  # then fill in your keys
```

**.env file:**
```
# Bankr LLM Gateway — https://docs.bankr.bot/llm-gateway/overview
BANKR_API_KEY=bk_...

# Base RPC (e.g. Alchemy)
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/...

# Agent wallet private key (funds the deployer for live deploys)
ETH_PRIVATE_KEY=0x...

# BGIPFS for IPFS deployment
BGIPFS_API_KEY=xxxx-xxxx-xxxx-xxxx
```

## Usage

```bash
# Full pipeline (default job ID 39)
node run.js

# Full pipeline for a specific job
node run.js --job 43

# Skip planning — re-run execution only from an existing build dir
node run.js --execute builds/job-39-20260407-001148

# Resume a partial run — skip stages whose artifacts already exist
node run.js --resume builds/job-39-20260407-001148
```

## Build artifacts

Every run creates `builds/job-{id}-{timestamp}/`:

```
job.json              On-chain job data
messages.json         Client chat history
skills/               Cached SKILL.md reference files (13 files)
analysis.json         Orchestrator's job analysis
step-outline.md       Simple planner's step list
plan.md               Detailed build plan (markdown)
steps.json            Executable step definitions (JSON)
evaluation.json       Evaluator score and feedback
execution-log.json    Per-step execution results
project/              The built dApp (Solidity + Next.js)
step-{id}-*.log       Shell output per step
llm-audit.md          LLM cost and token usage breakdown
build.log             Full chronological log
trace.json            Machine-parseable event trace
```

## Step schema

Each entry in `steps.json`:

```json
{
  "id": "step-1",
  "name": "Scaffold SE2 project",
  "phase": 1,
  "stage": "scaffold",
  "model": "cheap",
  "description": "...",
  "command": "npx create-eth@latest -s foundry my-app",
  "contextNeeded": ["job", "analysis"],
  "expectedOutput": "package.json exists in project dir",
  "validationGate": "scaffold",
  "dependencies": []
}
```

Steps are executed in topological order based on `dependencies`.

## Enforced SE2 command rules

The executor preprocesses all commands to enforce Scaffold-ETH 2 conventions:

| Task | Correct command |
|---|---|
| Scaffold | `npx create-eth@latest -s foundry <name>` |
| Compile | `yarn compile` |
| Tests | `yarn test` |
| Local node | `yarn chain` |
| Fork Base | `yarn fork --network base` |
| Deploy local | `yarn deploy` |
| Deploy live | `yarn deploy --network base` |
| Verify | `yarn verify --network base` |
| Dev server | `yarn start` |
| Next.js build | `yarn next:build` |
| IPFS deploy | `yarn ipfs` |
| Vercel deploy | `yarn vercel:yolo --prod` |

**Forbidden:** `forge script` (all deploys go through `yarn deploy`), `yarn build` (use `yarn next:build`). The executor will rewrite or block these automatically.

## Three-phase build structure

All plans follow this structure:

**Phase 1 — Local:** Scaffold → write contracts → write tests → deploy locally → build frontend → verify on localhost

**Phase 2 — Live:** Deploy contracts to Base → verify on Blockscout → test with real wallet → polish UI

**Phase 3 — Production:** Deploy to BGIPFS → set `burnerWalletMode: "localNetworksOnly"` → update metadata → final QA

## Auto-fix and retry

The executor retries each step up to 2 times on failure:

- **Missing npm package:** auto-runs `yarn add <package>` before retry
- **Solidity compiler errors:** fixer reads the error, calls medium LLM (Sonnet) to patch the file, retries
- **TypeScript/Next.js errors:** fixer calls cheap LLM to patch the file, retries
- **Test failures:** fixer treats tests as wrong (not the contract) and patches them

## Source layout

```
src/
  llm.js              LLM gateway — cheap/medium/expensive tier dispatch
  logger.js           Logging, cost tracking, trace events
  leftclaw.js         On-chain job reads via viem + LeftClaw REST API
  skills.js           Fetch and cache SKILL.md reference files
  deployer.js         Foundry keystore management for live deploys
  executor.js         Step execution engine (topological sort, retry, fix)
  context-assembler.js  Deterministic LLM prompt construction
  file-writer.js      Parse LLM output into files (7 output formats)
  step-validator.js   Stage-aware result validation
  fixer.js            Auto-fix compiler and test errors via LLM

  agents/
    orchestrator.js   Analyze job requirements (cheap)
    planner.js        Two-stage planning: outline (cheap) → detail (medium)
    evaluator.js      Score and review the plan (medium)
    junior-dev.js     Boilerplate code generation (cheap)
    senior-dev.js     Smart contracts and complex code (expensive)
```

## Cost model

Approximate pricing via Bankr LLM Gateway:

| Model | Input | Output |
|---|---|---|
| minimax-m2.7 | $0.10/1M tokens | $0.30/1M tokens |
| claude-sonnet-4.6 | $3.00/1M tokens | $15.00/1M tokens |
| claude-opus-4.6 | $15.00/1M tokens | $75.00/1M tokens |

Every run produces `llm-audit.md` with a per-model breakdown. The design minimizes expensive model calls: Opus is only used for smart contracts and complex code; everything else defaults to minimax or Sonnet.

## Troubleshooting

**`BANKR_API_KEY not set`** — Copy `.env.example` to `.env` and fill in all keys.

**LLM timeout / 429** — The agent retries automatically with exponential backoff (up to 30s). If it keeps failing, the Bankr gateway may be overloaded.

**`No steps.json found`** — The planning stage did not complete. Run without `--execute` first.

**Deployer wallet has insufficient funds** — The `ETH_PRIVATE_KEY` wallet automatically funds the deployer to 0.001 ETH before live deploys. Make sure your agent wallet has ETH on Base.

**`forge script` blocked** — Expected behavior. All deploys must go through `yarn deploy`. Check that your plan uses the correct command.

**Next.js build fails with `localStorage is not defined`** — The executor injects a polyfill automatically. If it still fails, check the fixer output in `step-{id}-*.log`.
