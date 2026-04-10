import { cheap, medium, expensive } from '../llm.js';
import { logDecision, log } from '../logger.js';
import { buildSkillContext } from '../skills.js';

const SE2_COMMAND_RULES = `
## CRITICAL SE2 COMMAND RULES — NEVER VIOLATE THESE

These are the ONLY valid commands. Use them exactly as shown.

- SCAFFOLD:      npx create-eth@latest -s foundry <name>
- COMPILE:       yarn compile                        (NEVER "forge build")
- TESTS:         yarn test                           (NEVER "forge test" directly)
- LOCAL NODE:    yarn chain                          (NEVER "anvil" directly)
- FORK:          yarn fork --network base            (NEVER "anvil --fork-url ...")
- DEPLOY LOCAL:  yarn deploy                         (NEVER "forge script ...")
- DEPLOY LIVE:   yarn deploy --network base          (NEVER "forge script ...")
- VERIFY:        yarn verify --network base
- DEV SERVER:    yarn start
- BUILD:         yarn next:build                     (NEVER "yarn build" — does not exist)
- PRODUCTION DEPLOY: yarn ipfs                      (BGIPFS — this is the REQUIRED production frontend deploy)
- VERCEL (DEV ONLY): yarn vercel:yolo --prod         (ONLY for dev previews — NEVER use for production)

"forge script" is FORBIDDEN in all steps. It bypasses SE2's key management and ABI generation.
All deployment goes through "yarn deploy" which handles everything correctly.

NEVER write or generate "packages/nextjs/contracts/deployedContracts.ts" — it is AUTO-GENERATED
by "yarn deploy" and will be overwritten. Any step that writes it manually produces fake data.

FONTS: Use Google Fonts CDN via <link> in layout.tsx or next/font/google import.
NEVER use @fontsource packages — they require a separate npm install step that breaks builds.
Example: <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />

CSS/TAILWIND: SE2 uses Tailwind CSS v4.
- The correct import is: @import "tailwindcss";
- NEVER use Tailwind v3 syntax: @tailwind base; @tailwind components; @tailwind utilities; — these DO NOT EXIST in v4 and will break the build.
- DO NOT rewrite globals.css from scratch. Only ADD custom CSS rules after the existing imports.
- The DaisyUI theme is configured via "@plugin "daisyui/theme"" blocks in globals.css — add new theme blocks, don't replace the import structure.
- NEVER use @apply with DaisyUI semantic tokens (bg-base-100, bg-base-200, bg-base-300, text-base-content, text-primary, text-error, border-base-200, etc.)
  These are CSS variables, NOT Tailwind utilities, and @apply will throw "Cannot apply unknown utility class" at build time.
  Instead: use them directly in className="bg-base-200" in JSX/TSX, or use CSS variables directly: background-color: oklch(var(--b2))
- NEVER write @import "daisyui/theme" — this path does not exist in the daisyui package and will crash the webpack build with "Module not found: Can't resolve 'daisyui/theme'".
  DaisyUI is already registered via @plugin "daisyui" in SE2's default globals.css. Just add your [data-theme="..."] custom theme blocks after that line.

DEPLOY SCRIPT STRUCTURE — AVOID DOUBLE vm.startBroadcast:
Deploy.s.sol MUST deploy contracts directly inline using ScaffoldEthDeployerRunner.
NEVER call DeployYourContract.run() or DeployBurnBoard.run() from Deploy.s.sol — those
sub-scripts each have their own ScaffoldEthDeployerRunner modifier which calls vm.startBroadcast
again, causing "vm.startBroadcast: a broadcast is active already" revert.
NEVER deploy the SE2 default YourContract — only deploy your custom contract (e.g. BurnBoard).

Correct Deploy.s.sol pattern:
  contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
      BurnBoard burnBoard = new BurnBoard(cawdTokenAddress);
      deployments.push(Deployment({name: "BurnBoard", addr: address(burnBoard)}));
    }
  }

RESEARCH/VERIFICATION STEPS MUST BE NON-BLOCKING:
Steps that only verify or read external state (cast call, curl, cast balance, etc.) MUST NOT
be listed as dependencies for contract writing, test writing, or any other code generation step.
A cast call may revert or hit RPC rate limits — if code steps depend on it, the entire build fails.
Verification steps may run in parallel with or after code steps, but never as prerequisites.

DEPLOY SCRIPTS WITH TOKEN/ADDRESS CONSTRUCTOR ARGS:
When a contract takes an ERC20 token address (or any other external contract address) as a constructor
argument, the Deploy.s.sol MUST hardcode the real Base mainnet address as the vm.envOr default.
NEVER use address(0) as the default — the constructor will revert "cannot be zero" and kill the deploy.
Extract the address from the job description and use it directly:
  address clawdToken = vm.envOr("CLAWD_TOKEN_ADDRESS", 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07);
When forking Base mainnet (yarn fork --network base), the real token address is already live
in the fork — using address(0) causes an immediate revert.

NO "cat" / "ls" / "read file" STEPS:
NEVER include a separate step just to read AGENTS.md, CLAUDE.md, or any documentation file.
The build executor automatically gathers file context before each code-generation step.
A "cat AGENTS.md" step will fail and cascade-skip ALL downstream steps, breaking the build.
If you need to reference a file's content, it will be read automatically — do not add it as a step.

LOCAL DEPLOY ALWAYS REQUIRES A RUNNING CHAIN:
Before "yarn deploy" (local), you MUST have a step that runs "yarn fork --network base".
The fork step starts a local anvil node forked from Base mainnet — required for all local deploys.
Step order in Phase 1: scaffold → write contract → write tests → compile → run tests → yarn fork --network base → yarn deploy → write frontend → yarn next:build

SE2 scaffold-eth PACKAGE EXPORTS (from ~~/hooks/scaffold-eth or ~~/components/scaffold-eth):
Valid exports include: Address, Balance, BlockieAvatar, AddressInput, EtherInput, IntegerInput,
useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory, useTargetNetwork, etc.
NEVER import: AddressAvatarDropdown, ConnectWallet, Web3Button, or any component you haven't seen
explicitly listed in the SE2 source. Use RainbowKit's ConnectButton from "@rainbow-me/rainbowkit" directly.

LAYOUT.TSX MUST USE ScaffoldEthAppWithProviders — NEVER call getDefaultConfig() in layout.tsx:
The root layout (app/layout.tsx) is a SERVER component. getDefaultConfig() from @rainbow-me/rainbowkit
is a CLIENT function and will fail during Next.js build (static page generation).
Always use the SE2 pattern in layout.tsx:
  import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
  export default function RootLayout({ children }) {
    return <html><body><ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders></body></html>;
  }
NEVER import getDefaultConfig, WagmiProvider, RainbowKitProvider, or QueryClientProvider in layout.tsx.
ScaffoldEthAppWithProviders already sets all of these up correctly as a client component.

RAINBOWKIT + NEXT.JS APP ROUTER: Any component that imports from @rainbow-me/rainbowkit OR
uses wagmi hooks (useAccount, useBalance, etc.) MUST have "use client" at the top.
Missing "use client" causes "getDefaultConfig() from the server" build error.
All custom components using blockchain state must be Client Components.

SE2 BUILT-IN COMPONENTS (the only ~~/components/* that exist in a fresh scaffold):
- ~~/components/Header  (SE2 default header — may be removed/replaced)
- ~~/components/Footer  (SE2 default footer — may be removed/replaced)
- ~~/components/ScaffoldEthAppWithProviders  (root provider wrapper in layout.tsx)
- ~~/components/ThemeProvider  (dark/light mode)
- ~~/components/BlockieAvatar
NEVER import from ~~/components/AppWrapper, ~~/components/Layout, ~~/components/Navbar,
or any other component that you haven't written yourself in a prior step.
If you need a wrapper component, write it yourself or use ScaffoldEthAppWithProviders.

SE2 HOOKS CONTRACT NAMES:
useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory all take a contractName
that MUST exactly match a contract name in deployedContracts.ts (generated by yarn deploy).
NEVER use test helper contract names (MockERC20, MockToken, etc.) as contractName in frontend hooks.
Only use the real deployed contract name (e.g. "BurnBoard", "YourContract", etc.).

CONTRACT + DEPLOY SCRIPT MUST BE WRITTEN TOGETHER:
When writing the main contract (e.g. BurnBoard.sol), Deploy.s.sol MUST be written in the SAME step.
Both files must be output together so the deploy script stays in sync with the contract.
The step that writes the contract must also write/update Deploy.s.sol to deploy that contract.
If they are in separate steps and the contract step triggers a compile check, the fixer may
clobber Deploy.s.sol back to the default scaffold template, wiping the deployment logic.
ALWAYS bundle: BurnBoard.sol + Deploy.s.sol in a single code-generation step.

PHASE 1 MUST INCLUDE FRONTEND STEPS:
After deploying locally (yarn deploy), Phase 1 MUST include steps to build the frontend before
moving to Phase 2. Required frontend steps in Phase 1:
  1. Write the main page component in packages/nextjs/app/page.tsx (or equivalent)
  2. Use SE2 hooks ONLY: useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory
     — NEVER use raw wagmi hooks (useContractRead, useContractWrite, etc.)
  3. Run "yarn next:build" to verify no TypeScript errors
  4. Run "yarn start" to confirm the dev server starts
ALL FRONTEND COMPONENT WRITING happens in Phase 1. Phase 2 and 3 are deployment steps only.
Do NOT defer frontend work to Phase 3.
`;

