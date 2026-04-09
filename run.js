import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { initLogger, log, logStep, writeLLMAudit } from './src/logger.js';
import { getJobOnChain, getJobMessages } from './src/leftclaw.js';
import { fetchAllSkills } from './src/skills.js';
import { analyzeJob } from './src/agents/orchestrator.js';
import { simplePlan, smartPlan, generateSteps } from './src/agents/planner.js';
import { evaluatePlan } from './src/agents/evaluator.js';
import { executeAllSteps } from './src/executor.js';
import { ensureDeployer } from './src/deployer.js';

const DEFAULT_JOB_ID = 39;

function parseArgs() {
  const args = process.argv.slice(2);
  let jobId = DEFAULT_JOB_ID;
  let executeBuildDir = null;
  let resumeBuildDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--job' && args[i + 1]) {
      jobId = parseInt(args[i + 1], 10);
    }
    if (args[i] === '--execute' && args[i + 1]) {
      executeBuildDir = args[i + 1];
    }
    if (args[i] === '--resume' && args[i + 1]) {
      resumeBuildDir = args[i + 1];
    }
  }
  return { jobId, executeBuildDir, resumeBuildDir };
}

function createBuildDir(jobId) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dirName = `job-${jobId}-${ts}`;
  const buildDir = join(process.cwd(), 'builds', dirName);
  mkdirSync(buildDir, { recursive: true });
  return buildDir;
}

function loadJSON(filepath) {
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function loadText(filepath) {
  return readFileSync(filepath, 'utf-8');
}

/**
 * Execute-only mode: skip planning, use existing build artifacts.
 * Usage: node run.js --execute builds/job-39-20260407-001148
 */
async function runExecuteOnly(buildDir) {
  initLogger(buildDir);

  log('=== LeftClaw Builder Agent (execute-only mode) ===');
  log(`Build dir: ${buildDir}`);
  log('');

  const stepsPath = join(buildDir, 'steps.json');
  const planPath = join(buildDir, 'plan.md');
  const analysisPath = join(buildDir, 'analysis.json');
  const jobPath = join(buildDir, 'job.json');
  const messagesPath = join(buildDir, 'messages.json');

  if (!existsSync(stepsPath)) {
    throw new Error(`No steps.json found in ${buildDir}. Run full pipeline first.`);
  }

  const steps = loadJSON(stepsPath);
  const plan = existsSync(planPath) ? loadText(planPath) : '';
  const analysis = existsSync(analysisPath) ? loadJSON(analysisPath) : {};
  const job = existsSync(jobPath) ? loadJSON(jobPath) : {};
  const messages = existsSync(messagesPath) ? loadJSON(messagesPath) : [];

  logStep('load_skills', 'Loading cached skills...');
  const skills = {};
  const skillsDir = join(buildDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const file of readdirSync(skillsDir)) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '');
        skills[name] = readFileSync(join(skillsDir, file), 'utf-8');
      }
    }
  }
  logStep('load_skills', `Loaded ${Object.keys(skills).length} cached skills`);

  log(`Loaded ${steps.length} steps from steps.json`);
  logStep('execute', `Starting step execution (${steps.length} steps)...`);

  const execResult = await executeAllSteps(steps, buildDir, {
    skills,
    plan,
    analysis,
    job,
    messages,
  });

  logStep('execute', `Execution complete. ${Object.keys(execResult.completedSteps).length}/${steps.length} steps succeeded.`);

  writeLLMAudit();

  log('');
  log('=== Execution Complete ===');
  log(`Build dir: ${buildDir}`);
}

/**
 * Check if a pipeline artifact already exists and load it.
 * Returns { exists: true, data } or { exists: false }.
 */
function cached(buildDir, filename) {
  const filepath = join(buildDir, filename);
  if (!existsSync(filepath)) return { exists: false };
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const data = filename.endsWith('.json') ? JSON.parse(raw) : raw;
    return { exists: true, data };
  } catch {
    return { exists: false };
  }
}

/**
 * Load cached skills from a build directory.
 */
function loadCachedSkills(buildDir) {
  const skills = {};
  const skillsDir = join(buildDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const file of readdirSync(skillsDir)) {
      if (file.endsWith('.md')) {
        skills[file.replace('.md', '')] = readFileSync(join(skillsDir, file), 'utf-8');
      }
    }
  }
  return skills;
}

