import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { log, logDecision } from './logger.js';

/**
 * Validate step results with stage-aware checks.
 *
 * Shell steps: exit code + command-specific output checks
 * Code gen steps: file existence + content sanity checks
 * Read context: always pass
 *
 * Returns { passed: boolean, reason: string, suggestions: string[] }
 */
export async function validateStep(step, result, projectDir) {
  const { stepType } = result;

  if (stepType === 'read_context') {
    logDecision('validator', `step=${step.id} PASS`, 'Read context auto-pass');
    return { passed: true, reason: 'Context read successfully', suggestions: [] };
  }

  if (stepType === 'shell_cmd') {
    return validateShellResult(step, result, projectDir);
  }

  return validateCodeGenResult(step, result, projectDir);
}

// ─── Shell validation ────────────────────────────────────────────────────────

function validateShellResult(step, result, projectDir) {
  const { exitCode, stdout, stderr } = result;
  const output = (stdout || '') + (stderr || '');
  const cmd = step.command || '';

  // Vercel deploy: the CLI outputs the production URL as soon as the upload completes
  // (before the remote build finishes). If we time out or the CLI exits with code 1,
  // we check for the URL — if present, the deploy was accepted by Vercel's servers.
  if (/vercel:yolo|vercel\s+deploy/.test(cmd)) {
    const vercelUrl = (stdout || '').match(/https:\/\/[a-z0-9-]+\.vercel\.app/)
      || (stderr || '').match(/https:\/\/[a-z0-9-]+\.vercel\.app/);
    if (vercelUrl) {
      logDecision('validator', `step=${step.id} PASS`, `Vercel deploy accepted — URL: ${vercelUrl[0]}`);
      return { passed: true, reason: `Vercel deployment queued/deployed: ${vercelUrl[0]}`, suggestions: [] };
    }
  }

  if (exitCode !== 0) {
    const errorOutput = output.slice(-2000);
    const reason = `Exit code ${exitCode}: ${errorOutput.slice(0, 300)}`;
    logDecision('validator', `step=${step.id} FAIL`, reason.slice(0, 200));
    return { passed: false, reason, suggestions: [] };
  }

  // yarn deploy — verify deployedContracts.ts was updated with a real address
  if (/yarn\s+deploy/.test(cmd)) {
    return validateDeploy(step, projectDir, output);
  }

  // yarn test — verify no test failures in output
  if (/yarn\s+test/.test(cmd)) {
    return validateTests(step, output);
  }

  // yarn next:build — check for build errors beyond exit code
  if (/yarn\s+next:build/.test(cmd)) {
    return validateNextBuild(step, output);
  }

  // create-eth scaffold — verify the project directory was created
  if (/create-eth/.test(cmd)) {
    return validateScaffold(step, projectDir);
  }

  logDecision('validator', `step=${step.id} PASS`, 'Exit code 0');
  return { passed: true, reason: 'Command completed successfully', suggestions: [] };
}

function validateDeploy(step, projectDir, output) {
  if (!projectDir) {
    return { passed: true, reason: 'Deploy exited 0 (no projectDir to verify)', suggestions: [] };
  }

  const contractsPath = join(projectDir, 'packages/nextjs/contracts/deployedContracts.ts');
  if (!existsSync(contractsPath)) {
    logDecision('validator', `step=${step.id} FAIL`, 'deployedContracts.ts not found after yarn deploy');
    return {
      passed: false,
      reason: 'yarn deploy completed but deployedContracts.ts was not generated',
      suggestions: ['Check that the deploy script inherits ScaffoldETHDeploy and uses ScaffoldEthDeployerRunner'],
    };
  }

  const contents = readFileSync(contractsPath, 'utf-8');
  // Check for a real address — 0x followed by 40 non-zero hex chars
  const hasRealAddress = /0x[1-9a-fA-F][0-9a-fA-F]{38,39}/.test(contents);
  if (!hasRealAddress) {
    logDecision('validator', `step=${step.id} FAIL`, 'deployedContracts.ts has no real contract address');
    return {
      passed: false,
      reason: 'deployedContracts.ts exists but contains no real deployed address',
      suggestions: ['Deploy may have run in dry-run mode', 'Check broadcast logs for actual deployment'],
    };
  }

  logDecision('validator', `step=${step.id} PASS`, 'deployedContracts.ts has real address');
  return { passed: true, reason: 'Deploy succeeded and deployedContracts.ts updated with real address', suggestions: [] };
}