export async function simplePlan(job, messages, analysis, skills) {
  const orchestrationContext = buildSkillContext(skills, ['ethskills-orchestration'], 6000);
  // Pass scaffold-eth skills in full — these are the source of truth for all commands
  const se2Context = buildSkillContext(skills, ['scaffold-eth', 'scaffold-eth-agents'], 20000);

  const prompt = `You are a build planner for Scaffold-ETH 2 dApps. You MUST follow the three-phase build system below exactly.
${SE2_COMMAND_RULES}
## THREE-PHASE BUILD SYSTEM (THIS IS YOUR FRAMEWORK — FOLLOW IT)
${orchestrationContext}

## SE2 Project Structure & Commands (SOURCE OF TRUTH — read in full)
${se2Context}

## Job Analysis
${JSON.stringify(analysis, null, 2)}

## Job Description (first 500 chars)
${(job.description || '').slice(0, 500)}

## YOUR TASK

Output a numbered list of build steps organized into THREE PHASES. Every build follows this structure — no exceptions:

### PHASE 1: LOCAL (contracts + UI on localhost)
Steps in this phase:
1. Scaffold: \`npx create-eth@latest -s foundry <name>\`
2. Write contracts in packages/foundry/contracts/
3. Write deploy script in packages/foundry/script/
4. Write tests in packages/foundry/test/ (≥90% coverage)
5. Run \`yarn fork --network base\` + \`yarn deploy\` — validate deployedContracts.ts generated
6. Build frontend pages in packages/nextjs/app/, components in packages/nextjs/components/
7. Use SE2 hooks: useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory
8. Validate: full user journey works on localhost with forked chain

### PHASE 2: LIVE CONTRACTS + LOCAL UI
Steps in this phase:
1. Update scaffold.config.ts targetNetworks
2. \`yarn deploy --network base\` + \`yarn verify --network base\`
3. Test with real wallet against live contracts
4. Polish UI, remove SE2 branding, apply custom theme
5. Validate: contracts verified on Blockscout, full journey works with live contracts

### PHASE 3: PRODUCTION
Steps in this phase:
1. Set burnerWalletMode: "localNetworksOnly"
2. Update metadata (title, description, OG image)
3. Build + deploy to BGIPFS: \`yarn ipfs\` — THIS IS MANDATORY. Do NOT use Vercel. The production frontend MUST be deployed via BGIPFS (\`yarn ipfs\`), not \`yarn vercel:yolo\`.
4. Production QA: wallet connect, read/write ops, no console errors, mobile responsive

⚠️ BGIPFS IS REQUIRED — NOT OPTIONAL. Every build MUST end with \`yarn ipfs\` for production frontend deployment. Vercel is NOT an acceptable substitute.

For each step, note:
- What to do (exact SE2 paths and commands)
- Which model tier: cheap (minimax-m2.7), medium (claude-sonnet-4.6), or expensive (claude-opus-4.6)
- What inputs/context it needs
- Validation gate (how to confirm the step succeeded before moving on)

Be brief but specific. This guides the smart planner.`;

  const result = await expensive(
    'You are a build step planner for Scaffold-ETH 2 dApps. You follow the three-phase build system (Phase 1 local, Phase 2 live contracts, Phase 3 production) exactly. Output concise numbered steps organized by phase.',
    prompt,
    { role: 'simple-planner', maxTokens: 8192 }
  );

  logDecision('simple-planner', 'steps_outlined', `Generated step outline`);
  return result;
}

