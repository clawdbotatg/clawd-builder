import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { cheap } from './llm.js';
import { buildSkillContext } from './skills.js';
import { log, logDecision } from './logger.js';

const MODEL_MAP = {
  cheap: 'minimax-m2.7',
  medium: 'claude-sonnet-4.6',
  expensive: 'claude-opus-4.6',
};

const FORMAT_BLOCK = `

MANDATORY OUTPUT FORMAT — you MUST follow this exactly, no exceptions:

For EACH file you produce, wrap it like this:

=== packages/path/to/file.ext ===
(complete file contents here)
=== END ===

Rules:
- Use the EXACT path shown above (packages/foundry/... or packages/nextjs/...)
- Output ALL files using this format
- Do NOT use markdown code fences (\`\`\`)
- Do NOT add explanations outside the === blocks
- Every file MUST start with === and end with === END ===`;

export function classifyStep(step) {
  const nameLower = (step.name || '').toLowerCase();
  const descLower = (step.description || '').toLowerCase();

  // Pure "cat <file>" commands are documentation reads — treat as read_context so
  // they always pass (the context assembler will supply file content anyway) and
  // never cascade-skip downstream code-gen steps if the file is missing.
  if (step.command && /^cat\s+\S+$/.test(step.command.trim())) return 'read_context';

  if (step.command) return 'shell_cmd';
  if (nameLower.includes('read') || descLower.startsWith('read ')) return 'read_context';
  return 'code_gen';
}

/**
 * Assemble context for a step. For code_gen steps, minimax writes
 * the task instructions, but format enforcement and file context
 * injection are deterministic -- never delegated to any model.
 */
export async function assembleContext(step, {
  projectDir,
  buildDir,
  completedSteps,
  skills,
  plan,
  analysis,
  previousAttemptFeedback,
}) {
  const stepType = classifyStep(step);
  const targetModel = MODEL_MAP[step.model] || MODEL_MAP.medium;

  if (stepType === 'read_context') {
    const fileContext = gatherFileContext(projectDir, step.contextNeeded);
    const summary = Object.entries(fileContext)
      .map(([path, content]) => `### ${path}\n${content}`)
      .join('\n\n');
    return {
      systemPrompt: null,
      userPrompt: null,
      targetModel,
      stepType,
      gatheredContext: summary || '(no files found yet)',
    };
  }

  if (stepType === 'shell_cmd') {
    return {
      systemPrompt: null,
      userPrompt: null,
      targetModel,
      stepType,
      command: step.command,
    };
  }

  // --- code_gen: build the prompt in three deterministic layers ---

  // Layer 1: Gather all file context
  const fileContext = gatherFileContext(projectDir, step.contextNeeded);
  const depFileContents = gatherDependencyFileContents(step, completedSteps, projectDir);
  const se2Templates = gatherSE2Templates(step, projectDir);

  // Layer 2: Minimax writes ONLY the task-specific instructions
  const taskInstructions = await buildTaskInstructions(step, {
    skills, plan, analysis, previousAttemptFeedback,
  });

  // Layer 3: Assemble final prompt with hardcoded format block
  const systemPrompt = buildSystemPrompt(step);
  const userPrompt = buildUserPrompt(step, {
    taskInstructions,
    fileContext,
    depFileContents,
    se2Templates,
    previousAttemptFeedback,
  });

  // Hard cap: truncate user prompt if too large for the API
  const MAX_PROMPT = 30000;
  const finalUserPrompt = userPrompt.length > MAX_PROMPT
    ? userPrompt.slice(0, MAX_PROMPT) + '\n\n[... context truncated to fit API limits]\n' + FORMAT_BLOCK
    : userPrompt;

  logDecision('context-assembler', 'prompt_prepared',
    `Step ${step.id} "${step.name}" → ${targetModel} (system=${systemPrompt.length}ch, user=${finalUserPrompt.length}ch)`);

  return { systemPrompt, userPrompt: finalUserPrompt, targetModel, stepType };
}