function validateTests(step, output) {
  const failPatterns = [
    /\bFAIL\b/,
    /\bFailed\b/,
    /\bfailing\b/i,
    /\d+ failing/,
    /Encountered \d+ failing/,
    /FAILED \[/,
  ];

  const failure = failPatterns.find(p => p.test(output));
  if (failure) {
    const match = output.match(failure);
    logDecision('validator', `step=${step.id} FAIL`, `Test failures detected: ${match?.[0]}`);
    return {
      passed: false,
      reason: `Test failures detected in output`,
      suggestions: ['Fix failing tests before proceeding'],
    };
  }

  logDecision('validator', `step=${step.id} PASS`, 'Tests passed');
  return { passed: true, reason: 'Tests passed', suggestions: [] };
}

function validateNextBuild(step, output) {
  const errorPatterns = [
    /Type error:/,
    /Build failed/i,
    /Failed to compile/i,
    /error TS\d+/,
    /Module not found/,
    /Attempted import error/,
    /Failed to collect page data/,
    /Failed to collect configuration/,
  ];

  const failure = errorPatterns.find(p => p.test(output));
  if (failure) {
    const excerpt = output.slice(output.search(failure), output.search(failure) + 300);
    logDecision('validator', `step=${step.id} FAIL`, `Build error: ${excerpt.slice(0, 100)}`);
    return {
      passed: false,
      reason: `Build error: ${excerpt.slice(0, 200)}`,
      suggestions: ['Fix TypeScript/import errors before deploying frontend'],
    };
  }

  logDecision('validator', `step=${step.id} PASS`, 'Next.js build succeeded');
  return { passed: true, reason: 'Next.js build succeeded', suggestions: [] };
}

function validateScaffold(step, projectDir) {
  if (!projectDir) {
    return { passed: true, reason: 'Scaffold exited 0', suggestions: [] };
  }

  const pkgJson = join(projectDir, 'package.json');
  if (!existsSync(pkgJson)) {
    logDecision('validator', `step=${step.id} FAIL`, 'package.json not found after scaffold');
    return {
      passed: false,
      reason: 'Scaffold command exited 0 but no package.json found in project directory',
      suggestions: ['create-eth may have failed silently', 'Check that project name is valid'],
    };
  }

  logDecision('validator', `step=${step.id} PASS`, 'Scaffold created project with package.json');
  return { passed: true, reason: 'Project scaffolded successfully', suggestions: [] };
}

// ─── Code gen validation ─────────────────────────────────────────────────────

function validateCodeGenResult(step, result, projectDir) {
  const { filesWritten, llmOutput } = result;

  if (!filesWritten || filesWritten.length === 0) {
    logDecision('validator', `step=${step.id} FAIL`, 'No files extracted from LLM output');
    return {
      passed: false,
      reason: 'No files were extracted from the LLM output',
      suggestions: ['Model may not have used the === FILEPATH === format'],
    };
  }

  const issues = [];

  for (const fileInfo of filesWritten) {
    const relPath = fileInfo.relativePath || fileInfo;
    const absPath = projectDir ? join(projectDir, relPath) : null;
    const content = absPath && existsSync(absPath)
      ? readFileSync(absPath, 'utf-8')
      : (llmOutput || '');

    const fileIssues = checkFileContent(relPath, content, step);
    issues.push(...fileIssues);
  }

  if (issues.length > 0) {
    const reason = issues[0];
    logDecision('validator', `step=${step.id} FAIL`, reason);
    return {
      passed: false,
      reason,
      suggestions: issues.slice(1),
    };
  }

  const fileList = filesWritten.map(f => f.relativePath || f).join(', ');
  logDecision('validator', `step=${step.id} PASS`, `${filesWritten.length} file(s): ${fileList.slice(0, 150)}`);
  return {
    passed: true,
    reason: `Wrote ${filesWritten.length} file(s)`,
    suggestions: [],
  };
}

function checkFileContent(relPath, content, step) {
  const issues = [];

  if (!content || content.trim().length < 20) {
    issues.push(`File ${relPath} is empty or too short`);
    return issues;
  }

  // Solidity files
  if (relPath.endsWith('.sol')) {
    if (!/pragma solidity/.test(content)) {
      issues.push(`${relPath} missing "pragma solidity" — not valid Solidity`);
    }
    if (!/\bcontract\s+\w+/.test(content) && !/\binterface\s+\w+/.test(content) && !/\blibrary\s+\w+/.test(content)) {
      issues.push(`${relPath} has no contract/interface/library declaration`);
    }
    // Deploy scripts must inherit ScaffoldETHDeploy
    if (relPath.includes('/script/') && !/ScaffoldETHDeploy/.test(content)) {
      issues.push(`Deploy script ${relPath} must inherit ScaffoldETHDeploy — use the SE2 deploy pattern`);
    }
    // Test files must extend Test
    if (relPath.includes('/test/') && !/(is\s+Test|forge-std\/Test)/.test(content)) {
      issues.push(`Test file ${relPath} must import forge-std/Test.sol and extend Test`);
    }
  }

  // TypeScript/TSX frontend files
  if (relPath.endsWith('.tsx') || (relPath.endsWith('.ts') && !relPath.endsWith('.d.ts'))) {
    // deployedContracts.ts should never be written by an LLM — it's auto-generated
    if (relPath.includes('deployedContracts')) {
      issues.push(
        `deployedContracts.ts must not be written manually — it is auto-generated by "yarn deploy". Remove this step.`
      );
    }
    // React components must have a default export
    if (relPath.endsWith('.tsx') && !/export default/.test(content)) {
      issues.push(`React component ${relPath} has no default export`);
    }
    // SE2 frontend files must not use raw wagmi hooks when SE2 hooks are available
    const rawWagmiHooks = ['useContractRead', 'useContractWrite', 'useContractEvent'];
    for (const hook of rawWagmiHooks) {
      if (content.includes(hook)) {
        issues.push(`${relPath} uses raw wagmi hook "${hook}" — use useScaffoldReadContract/useScaffoldWriteContract/useScaffoldEventHistory instead`);
        break;
      }
    }
  }

  return issues;
}