export async function smartPlan(job, messages, analysis, skills, stepOutline) {
  const clientChat = messages
    .filter(m => m.type === 'client_message' || m.type === 'ai_response')
    .map(m => `[${m.type}] ${m.content}`)
    .join('\n\n');

  // Lean prompt — the job description already contains the spec.
  // Sonnet doesn't need full skill files; it needs the job, the outline, and the rules.
  const prompt = `Write a detailed Scaffold-ETH 2 build plan for this LeftClaw Services job.
${SE2_COMMAND_RULES}
## Job
- ID: ${job.id}
- Client: ${job.client}
- Service Type: ${job.serviceTypeId} (Build)

## Description
${(job.description || '').slice(0, 2000)}

## Client Chat
${clientChat.slice(0, 1000) || '(none)'}

## Orchestrator Analysis
${JSON.stringify(analysis, null, 2).slice(0, 1200)}

## Step Outline (from simple planner — already organized by phase)
${stepOutline.slice(0, 2500)}

## Your Task

Write a comprehensive build plan in markdown:

### 1. Architecture Overview
- What goes onchain vs offchain, contract design, frontend components, chain rationale

### 2. Smart Contract Plan
- Each contract: name, purpose, key functions, storage layout
- Security considerations, testing strategy

### 3. Frontend Plan
- Component hierarchy
- Hook usage (useScaffoldReadContract, useScaffoldWriteContract — NOT raw wagmi)
- UX flows (approval flow, loading states, error handling)
- Theming/styling from client chat
- DaisyUI classes where possible

### 4. Phase 1 Steps (LOCAL: scaffold + contracts + tests + frontend on localhost)
For each step: model tier, expected output, validation gate.

### 5. Phase 2 Steps (LIVE CONTRACTS + LOCAL UI)
- Deploy to Base, verify, test with real wallet, polish UI

### 6. Phase 3 Steps (PRODUCTION)
- Metadata, BGIPFS deploy (\`yarn ipfs\` — MANDATORY, NOT Vercel), production QA

### 7. Phase Transition Rules
- Phase 3 bug → Phase 2, Phase 2 contract bug → Phase 1, never hack in production

Use SE2 patterns. Deploy to Base.`;

  const system = 'You are a senior Ethereum dApp architect. You follow the three-phase build system (Phase 1 local, Phase 2 live contracts, Phase 3 production) exactly. Write precise, actionable build plans.';

  // Try Sonnet first with reduced maxTokens (4096 keeps us well under gateway timeout)
  try {
    const result = await medium(system, prompt, { role: 'smart-planner', maxTokens: 4096 });
    logDecision('smart-planner', 'plan_written', 'Generated detailed build plan (sonnet)');
    return result;
  } catch (err) {
    log(`Smart planner (sonnet) failed: ${err.message}. Falling back to minimax...`);
    logDecision('smart-planner', 'sonnet_failed', err.message);
  }

  // Fallback: minimax with full skill context (it's cheap, so we can give it more context)
  const orchestrationContext = buildSkillContext(skills, ['ethskills-orchestration'], 4000);
  const se2Context = buildSkillContext(skills, ['scaffold-eth', 'scaffold-eth-agents'], 8000);
  const fallbackPrompt = prompt + `\n\n## Build Methodology Reference\n${orchestrationContext}\n\n## SE2 Reference\n${se2Context}`;

  const result = await cheap(system, fallbackPrompt, { role: 'smart-planner-fallback', maxTokens: 4096 });
  logDecision('smart-planner', 'plan_written', 'Generated build plan (minimax fallback)');
  return result;
}