function buildSystemPrompt(step) {
  const isSolidity = step.description?.toLowerCase().includes('contract')
    || step.description?.toLowerCase().includes('.sol')
    || step.stage === 'contract_audit';
  const isTest = step.name?.toLowerCase().includes('test');
  const isDeploy = step.stage === 'deploy_contract'
    || step.name?.toLowerCase().includes('deploy');
  const isFrontend = step.description?.toLowerCase().includes('frontend')
    || step.description?.toLowerCase().includes('component')
    || step.description?.toLowerCase().includes('page');

  if (isSolidity && isTest) {
    return 'You are a senior Solidity test engineer. Write Foundry tests that EXACTLY match the contract interface provided. Use the exact function names, parameter types, and event names from the contract. Import from forge-std/Test.sol.';
  }
  if (isDeploy) {
    return 'You are a Scaffold-ETH 2 deploy script writer. You MUST follow the exact SE2 deploy pattern shown in the template. Inherit ScaffoldETHDeploy, use the ScaffoldEthDeployerRunner modifier.';
  }
  if (isSolidity) {
    return 'You are a senior Solidity developer. Write production-quality smart contracts following Checks-Effects-Interactions, with NatSpec comments and proper events. Use Solidity ^0.8.19.';
  }
  if (isFrontend) {
    return 'You are a senior React/Next.js developer building a Scaffold-ETH 2 frontend. Use SE2 hooks (useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory) — never raw wagmi hooks. Follow the project conventions exactly.';
  }
  return 'You are a senior developer building a Scaffold-ETH 2 dApp. Follow SE2 conventions exactly.';
}

function buildUserPrompt(step, {
  taskInstructions,
  fileContext,
  depFileContents,
  se2Templates,
  previousAttemptFeedback,
}) {
  const parts = [];

  parts.push(`## Task: ${step.name}\n${step.description}`);
  parts.push(`Expected output: ${step.expectedOutput}`);

  if (previousAttemptFeedback) {
    parts.push(`## PREVIOUS ATTEMPT FAILED\n${previousAttemptFeedback}\nYou MUST fix the issues described above.`);
  }

  if (taskInstructions) {
    parts.push(`## Instructions\n${taskInstructions}`);
  }

  if (depFileContents) {
    parts.push(`## Dependency Files (match these interfaces EXACTLY)\n${depFileContents}`);
  }

  if (se2Templates) {
    parts.push(`## SE2 Template (follow this pattern EXACTLY)\n${se2Templates}`);
  }

  const fileContextStr = Object.entries(fileContext);
  if (fileContextStr.length > 0) {
    const ctx = fileContextStr
      .map(([path, content]) => `### ${path}\n${content}`)
      .join('\n\n');
    parts.push(`## Existing Project Files\n${ctx}`);
  }

  parts.push(FORMAT_BLOCK);

  return parts.join('\n\n');
}

/**
 * Use minimax to write task-specific instructions. This is the ONLY
 * part of the prompt that comes from an LLM. Everything else is
 * deterministic.
 */
async function buildTaskInstructions(step, { skills, plan, analysis, previousAttemptFeedback }) {
  const skillKeys = [];
  if (step.description?.toLowerCase().includes('contract') || step.stage === 'contract_audit') {
    skillKeys.push('ethskills-security', 'ethskills-standards');
  }
  if (step.description?.toLowerCase().includes('frontend') || step.description?.toLowerCase().includes('component')) {
    skillKeys.push('ethskills-frontend-ux', 'ethskills-frontend-playbook');
  }
  skillKeys.push('scaffold-eth', 'scaffold-eth-agents');
  // High cap — these docs are the source of truth and must not be truncated
  const skillContext = skills ? buildSkillContext(skills, skillKeys, 10000) : '';

  const planExcerpt = extractPlanSection(plan, step);

  const prompt = `Write concise build instructions for this step. Focus on WHAT to build and CONSTRAINTS to follow. Do NOT include file format instructions.

Step: ${step.name}
Description: ${step.description}
Expected: ${step.expectedOutput}
${previousAttemptFeedback ? `\nPrevious attempt failed: ${previousAttemptFeedback}` : ''}

Plan context:
${planExcerpt}

Conventions:
${skillContext || '(none)'}

Write 5-15 lines of specific instructions. No boilerplate.`;

  try {
    const result = await cheap(
      'Write concise build instructions. No file format instructions. No filler.',
      prompt,
      { role: 'context-assembler', maxTokens: 1500 }
    );
    return result;
  } catch (err) {
    log(`CONTEXT-ASSEMBLER: minimax failed, proceeding with step description only: ${err.message}`);
    return step.description;
  }
}

/**
 * Read actual file contents from dependency steps' outputs.
 * This is the critical fix: step 1.4 (tests) must see step 1.3's
 * GuestBook.sol contents to write tests that match the real interface.
 */