/**
 * Full pipeline: plan + evaluate + execute.
 * Supports --resume to pick up from a previous build directory, skipping steps whose artifacts exist.
 */
async function runFull(resumeDir) {
  const { jobId } = parseArgs();

  const buildDir = resumeDir || createBuildDir(jobId);
  initLogger(buildDir);

  const mode = resumeDir ? 'resume' : 'full';
  log(`=== LeftClaw Builder Agent (${mode} mode) ===`);
  log(`Job ID: ${jobId}`);
  log(`Build dir: ${buildDir}`);
  log('');

  // --- read_job ---
  let job;
  const cachedJob = cached(buildDir, 'job.json');
  if (cachedJob.exists) {
    job = cachedJob.data;
    logStep('read_job', `Cached. Service type: ${job.serviceTypeId}, client: ${job.client}`);
  } else {
    logStep('read_job', 'Fetching job data from Base...');
    job = await getJobOnChain(jobId);
    writeFileSync(join(buildDir, 'job.json'), JSON.stringify(job, null, 2));
    logStep('read_job', `Done. Service type: ${job.serviceTypeId}, client: ${job.client}`);
  }

  // --- read_messages ---
  let messages;
  const cachedMessages = cached(buildDir, 'messages.json');
  if (cachedMessages.exists) {
    messages = cachedMessages.data;
    logStep('read_messages', `Cached. ${messages.length} messages`);
  } else {
    logStep('read_messages', 'Fetching job messages from LeftClaw API...');
    messages = await getJobMessages(jobId);
    writeFileSync(join(buildDir, 'messages.json'), JSON.stringify(messages, null, 2));
    logStep('read_messages', `Done. ${messages.length} messages`);
  }

  // --- fetch_skills ---
  let skills;
  const skillsDir = join(buildDir, 'skills');
  if (existsSync(skillsDir) && readdirSync(skillsDir).filter(f => f.endsWith('.md')).length > 0) {
    skills = {};
    for (const file of readdirSync(skillsDir)) {
      if (file.endsWith('.md')) {
        skills[file.replace('.md', '')] = readFileSync(join(skillsDir, file), 'utf-8');
      }
    }
    logStep('fetch_skills', `Cached. ${Object.keys(skills).length} skills loaded`);
  } else {
    logStep('fetch_skills', 'Fetching SKILL.md files...');
    skills = await fetchAllSkills(buildDir);
    logStep('fetch_skills', `Done. ${Object.keys(skills).length} skills fetched`);
  }

  // --- orchestrate ---
  let analysis;
  const cachedAnalysis = cached(buildDir, 'analysis.json');
  if (cachedAnalysis.exists) {
    analysis = cachedAnalysis.data;
    logStep('orchestrate', `Cached. Summary: ${analysis.summary || 'see analysis.json'}`);
  } else {
    logStep('orchestrate', 'Orchestrator analyzing job...');
    analysis = await analyzeJob(job, messages);
    writeFileSync(join(buildDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
    logStep('orchestrate', `Done. Summary: ${analysis.summary || 'see analysis.json'}`);
  }

  // --- simple_plan ---
  let stepOutline;
  const cachedOutline = cached(buildDir, 'step-outline.md');
  if (cachedOutline.exists) {
    stepOutline = cachedOutline.data;
    logStep('simple_plan', 'Cached. Step outline loaded.');
  } else {
    logStep('simple_plan', 'Simple planner outlining build steps...');
    stepOutline = await simplePlan(job, messages, analysis, skills);
    writeFileSync(join(buildDir, 'step-outline.md'), stepOutline);
    logStep('simple_plan', 'Done. Step outline written.');
  }

  // --- smart_plan ---
  let plan;
  const cachedPlan = cached(buildDir, 'plan.md');
  if (cachedPlan.exists) {
    plan = cachedPlan.data;
    logStep('smart_plan', 'Cached. Detailed plan loaded.');
  } else {
    logStep('smart_plan', 'Smart planner writing detailed build plan...');
    plan = await smartPlan(job, messages, analysis, skills, stepOutline);
    writeFileSync(join(buildDir, 'plan.md'), plan);
    logStep('smart_plan', 'Done. Detailed plan written.');
  }

  // --- extract_steps ---
  let steps;
  const cachedSteps = cached(buildDir, 'steps.json');
  if (cachedSteps.exists) {
    steps = cachedSteps.data;
    logStep('extract_steps', `Cached. ${Array.isArray(steps) ? steps.length : '?'} steps loaded.`);
  } else {
    logStep('extract_steps', 'Extracting executable steps from plan...');
    steps = await generateSteps(plan, analysis);
    writeFileSync(join(buildDir, 'steps.json'), JSON.stringify(steps, null, 2));
    logStep('extract_steps', `Done. ${Array.isArray(steps) ? steps.length : '?'} steps extracted.`);
  }

  // --- evaluate ---
  let evaluation;
  const cachedEval = cached(buildDir, 'evaluation.json');
  if (cachedEval.exists) {
    evaluation = cachedEval.data;
    logStep('evaluate', `Cached. Score: ${evaluation.overallScore || '?'}/10, Approved: ${evaluation.approved}`);
  } else {
    logStep('evaluate', 'Evaluator reviewing plan...');
    evaluation = await evaluatePlan(plan, job, analysis);
    writeFileSync(join(buildDir, 'evaluation.json'), JSON.stringify(evaluation, null, 2));
    logStep('evaluate', `Done. Score: ${evaluation.overallScore || '?'}/10, Approved: ${evaluation.approved}`);
  }

  // --- ensure deployer keystore for live deploys ---
  let deployer = null;
  const hasLiveDeploy = Array.isArray(steps) && steps.some(s =>
    s.command && /yarn\s+deploy\s+--network\s+(?!localhost)\S+/.test(s.command)
  );
  if (hasLiveDeploy) {
    logStep('deployer', 'Ensuring deployer keystore is ready for live network deploy...');
    try {
      deployer = await ensureDeployer();
      logStep('deployer', `Done. Deployer: ${deployer.address} (keystore: ${deployer.keystoreName})`);
    } catch (err) {
      logStep('deployer', `WARNING: Could not set up deployer: ${err.message}. Live deploys may fail.`);
    }
  }

  // --- execute ---
  if (Array.isArray(steps) && steps.length > 0) {
    logStep('execute', `Plan score: ${evaluation.overallScore}/10. Starting step execution...`);
    const execResult = await executeAllSteps(steps, buildDir, {
      skills,
      plan,
      analysis,
      job,
      messages,
      deployer,
    });
    logStep('execute', `Execution complete. ${Object.keys(execResult.completedSteps).length}/${steps.length} steps succeeded.`);

    if (evaluation.approved === false) {
      log('');
      log(`NOTE: Evaluator had concerns (score ${evaluation.overallScore}/10):`);
      log(`  Weaknesses: ${(evaluation.weaknesses || []).join(', ')}`);
    }
  } else {
    log('');
    log('WARNING: No valid steps extracted. Skipping execution.');
  }

  writeLLMAudit();

  log('');
  log('=== Build Complete ===');
  log(`Build dir: ${buildDir}`);
  log('Files produced:');
  log('  job.json           - On-chain job data');
  log('  messages.json      - Client messages');
  log('  skills/            - All SKILL.md reference files');
  log('  analysis.json      - Orchestrator analysis');
  log('  step-outline.md    - Simple planner outline');
  log('  plan.md            - Detailed build plan');
  log('  steps.json         - Executable step definitions');
  log('  evaluation.json    - Plan evaluation');
  log('  execution-log.json - Step-by-step execution results');
  log('  project/           - Scaffolded project output');
  log('  llm-audit.md       - LLM cost/token audit');
  log('  build.log          - Full run log');
  log('  trace.json         - Machine-parseable trace');
}

async function run() {
  const { executeBuildDir, resumeBuildDir } = parseArgs();

  if (executeBuildDir) {
    const absDir = join(process.cwd(), executeBuildDir);
    if (!existsSync(absDir)) {
      throw new Error(`Build directory not found: ${absDir}`);
    }
    return runExecuteOnly(absDir);
  }

  if (resumeBuildDir) {
    const absDir = join(process.cwd(), resumeBuildDir);
    if (!existsSync(absDir)) {
      throw new Error(`Build directory not found: ${absDir}`);
    }
    return runFull(absDir);
  }

  return runFull();
}

run().catch(err => {
  // Write the crash to build.log so it's visible in the tail output
  try { log(`FATAL ERROR: ${err.message}\n${err.stack}`); } catch { /* logger may not be init */ }
  console.error('FATAL:', err);
  process.exit(1);
});
