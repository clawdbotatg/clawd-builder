import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { cheap, medium, expensive } from './llm.js';
import { log, logStepExecution } from './logger.js';
import { assembleContext, classifyStep } from './context-assembler.js';
import { writeFilesFromOutput } from './file-writer.js';
import { validateStep } from './step-validator.js';
import { fixCodeFromError } from './fixer.js';

const MAX_RETRIES = 2;
const SHELL_TIMEOUT_MS = 180_000;
const LONG_RUNNING_PATTERNS = /\byarn\s+(chain|fork|start|dev|serve|watch)\b/i;
const BACKGROUND_READY_TIMEOUT_MS = 30_000;

const backgroundProcesses = [];

function cleanupBackgroundProcesses() {
  for (const proc of backgroundProcesses) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      log(`EXECUTOR: killed background process ${proc.pid} (${proc.label})`);
    } catch { /* already dead */ }
  }
  backgroundProcesses.length = 0;
}

process.on('exit', cleanupBackgroundProcesses);
process.on('SIGINT', () => { cleanupBackgroundProcesses(); process.exit(1); });
process.on('SIGTERM', () => { cleanupBackgroundProcesses(); process.exit(1); });

/**
 * Execute all steps from steps.json in topological order.
 *
 * After the first shell step that scaffolds a project (creates a new subdirectory),
 * all subsequent steps use that subdirectory as the effective project root.
 */