function gatherDependencyFileContents(step, completedSteps, projectDir) {
  const parts = [];
  let totalChars = 0;
  const MAX_TOTAL = 20000;
  const MAX_PER_FILE = 8000;

  for (const depId of (step.dependencies || [])) {
    const dep = completedSteps[depId];
    if (!dep) continue;

    for (const fileInfo of (dep.filesWritten || [])) {
      if (totalChars >= MAX_TOTAL) break;
      const relPath = fileInfo.relativePath || fileInfo;
      const absPath = join(projectDir, relPath);
      if (!existsSync(absPath)) continue;

      try {
        const content = readFileSync(absPath, 'utf-8');
        const truncated = content.length > MAX_PER_FILE
          ? content.slice(0, MAX_PER_FILE) + '\n[... truncated]'
          : content;
        parts.push(`### ${relPath} (from step ${depId})\n${truncated}`);
        totalChars += truncated.length;
      } catch { /* skip */ }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * For deploy-related steps, inject the SE2 DeployYourContract.s.sol
 * template so the model copies the exact pattern.
 */
function gatherSE2Templates(step, projectDir) {
  const isDeploy = step.stage === 'deploy_contract'
    || step.name?.toLowerCase().includes('deploy script');

  if (isDeploy) {
    const templatePath = join(projectDir, 'packages/foundry/script/DeployYourContract.s.sol');
    const helpersPath = join(projectDir, 'packages/foundry/script/DeployHelpers.s.sol');
    const parts = [];

    if (existsSync(templatePath)) {
      parts.push(`### DeployYourContract.s.sol (COPY THIS PATTERN)\n${readFileSync(templatePath, 'utf-8')}`);
    }
    if (existsSync(helpersPath)) {
      const helpers = readFileSync(helpersPath, 'utf-8');
      parts.push(`### DeployHelpers.s.sol (base contract — DO NOT MODIFY)\n${helpers.slice(0, 4000)}`);
    }

    if (parts.length > 0) return parts.join('\n\n');
  }

  // For test steps, inject the existing test template if available
  const isTest = step.name?.toLowerCase().includes('test');
  if (isTest) {
    const templatePath = join(projectDir, 'packages/foundry/test/YourContract.t.sol');
    if (existsSync(templatePath)) {
      return `### YourContract.t.sol (SE2 test template)\n${readFileSync(templatePath, 'utf-8')}`;
    }
  }

  return null;
}

function gatherFileContext(projectDir, contextNeeded) {
  const gathered = {};
  if (!contextNeeded || !existsSync(projectDir)) return gathered;

  for (const needed of contextNeeded) {
    const fullPath = join(projectDir, needed);
    if (!existsSync(fullPath)) continue;

    const stat = statSync(fullPath);
    if (stat.isFile()) {
      const content = readFileSync(fullPath, 'utf-8');
      gathered[needed] = content.length > 8000
        ? content.slice(0, 8000) + '\n[... truncated]'
        : content;
    } else if (stat.isDirectory()) {
      try {
        // Shallow read only -- no recursive enumeration (avoids OOM on node_modules)
        const entries = readdirSync(fullPath)
          .filter(f => !f.startsWith('.') && f !== 'node_modules' && f !== '.next' && f !== 'out');
        const files = [];
        for (const entry of entries.slice(0, 20)) {
          const fp = join(fullPath, entry);
          try {
            if (statSync(fp).isFile()) files.push(entry);
          } catch { /* skip */ }
        }
        gathered[needed + '/'] = `Directory listing (top-level):\n${entries.join('\n')}`;
        for (const f of files.slice(0, 3)) {
          const fp = join(fullPath, f);
          const content = readFileSync(fp, 'utf-8');
          const relPath = relative(projectDir, fp);
          gathered[relPath] = content.length > 4000
            ? content.slice(0, 4000) + '\n[... truncated]'
            : content;
        }
      } catch { /* skip */ }
    }
  }
  return gathered;
}

function extractPlanSection(plan, step) {
  if (!plan) return '(no plan)';
  const lines = plan.split('\n');
  const relevant = [];
  let capturing = false;
  const phaseName = `Phase ${step.phase}`;
  const stepNameLower = step.name.toLowerCase();

  for (const line of lines) {
    if (line.includes(phaseName) || line.toLowerCase().includes(stepNameLower)) {
      capturing = true;
    }
    if (capturing) {
      relevant.push(line);
      if (relevant.length > 40) break;
      if (relevant.length > 5 && line.startsWith('###') && !line.includes(phaseName) && !line.toLowerCase().includes(stepNameLower)) {
        break;
      }
    }
  }
  return relevant.length > 0
    ? relevant.join('\n').slice(0, 2000)
    : plan.slice(0, 1500);
}