export async function generateSteps(plan, analysis) {
  const prompt = `Extract the executable build steps from this plan as a JSON array. The plan follows a three-phase structure — preserve ALL phases in the output.

CRITICAL RULES:
- You MUST extract steps from ALL phases (Phase 1, Phase 2, AND Phase 3). Do NOT stop at Phase 1.
- If the plan mentions "forge script" anywhere, replace it with "yarn deploy" (or "yarn deploy --network <network>").
- The contract-writing step that creates the main .sol file MUST also write/update Deploy.s.sol in the same step. Bundle them together — never leave Deploy.s.sol out of sync with the contract.
- Every step that writes code files (contracts, deploy scripts, frontend components) must list ALL files it will create/modify.
- Phase 3 MUST include a BGIPFS deployment step with command "yarn ipfs". This is MANDATORY. If the plan says "Vercel" or "yarn vercel:yolo" for production, replace it with "yarn ipfs". BGIPFS is the required production frontend host — never Vercel.

${SE2_COMMAND_RULES}

## Plan
${plan}

## Analysis
${JSON.stringify(analysis, null, 2)}

For each step, output:
{
  "id": "step_number",
  "name": "step name",
  "phase": 1|2|3,
  "stage": "leftclaw pipeline stage if applicable (e.g. create_plan, prototype, contract_audit, deploy_contract, deploy_app) or 'internal'",
  "model": "cheap|medium|expensive",
  "description": "what this step does",
  "command": "exact shell command if applicable, or null",
  "contextNeeded": ["list of files or data this step needs"],
  "expectedOutput": "what this step produces",
  "validationGate": "how to confirm this step succeeded before moving to the next",
  "dependencies": ["ids of steps that must complete first"]
}

Output ONLY a valid JSON array. No markdown fences.`;

  const result = await medium(
    'Extract build steps as a JSON array from ALL phases. You MUST include Phase 2 and Phase 3 steps. Output ONLY valid JSON.',
    prompt,
    { role: 'step-extractor', maxTokens: 8192 }
  );

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // Try to salvage truncated JSON — find the last complete object in the array
    try {
      const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace > 0) {
        const truncated = cleaned.slice(0, lastBrace + 1) + ']';
        const parsed = JSON.parse(truncated);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
          logDecision('step-extractor', 'parse_salvaged', `Salvaged ${parsed.length} steps from truncated JSON`);
          return parsed;
        }
      }
    } catch { /* salvage failed too */ }

    logDecision('step-extractor', 'parse_failed', 'Could not parse steps JSON');
    return [];
  }
}
