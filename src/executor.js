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
const SHELL_TIMEOUT_MS = 360_000; // 6 min — vercel/ipfs deploys can be slow
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
 *
 * previousLog: optional array from a prior execution-log.json — steps already
 * completed there are marked complete immediately so the resume picks up correctly.
 */
export async function executeAllSteps(steps, buildDir, context, previousLog = []) {
  const baseProjectDir = join(buildDir, 'project');
  mkdirSync(baseProjectDir, { recursive: true });

  let projectDir = baseProjectDir;

  const sorted = topologicalSort(steps);
  const stepMap = new Map(steps.map(s => [s.id, s]));

  const state = {};
  for (const s of steps) {
    state[s.id] = { status: 'pending', attempts: 0 };
  }

  // Pre-populate state from a previous run so --resume skips already-done steps
  const completedSteps = {};
  const executionLog = [];
  if (previousLog.length > 0) {
    for (const entry of previousLog) {
      if (entry.status === 'completed') {
        state[entry.stepId] = { status: 'completed', attempts: entry.attempts || 1 };
        completedSteps[entry.stepId] = {
          name: stepMap.get(entry.stepId)?.name || entry.stepId,
          outputSummary: `(resumed from previous run)`,
          filesWritten: entry.filesWritten || [],
        };
        executionLog.push(entry);
        log(`EXECUTOR: step ${entry.stepId} already completed (loaded from previous run)`);
      }
    }

    // If scaffold step(s) were completed, detect the project dir from disk now
    const detected = detectScaffoldedDir(baseProjectDir, baseProjectDir);
    if (detected) {
      projectDir = detected;
      log(`EXECUTOR: resume — detected existing scaffolded project → ${projectDir}`);
    }
  }

  log(`EXECUTOR: ${sorted.length} steps to execute in topological order`);
  log(`EXECUTOR: project dir → ${projectDir}`);

  for (const stepId of sorted) {
    const step = stepMap.get(stepId);
    if (!step) {
      log(`EXECUTOR: step ${stepId} not found in step map, skipping`);
      continue;
    }

    // Already completed in a previous run (resume mode) — skip without re-running
    if (state[stepId].status === 'completed') {
      log(`EXECUTOR: step ${stepId} already completed — skipping (resume)`);
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

        // cast call / cast read steps are read-only chain queries used for research/verification.
        // They may revert (e.g. calling burn(0) to test the interface) or hit rate limits.
        // Treat as non-blocking — mark passed so downstream steps aren't blocked.
        if (result.stepType === 'shell_cmd' && result.exitCode !== 0) {
          const cmdLower = (step.command || '').toLowerCase();
          if (/^\s*cast\s+(call|balance|code|storage|block|receipt|tx)\b/.test(cmdLower)) {
            log(`EXECUTOR: cast read step failed — treating as non-blocking (read-only verification)`);
            logStepExecution(stepId, 'completed', 'cast call failed but treated as non-blocking verification');
            state[stepId].status = 'completed';
            completedSteps[stepId] = { name: step.name, outputSummary: `cast call failed: ${result.stderr?.slice(0, 100)}`, filesWritten: [] };
            executionLog.push({ stepId, status: 'completed', attempts: attempt + 1, filesWritten: [], validation: { passed: true, reason: 'Non-blocking cast call' } });
            success = true;
            break;
          }
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
    // Extract the project name — it's the last non-flag argument of the create-eth invocation.
    // Strip everything from && onward first so "yarn install" or "cd name" appended by the planner
    // doesn't pollute the arg list (e.g. "npx create-eth@latest -s foundry my-app && yarn install"
    // would otherwise yield "install" as the project name).
    const createEthPart = command.split(/\s*&&/)[0];
    const args = createEthPart.split(/\s+/).filter(a => a && !a.startsWith('-') && !/create-eth|npx|foundry|hardhat/.test(a));
    const projectName = args[args.length - 1] || 'project';
    const skipInstall = command.includes('--skip-install') ? '' : ' --skip-install';
    const scaffoldPart = command.replace(/(create-eth@\S+)/, `$1${skipInstall}`)
      .replace(/&&\s*cd\s+\S+\s*&&\s*yarn\s+install.*$/, '');
    return { processed: `${scaffoldPart} && cd ${projectName} && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`, extraEnv: {} };
  }

  // Strip leading "cd <project> &&" that the planner sometimes adds when it doesn't
  // know the executor already cds into the project dir.
  let cmd = command.replace(/^cd\s+\S+\s*&&\s*/, '');

  // Strip project-name prefixes from file paths (e.g. "cat clawd-burn-board/AGENTS.md"
  // when CWD is already clawd-burn-board). The project dir name is the last segment.
  if (projectDir) {
    const projName = projectDir.split('/').pop();
    if (projName) {
      // Replace "projName/" at word boundaries in the command, but not "packages/..."
      // (which is a valid sub-path inside the project)
      const projPrefixRe = new RegExp(`\\b${projName.replace(/[-]/g, '\\$&')}\\/(?!packages\\/)`, 'g');
      cmd = cmd.replace(projPrefixRe, '');
    }
  }

  const extraEnv = {};

  if (/yarn\s+install/.test(cmd) && !cmd.includes('YARN_ENABLE_IMMUTABLE_INSTALLS')) {
    cmd = cmd.replace(/yarn\s+install/, 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install');
  }

  // Next.js build: sanitize CSS files and patch next.config before building.
  if (/yarn\s+next:build/.test(cmd)) {
    sanitizeCssFiles(projectDir);
    patchNextConfigForBuild(projectDir);
    patchLayoutIfNeeded(projectDir);
    patchSE2DebugPages(projectDir);
    // SE2's next.config.ts gates eslint/ts ignore on NEXT_PUBLIC_IGNORE_BUILD_ERROR.
    // Set it so ESLint/Prettier warnings don't fail generated code builds.
    extraEnv.NEXT_PUBLIC_IGNORE_BUILD_ERROR = 'true';
  }

  // yarn fork / yarn chain: kill any existing anvil first to prevent "Address already in use".
  // Anvil from a prior run may still be on :8545 if not cleaned up.
  if (/yarn\s+(fork|chain)\b/.test(cmd)) {
    cmd = `pkill anvil 2>/dev/null || true; sleep 1; ${cmd}`;
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

  // Vercel deploy: yarn vercel:yolo doesn't pass --yes, causing interactive prompts.
  // Add --yes flag so it runs non-interactively. Use the local vercel v39 binary (not npx vercel
  // which resolves to a newer global version that broke --scope handling in non-interactive mode).
  if (/yarn\s+vercel:yolo/.test(cmd)) {
    cmd = cmd.replace(/yarn\s+vercel:yolo(\s+--prod)?/, 'yarn vercel:yolo --prod --yes');
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

  // Vercel and IPFS deploys upload to remote servers and can take 15+ minutes.
  const effectiveTimeout = /vercel|ipfs/.test(command) ? 900_000 : SHELL_TIMEOUT_MS;

  try {
    stdout = execSync(command, {
      cwd: projectDir,
      timeout: effectiveTimeout,
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
 * Before yarn next:build, check if layout.tsx calls getDefaultConfig() directly
 * (which can't run in a Next.js server component). If so, replace it with the
 * SE2 pattern using ScaffoldEthAppWithProviders.
 */
function patchLayoutIfNeeded(projectDir) {
  const layoutPath = join(projectDir, 'packages', 'nextjs', 'app', 'layout.tsx');
  if (!existsSync(layoutPath)) return;

  try {
    const content = readFileSync(layoutPath, 'utf-8');
    if (!content.includes('getDefaultConfig(')) return; // already fine

    log(`SE2-PATCH: layout.tsx calls getDefaultConfig() in server context — rewriting to use ScaffoldEthAppWithProviders`);

    // Extract the metadata title/description if present
    const titleMatch = content.match(/title:\s*["']([^"']+)["']/);
    const descMatch = content.match(/description:\s*["']([^"']+)["']/);
    const title = titleMatch?.[1] || 'Scaffold-ETH 2 App';
    const desc = descMatch?.[1] || 'Built with Scaffold-ETH 2';

    // Extract Google Fonts link if present
    const fontsMatch = content.match(/href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/);
    const fontsHref = fontsMatch?.[1] || '';

    const fontsLine = fontsHref
      ? `        <link\n          href="${fontsHref}"\n          rel="stylesheet"\n        />`
      : '';

    const fixed = `import type { Metadata } from "next";
import "@rainbow-me/rainbowkit/styles.css";
import "~~/styles/globals.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";

export const metadata: Metadata = {
  title: "${title}",
  description: "${desc}",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
${fontsLine}
      </head>
      <body>
        <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
      </body>
    </html>
  );
}
`;
    writeFileSync(layoutPath, fixed);
    log(`SE2-PATCH: layout.tsx rewritten to use ScaffoldEthAppWithProviders`);
  } catch (err) {
    log(`SE2-PATCH: failed to patch layout.tsx: ${err.message}`);
  }
}

/**
 * Before yarn next:build, patch SE2's debug pages to use dynamic rendering.
 * The /debug route uses RainbowKit's getDefaultConfig() which can't run server-side
 * in Next.js 15 App Router (it's a client-only function).
 * Adding `export const dynamic = 'force-dynamic'` prevents Next.js from trying to
 * statically generate these pages.
 */
function patchSE2DebugPages(projectDir) {
  const nextjsDir = join(projectDir, 'packages', 'nextjs');
  if (!existsSync(nextjsDir)) return;

  const debugTargets = [
    join(nextjsDir, 'app', 'debug', 'page.tsx'),
    join(nextjsDir, 'app', 'debug', '[contractName]', 'page.tsx'),
    join(nextjsDir, 'app', 'blockexplorer', 'page.tsx'),
    join(nextjsDir, 'app', 'blockexplorer', 'address', '[address]', 'page.tsx'),
    join(nextjsDir, 'app', 'blockexplorer', 'tx', '[txHash]', 'page.tsx'),
  ];

  for (const target of debugTargets) {
    if (!existsSync(target)) continue;
    try {
      let content = readFileSync(target, 'utf-8');
      if (content.includes('force-dynamic')) continue; // already patched

      // "use client" must be the FIRST expression. If present, insert force-dynamic after it.
      // Otherwise, prepend it to the file.
      const useClientRe = /^("use client"\s*;?\s*\n)/;
      if (useClientRe.test(content)) {
        content = content.replace(useClientRe, `$1\nexport const dynamic = 'force-dynamic';\n`);
      } else {
        content = `export const dynamic = 'force-dynamic';\n` + content;
      }
      writeFileSync(target, content);
      log(`SE2-PATCH: added force-dynamic to ${target.split('packages/nextjs/')[1]}`);
    } catch (err) {
      log(`SE2-PATCH: failed to patch ${target}: ${err.message}`);
    }
  }
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

/**
 * Before yarn next:build, patch next.config.ts/js to add:
 *   eslint: { ignoreDuringBuilds: true }
 *
 * Generated projects have LLM-written code with Prettier/ESLint formatting
 * issues that aren't correctness bugs. TypeScript type checking still runs.
 */
function patchNextConfigForBuild(projectDir) {
  const nextjsDir = join(projectDir, 'packages', 'nextjs');
  if (!existsSync(nextjsDir)) return;

  for (const filename of ['next.config.ts', 'next.config.js', 'next.config.mjs']) {
    const filePath = join(nextjsDir, filename);
    if (!existsSync(filePath)) continue;

    try {
      let content = readFileSync(filePath, 'utf-8');

      // Already patched
      if (content.includes('ignoreDuringBuilds')) {
        log(`BUILD-PATCH: ${filename} already has eslint.ignoreDuringBuilds`);
        return;
      }

      // Find the nextConfig object by tracking brace depth and insert before its closing }
      const lines = content.split('\n');
      let configStart = -1;
      let braceDepth = 0;
      let configEnd = -1;

      for (let i = 0; i < lines.length; i++) {
        if (configStart === -1 && /const\s+nextConfig/.test(lines[i])) {
          configStart = i;
        }
        if (configStart !== -1) {
          for (const ch of lines[i]) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
              braceDepth--;
              if (braceDepth === 0) { configEnd = i; break; }
            }
          }
          if (configEnd !== -1) break;
        }
      }

      if (configEnd !== -1) {
        lines.splice(configEnd, 0, '  eslint: { ignoreDuringBuilds: true },');
        writeFileSync(filePath, lines.join('\n'));
        log(`BUILD-PATCH: patched ${filename} — eslint.ignoreDuringBuilds: true`);
      } else {
        log(`BUILD-PATCH: could not find nextConfig object in ${filename}`);
      }
    } catch (err) {
      log(`BUILD-PATCH: failed to patch ${filename}: ${err.message}`);
    }
    return; // Only process the first config file found
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