export async function executeAllSteps(steps, buildDir, context) {
  const baseProjectDir = join(buildDir, 'project');
  mkdirSync(baseProjectDir, { recursive: true });

  let projectDir = baseProjectDir;

  const sorted = topologicalSort(steps);
  const stepMap = new Map(steps.map(s => [s.id, s]));

  const state = {};
  for (const s of steps) {
    state[s.id] = { status: 'pending', attempts: 0 };
  }

  const completedSteps = {};
  const executionLog = [];

  log(`EXECUTOR: ${sorted.length} steps to execute in topological order`);
  log(`EXECUTOR: project dir → ${projectDir}`);

  for (const stepId of sorted) {
    const step = stepMap.get(stepId);
    if (!step) {
      log(`EXECUTOR: step ${stepId} not found in step map, skipping`);
      continue;
    }

    const depsOk = (step.dependencies || []).every(d => state[d]?.status === 'completed');
    if (!depsOk) {
      const missing = (step.dependencies || []).filter(d => state[d]?.status !== 'completed');
      logStepExecution(stepId, 'skipped', `Dependencies not met: ${missing.join(', ')}`);
      state[stepId].status = 'skipped';
      executionLog.push({ stepId, status: 'skipped', reason: `Unmet deps: ${missing.join(', ')}` });
      continue;
    }

    state[stepId].status = 'running';
    logStepExecution(stepId, 'started', `"${step.name}" (${step.model})`);

    let lastFeedback = null;
    let success = false;
    const stepType = classifyStep(step);

    // Snapshot project dir contents before shell steps so we can clean up on retry
    const dirSnapshotBefore = stepType === 'shell_cmd'
      ? snapshotDir(projectDir) : null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      state[stepId].attempts = attempt + 1;
      if (attempt > 0) {
        logStepExecution(stepId, 'retry', `Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${lastFeedback?.slice(0, 100)}`);
        if (dirSnapshotBefore) {
          cleanupNewDirs(projectDir, dirSnapshotBefore);
        }
      }

      try {
        const result = await executeStep(step, {
          projectDir,
          buildDir,
          completedSteps,
          skills: context.skills,
          plan: context.plan,
          analysis: context.analysis,
          previousAttemptFeedback: lastFeedback,
        });

        // After a scaffold-like shell step, detect the new project root
        if (result.stepType === 'shell_cmd' && result.exitCode === 0) {
          const detected = detectScaffoldedDir(baseProjectDir, projectDir);
          if (detected) {
            projectDir = detected;
            log(`EXECUTOR: detected scaffolded project → ${projectDir}`);
          }
        }

        const validation = await validateStep(step, result, projectDir);

        if (validation.passed) {
          state[stepId].status = 'completed';
          completedSteps[stepId] = {
            name: step.name,
            outputSummary: result.outputSummary || '',
            filesWritten: result.filesWritten || [],
          };
          logStepExecution(stepId, 'completed', validation.reason);
          executionLog.push({
            stepId,
            status: 'completed',
            attempts: attempt + 1,
            filesWritten: (result.filesWritten || []).map(f => f.relativePath),
            validation,
          });
          success = true;
          break;
        }

        // Shell step failed -- try auto-fixes before retrying
        if (result.stepType === 'shell_cmd' && result.exitCode !== 0) {
          const errorText = result.stderr || result.stdout || '';

          // Auto-start local fork when yarn deploy fails because no chain is running
          const noChain = /Connection refused.*8545|error sending request.*8545|ECONNREFUSED.*8545/i.test(errorText);
          const isLocalDeploy = /yarn\s+deploy(?!\s+--network\s+(?!localhost))/i.test(step.command || '');
          if (noChain && isLocalDeploy && attempt === 0) {
            log(`EXECUTOR: no local chain detected — auto-starting yarn fork --network base`);
            try {
              await executeLongRunningCmd(
                { id: `${step.id}-fork`, name: 'auto-fork' },
                'yarn fork --network base',
                projectDir,
                buildDir,
                {}
              );
              logStepExecution(stepId, 'fixing', 'Started yarn fork --network base — retrying deploy');
              lastFeedback = 'Started local fork. Retrying deploy.';
              continue;
            } catch (forkErr) {
              log(`EXECUTOR: auto-fork failed: ${forkErr.message?.slice(0, 200)}`);
            }
          }

          // Auto-install missing npm packages (e.g. "Module not found: Can't resolve '@fontsource/...'")
          const missingPkg = errorText.match(/Module not found:.*Can't resolve '([^']+)'/);
          if (missingPkg) {
            const pkg = missingPkg[1].startsWith('@')
              ? missingPkg[1].split('/').slice(0, 2).join('/')
              : missingPkg[1].split('/')[0];
            log(`EXECUTOR: auto-installing missing package: ${pkg}`);
            try {
              execSync(`yarn add ${pkg}`, {
                cwd: projectDir,
                timeout: 60000,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              logStepExecution(stepId, 'fixing', `Installed missing package ${pkg} — retrying`);
              lastFeedback = `Installed ${pkg}. Retrying.`;
              continue;
            } catch (installErr) {
              log(`EXECUTOR: failed to install ${pkg}: ${installErr.message?.slice(0, 200)}`);
            }
          }

          const fixes = await fixCodeFromError(errorText, projectDir, step, context);
          if (fixes && fixes.some(f => f.fixed)) {
            const fixedFiles = fixes.filter(f => f.fixed).map(f => f.path).join(', ');
            logStepExecution(stepId, 'fixing', `Fixed ${fixedFiles} — retrying command`);
            lastFeedback = `Fixed files: ${fixedFiles}. Retrying.`;
            continue;
          }
        }

        lastFeedback = `${validation.reason}. Suggestions: ${validation.suggestions.join('; ')}`;
      } catch (err) {
        lastFeedback = `Error: ${err.message}`;
        logStepExecution(stepId, 'error', `Attempt ${attempt + 1}: ${err.message.slice(0, 200)}`);
      }
    }

    if (!success) {
      state[stepId].status = 'failed';
      logStepExecution(stepId, 'failed', `After ${state[stepId].attempts} attempts: ${lastFeedback?.slice(0, 200)}`);
      executionLog.push({
        stepId,
        status: 'failed',
        attempts: state[stepId].attempts,
        lastFeedback,
      });
    }

    writeFileSync(join(buildDir, 'execution-log.json'), JSON.stringify(executionLog, null, 2));
  }

  cleanupBackgroundProcesses();

  const summary = summarizeExecution(state);
  log(`EXECUTOR: ${summary}`);

  return { completedSteps, state, executionLog };
}

/**
 * After a shell command runs in baseProjectDir, check if a single new
 * subdirectory appeared that looks like a scaffolded project (has package.json).
 * If projectDir hasn't been updated yet (still equals baseProjectDir), return it.
 */
function detectScaffoldedDir(baseProjectDir, currentProjectDir) {
  if (currentProjectDir !== baseProjectDir) return null;

  try {
    const entries = readdirSync(baseProjectDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    for (const entry of entries) {
      const candidate = join(baseProjectDir, entry.name);
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function executeStep(step, assemblyContext) {
  const assembled = await assembleContext(step, assemblyContext);
  const { stepType } = assembled;

  if (stepType === 'read_context') {
    return executeReadContext(step, assembled, assemblyContext);
  }

  if (stepType === 'shell_cmd') {
    return executeShellCmd(step, assembled, assemblyContext);
  }

  return executeCodeGen(step, assembled, assemblyContext);
}

async function executeReadContext(step, assembled, ctx) {
  const { gatheredContext } = assembled;

  const contextFile = `step-${step.id}-context.md`;
  writeFileSync(join(ctx.buildDir, contextFile), gatheredContext);

  return {
    stepType: 'read_context',
    outputSummary: `Read context: ${gatheredContext.length} chars gathered`,
    filesWritten: [],
  };
}

async function executeShellCmd(step, assembled, ctx) {
  const { processed, extraEnv } = preprocessCommand(assembled.command, ctx.projectDir);
  const { projectDir, buildDir } = ctx;

  // Split "&&" chains where the first command is long-running (e.g. "yarn chain && yarn deploy").
  // Start the long-running part as background, wait for readiness, then run the rest blocking.
  const parts = processed.split(/\s*&&\s*/);
  if (parts.length > 1 && LONG_RUNNING_PATTERNS.test(parts[0])) {
    const bgCmd = parts[0];
    const restCmd = parts.slice(1).join(' && ');

    log(`EXECUTOR: splitting command — background: "${bgCmd}", then blocking: "${restCmd}"`);

    const bgResult = await executeLongRunningCmd(step, bgCmd, projectDir, buildDir, extraEnv);
    if (bgResult.exitCode !== 0) return bgResult;

    return executeBlockingCmd(step, restCmd, projectDir, buildDir, extraEnv);
  }

  if (LONG_RUNNING_PATTERNS.test(processed)) {
    return executeLongRunningCmd(step, processed, projectDir, buildDir, extraEnv);
  }

  return executeBlockingCmd(step, processed, projectDir, buildDir, extraEnv);
}

/**
 * Transform known problematic commands before execution.
 * - create-eth: add --skip-install, then install with immutable installs disabled
 * - Strip redundant `cd <project>` prefixes (projectDir is already set)
 * - yarn install: disable immutable installs
 *
 * NOTE: Never run `forge script` directly. Deployment must go through
 * `yarn deploy` (or `yarn deploy --network <network>`) which handles
 * key management, ABI generation, and everything else via SE-2's scripts.
 */
function preprocessCommand(command, projectDir) {
  if (/forge\s+script/.test(command)) {
    throw new Error(
      `FORBIDDEN: "forge script" must not be called directly. Use "yarn deploy" or "yarn deploy --network <network>" instead. ` +
      `SE-2's yarn deploy handles key management, ABI generation, and deployment correctly.`
    );
  }

  if (/create-eth/.test(command)) {
    // Extract the project name — it's the last non-flag argument.
    // Handles hyphens (burn-board), flags (-s foundry), and --skip-install.
    const args = command.split(/\s+/).filter(a => a && !a.startsWith('-') && !/create-eth|npx|foundry|hardhat/.test(a));
    const projectName = args[args.length - 1] || 'project';
    const skipInstall = command.includes('--skip-install') ? '' : ' --skip-install';
    const scaffoldPart = command.replace(/(create-eth@\S+)/, `$1${skipInstall}`)
      .replace(/&&\s*cd\s+\S+\s*&&\s*yarn\s+install.*$/, '');
    return { processed: `${scaffoldPart} && cd ${projectName} && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`, extraEnv: {} };
  }

  let cmd = command.replace(/^cd\s+\S+\s*&&\s*/, '');
  const extraEnv = {};

  if (/yarn\s+install/.test(cmd) && !cmd.includes('YARN_ENABLE_IMMUTABLE_INSTALLS')) {
    cmd = cmd.replace(/yarn\s+install/, 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install');
  }

  // Next.js build: sanitize CSS files before building to prevent Tailwind v4 errors.
  if (/yarn\s+next:build/.test(cmd)) {
    sanitizeCssFiles(projectDir);
  }

  // Next.js build: Node 25+ has a broken localStorage that crashes RainbowKit/next-themes at SSG time.
  // Create the polyfill if needed and inject it via NODE_OPTIONS.
  if (/yarn\s+next:build/.test(cmd)) {
    const polyfillPath = join(projectDir, 'packages', 'nextjs', 'polyfill-localstorage.cjs');
    if (!existsSync(polyfillPath)) {
      const polyfillCode = `if(typeof globalThis.localStorage!=="undefined"&&typeof globalThis.localStorage.getItem!=="function"){const s=new Map();globalThis.localStorage={getItem:k=>s.get(k)??null,setItem:(k,v)=>s.set(k,String(v)),removeItem:k=>s.delete(k),clear:()=>s.clear(),key:i=>[...s.keys()][i]??null,get length(){return s.size}};}`;
      writeFileSync(polyfillPath, polyfillCode);
    }
    extraEnv.NODE_OPTIONS = `--require ${polyfillPath}`;
  }

  // Live network deploys: SE-2's Makefile doesn't pass --account/--password to forge for non-localhost.
  // Rewrite to call forge directly from packages/foundry with proper auth, then generate ABIs.
  const liveDeployMatch = cmd.match(/yarn\s+deploy\s+--network\s+((?!localhost)\S+)/);
  if (liveDeployMatch) {
    const network = liveDeployMatch[1];
    const keystoreName = 'agent-deployer';
    const keystorePassword = 'agent';
    cmd = `cd packages/foundry && forge script script/Deploy.s.sol --rpc-url ${network} --account ${keystoreName} --password ${keystorePassword} --broadcast --ffi && node scripts-js/generateTsAbis.js`;
  }

  return { processed: cmd, extraEnv };
}

function executeBlockingCmd(step, command, projectDir, buildDir, extraEnv = {}) {
  log(`EXECUTOR: running command: ${command}`);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(command, {
      cwd: projectDir,
      timeout: SHELL_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME, ...extraEnv },
    });
  } catch (err) {
    exitCode = err.status || 1;
    stdout = err.stdout || '';
    stderr = err.stderr || '';
  }

  const outputFile = `step-${step.id}-shell.log`;
  writeFileSync(join(buildDir, outputFile),
    `$ ${command}\n\nEXIT CODE: ${exitCode}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);

  return {
    stepType: 'shell_cmd',
    exitCode,
    stdout,
    stderr,
    outputSummary: exitCode === 0
      ? `Command succeeded (${stdout.length} chars output)`
      : `Command failed with exit code ${exitCode}`,
    filesWritten: [],
  };
}

/**
 * Spawn a long-running process (e.g. yarn fork, yarn start) in the background.
 * Wait for a readiness signal in stdout/stderr, then return success.
 * The process keeps running; it will be killed when execution finishes.
 */
function executeLongRunningCmd(step, command, projectDir, buildDir, extraEnv = {}) {
  return new Promise((resolve) => {
    log(`EXECUTOR: spawning background process: ${command}`);

    const outputFile = join(buildDir, `step-${step.id}-shell.log`);
    let allOutput = `$ ${command} (background)\n\n`;

    const child = spawn('sh', ['-c', command], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME, ...extraEnv },
    });

    backgroundProcesses.push({ pid: child.pid, label: `step-${step.id}: ${command}` });

    let settled = false;
    const readyPatterns = [
      /listening on/i,
      /ready in/i,
      /compiled successfully/i,
      /running at/i,
      /localhost:\d+/i,
      /block number/i,
      /available accounts/i,
    ];

    function checkReady(data) {
      const text = data.toString();
      allOutput += text;
      if (settled) return;
      if (readyPatterns.some(p => p.test(text))) {
        settled = true;
        writeFileSync(outputFile, allOutput);
        resolve({
          stepType: 'shell_cmd',
          exitCode: 0,
          stdout: allOutput,
          stderr: '',
          outputSummary: `Background process started (pid ${child.pid})`,
          filesWritten: [],
        });
      }
    }

    child.stdout.on('data', checkReady);
    child.stderr.on('data', checkReady);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      allOutput += `\nERROR: ${err.message}\n`;
      writeFileSync(outputFile, allOutput);
      resolve({
        stepType: 'shell_cmd',
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        outputSummary: `Background process failed to start: ${err.message}`,
        filesWritten: [],
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      allOutput += `\nEXIT CODE: ${exitCode}\n`;
      writeFileSync(outputFile, allOutput);
      resolve({
        stepType: 'shell_cmd',
        exitCode,
        stdout: allOutput,
        stderr: '',
        outputSummary: `Process exited with code ${exitCode}`,
        filesWritten: [],
      });
    });

    // Timeout: if no readiness signal after BACKGROUND_READY_TIMEOUT_MS, assume it's running
    setTimeout(() => {
      if (settled) return;
      settled = true;
      writeFileSync(outputFile, allOutput + '\n(timed out waiting for ready signal, assuming running)\n');
      log(`EXECUTOR: background process ${child.pid} -- no ready signal after ${BACKGROUND_READY_TIMEOUT_MS}ms, assuming running`);
      resolve({
        stepType: 'shell_cmd',
        exitCode: 0,
        stdout: allOutput,
        stderr: '',
        outputSummary: `Background process running (pid ${child.pid}, assumed ready after timeout)`,
        filesWritten: [],
      });
    }, BACKGROUND_READY_TIMEOUT_MS);
  });
}

async function executeCodeGen(step, assembled, ctx) {
  const { systemPrompt, userPrompt, targetModel } = assembled;
  const { projectDir, buildDir } = ctx;

  // Contracts (not tests, not deploy scripts) always use opus — they're the most critical code.
  // Test files and deploy scripts use at least sonnet.
  // Everything else respects the assigned model.
  const isContractStep = (
    step.stage === 'contract_audit'
    || step.description?.toLowerCase().includes('contract')
    || step.description?.toLowerCase().includes('.sol')
  ) && !step.name?.toLowerCase().includes('test')
    && !step.name?.toLowerCase().includes('.t.sol')
    && !step.name?.toLowerCase().includes('deploy script');

  const isTestOrDeployStep = step.name?.toLowerCase().includes('test')
    || step.name?.toLowerCase().includes('.t.sol')
    || step.name?.toLowerCase().includes('deploy script');

  const effectiveModel = isContractStep
    ? 'claude-opus-4.6'
    : (isTestOrDeployStep && targetModel === 'minimax-m2.7')
      ? 'claude-sonnet-4.6'
      : targetModel;

  const callFn = pickModelFn(effectiveModel);
  const llmOutput = await callFn(systemPrompt, userPrompt, {
    role: `exec-${step.id}`,
    maxTokens: 8192,
  });

  writeFileSync(join(buildDir, `step-${step.id}-output.md`), llmOutput);

  const filesWritten = writeFilesFromOutput(llmOutput, projectDir);

  // Compile-check: if we wrote any .sol files, run yarn compile immediately
  // and fix compile errors before declaring the step complete.
  if (filesWritten.some(f => f.relativePath.endsWith('.sol'))) {
    await compileCheckSolidity(filesWritten, projectDir, buildDir, step, ctx);
  }

  return {
    stepType: 'code_gen',
    llmOutput,
    filesWritten,
    outputSummary: `Generated ${filesWritten.length} file(s): ${filesWritten.map(f => f.relativePath).join(', ')}`,
  };
}

/**
 * After writing Solidity files, run yarn compile to check compilation.
 * If it fails, use the fixer to repair, up to 3 cycles.
 */
async function compileCheckSolidity(filesWritten, projectDir, buildDir, step, ctx) {
  const COMPILE_RETRIES = 3;

  for (let i = 0; i < COMPILE_RETRIES; i++) {
    try {
      execSync('yarn compile', {
        cwd: projectDir,
        timeout: 60000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      log(`COMPILE-CHECK: step ${step.id} — yarn compile OK`);
      return;
    } catch (err) {
      const stderr = err.stderr || '';
      const stdout = err.stdout || '';
      const errorOutput = stderr + '\n' + stdout;
      log(`COMPILE-CHECK: step ${step.id} — yarn compile FAILED (attempt ${i + 1}/${COMPILE_RETRIES})`);

      if (i < COMPILE_RETRIES - 1) {
        const fixes = await fixCodeFromError(errorOutput, projectDir, step, ctx);
        if (fixes && fixes.some(f => f.fixed)) {
          log(`COMPILE-CHECK: fixed ${fixes.filter(f => f.fixed).map(f => f.path).join(', ')} — rebuilding`);
          continue;
        }
      }
    }
  }
  log(`COMPILE-CHECK: step ${step.id} — yarn compile still failing after ${COMPILE_RETRIES} attempts`);
}

function pickModelFn(targetModel) {
  if (targetModel.includes('opus')) return expensive;
  if (targetModel.includes('sonnet')) return medium;
  return cheap;
}

/**
 * Before running yarn next:build, fix common CSS mistakes that LLMs make with SE2/Tailwind v4:
 *
 * 1. Tailwind v3 directives: replace "@tailwind base/components/utilities" with "@import tailwindcss"
 * 2. DaisyUI @apply: remove @apply with DaisyUI semantic tokens (bg-base-*, text-base-content, etc.)
 *    that cause "Cannot apply unknown utility class" at build time. Replace with CSS variable equivalents.
 *
 * Runs in-place on all .css files under packages/nextjs/
 */
function sanitizeCssFiles(projectDir) {
  const nextjsDir = join(projectDir, 'packages', 'nextjs');
  if (!existsSync(nextjsDir)) return;

  // DaisyUI v4 CSS variable map for @apply replacements
  const DAISY_VAR_MAP = {
    'bg-base-100': 'background-color: oklch(var(--b1))',
    'bg-base-200': 'background-color: oklch(var(--b2))',
    'bg-base-300': 'background-color: oklch(var(--b3))',
    'bg-primary':  'background-color: oklch(var(--p))',
    'bg-secondary': 'background-color: oklch(var(--s))',
    'bg-accent':   'background-color: oklch(var(--a))',
    'bg-neutral':  'background-color: oklch(var(--n))',
    'bg-error':    'background-color: oklch(var(--er))',
    'bg-warning':  'background-color: oklch(var(--wa))',
    'bg-success':  'background-color: oklch(var(--su))',
    'bg-info':     'background-color: oklch(var(--in))',
    'text-base-content': 'color: oklch(var(--bc))',
    'text-primary': 'color: oklch(var(--pc))',
    'text-error':  'color: oklch(var(--erc))',
    'border-base-200': 'border-color: oklch(var(--b2))',
    'border-base-300': 'border-color: oklch(var(--b3))',
  };

  const cssFiles = findCssFiles(nextjsDir);
  for (const filePath of cssFiles) {
    try {
      let content = readFileSync(filePath, 'utf-8');
      let changed = false;

      // Fix 1: replace Tailwind v3 directives with v4 import
      const v3Block = /@tailwind\s+base\s*;\s*\n?\s*@tailwind\s+components\s*;\s*\n?\s*@tailwind\s+utilities\s*;/;
      if (v3Block.test(content)) {
        content = content.replace(v3Block, '@import "tailwindcss";');
        log(`CSS-SANITIZE: replaced Tailwind v3 directives in ${filePath}`);
        changed = true;
      }

      // Fix 2: replace @apply with DaisyUI semantic tokens
      // Handles: @apply bg-base-200 border ...; — remove just the known bad tokens
      for (const [token, replacement] of Object.entries(DAISY_VAR_MAP)) {
        // Remove the token from @apply lines (may have multiple classes)
        const applyRe = new RegExp(`(@apply\\s+[^;]*?)\\b${token}\\b([^;]*;)`, 'g');
        if (applyRe.test(content)) {
          // Reset lastIndex
          applyRe.lastIndex = 0;
          content = content.replace(applyRe, (match, before, after) => {
            const cleaned = (before + after).replace(`@apply  `, '@apply ').replace('@apply ;', '').trim();
            // If @apply is now empty, insert the CSS variable replacement
            if (cleaned === '' || /^@apply\s*;?$/.test(cleaned)) {
              return `${replacement};`;
            }
            return `${replacement};\n  ${cleaned}`;
          });
          log(`CSS-SANITIZE: replaced @apply ${token} in ${filePath}`);
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(filePath, content);
      }
    } catch (err) {
      log(`CSS-SANITIZE: failed to process ${filePath}: ${err.message}`);
    }
  }
}

function findCssFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findCssFiles(full));
      } else if (entry.name.endsWith('.css')) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

/**
 * Topological sort using Kahn's algorithm. Stable: among nodes with
 * equal in-degree, preserves the original array order.
 */
function topologicalSort(steps) {
  const graph = new Map();
  const inDegree = new Map();

  for (const s of steps) {
    graph.set(s.id, []);
    inDegree.set(s.id, 0);
  }

  for (const s of steps) {
    for (const dep of (s.dependencies || [])) {
      if (graph.has(dep)) {
        graph.get(dep).push(s.id);
        inDegree.set(s.id, (inDegree.get(s.id) || 0) + 1);
      }
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const stepOrder = new Map(steps.map((s, i) => [s.id, i]));
  queue.sort((a, b) => (stepOrder.get(a) || 0) - (stepOrder.get(b) || 0));

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const neighbor of graph.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
        queue.sort((a, b) => (stepOrder.get(a) || 0) - (stepOrder.get(b) || 0));
      }
    }
  }

  if (sorted.length !== steps.length) {
    const missing = steps.filter(s => !sorted.includes(s.id)).map(s => s.id);
    log(`EXECUTOR: WARNING - circular dependency detected. Unreachable steps: ${missing.join(', ')}`);
    for (const id of missing) sorted.push(id);
  }

  return sorted;
}

/**
 * Take a snapshot of top-level directory entries in a dir (for retry cleanup).
 */
function snapshotDir(dir) {
  try {
    if (!existsSync(dir)) return new Set();
    return new Set(readdirSync(dir));
  } catch { return new Set(); }
}

/**
 * Remove directories that appeared after the snapshot (created by a failed attempt).
 */
function cleanupNewDirs(dir, snapshotBefore) {
  try {
    const current = readdirSync(dir);
    for (const entry of current) {
      if (!snapshotBefore.has(entry)) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          log(`EXECUTOR: cleaning up directory from failed attempt: ${entry}`);
          rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  } catch { /* ignore cleanup errors */ }
}

function summarizeExecution(state) {
  const counts = { completed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const s of Object.values(state)) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }
  return `Done. completed=${counts.completed} failed=${counts.failed} skipped=${counts.skipped} pending=${counts.pending}`;
}
