import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { cheap, medium } from './llm.js';
import { log, logStepExecution } from './logger.js';
import { writeFilesFromOutput, writeSingleOutput } from './file-writer.js';

// EVM revert signatures that indicate the CONTRACT has a bug, not the test.
// When a test fails with one of these, diagnose both files rather than blaming the test.
const EVM_REVERT_PATTERNS = [
  /ERC20InvalidReceiver/,
  /ERC20InsufficientAllowance/,
  /ERC20InsufficientBalance/,
  /ERC721InvalidTokenId/,
  /OwnableUnauthorizedAccount/,
  /Panic\(\d+\)/,
  /\[FAIL:\s+[A-Z][a-zA-Z]+\(/,  // custom errors: SomeError(...)
];

/**
 * Parse a compiler/runtime error, identify the broken file(s),
 * call an LLM to fix them, and write the fixes to disk.
 *
 * Returns an array of { path, error, fixed } or null if nothing could be fixed.
 */
export async function fixCodeFromError(errorOutput, projectDir, step, context) {
  const errors = parseErrors(errorOutput);
  if (errors.length === 0) {
    log(`FIXER: could not parse any file-level errors from output`);
    return null;
  }

  log(`FIXER: found ${errors.length} error(s) in ${[...new Set(errors.map(e => e.file))].join(', ')}`);

  // Group errors by file
  const byFile = new Map();
  for (const err of errors) {
    if (!byFile.has(err.file)) byFile.set(err.file, []);
    byFile.get(err.file).push(err);
  }

  const fixes = [];

  for (const [relPath, fileErrors] of byFile) {
    // Resolve path: try as-is first, then under common subdirs (forge reports relative to packages/foundry/)
    const resolvedPath = resolveProjectPath(relPath, projectDir);
    if (!resolvedPath) {
      log(`FIXER: file not found: ${relPath}, skipping`);
      continue;
    }
    const absPath = join(projectDir, resolvedPath);

    const brokenCode = readFileSync(absPath, 'utf-8');
    const errorSummary = fileErrors
      .map(e => `Line ${e.line}: ${e.message}`)
      .join('\n');

    // Gather related files for context (e.g., if test imports contract, include it)
    // Use resolvedPath (has packages/foundry/ prefix) so relative imports like
    // "../contracts/BurnBoard.sol" resolve to the correct location on disk.
    const relatedContext = gatherRelatedFiles(brokenCode, resolvedPath, projectDir);

    const isSolidity = resolvedPath.endsWith('.sol');
    const isTestFailure = fileErrors.some(e => e.type === 'test_failure');

    // Detect whether the test failure reason looks like an EVM revert (contract bug)
    // vs a test assertion failure (test bug).
    const isEvmRevert = isTestFailure && EVM_REVERT_PATTERNS.some(p => p.test(errorOutput));

    if (isEvmRevert) {
      // Neutral diagnosis: include both test and contract, let the LLM decide what to fix.
      // Returns files in === FILEPATH === format so we can write multiple files.
      log(`FIXER: EVM revert detected — running neutral diagnosis on test + contract`);
      const contractContext = gatherContractFiles(resolvedPath, projectDir);

      try {
        const fixedOutput = await medium(
          `You are a Solidity debugger. A Forge test suite is failing with EVM-level reverts (not assertion failures). ` +
          `This means either the CONTRACT has a bug (e.g. wrong burn mechanism, wrong address used) OR the test mock is incomplete. ` +
          `Diagnose the root cause and fix WHICHEVER FILE(S) need fixing — the contract, the test, or both. ` +
          `Return ALL changed files using this format:\n\n` +
          `=== packages/foundry/path/to/file.sol ===\n(full corrected file contents)\n=== END ===\n\n` +
          `Only output files that actually need changes. No explanations outside the === blocks.`,
          `## Failing Test File: ${resolvedPath}
${errorSummary}

## Full Test Output
${errorOutput.slice(0, 3000)}

## Test File Contents
${brokenCode}

${contractContext}

Diagnose whether the contract logic or the test assumptions are wrong. Fix whichever file(s) need fixing. Return corrected files in === FILEPATH === format.`,
          { role: `fixer-${basename(relPath)}-diagnosis`, maxTokens: 8192 }
        );

        const written = writeFilesFromOutput(fixedOutput, projectDir);
        if (written.length > 0) {
          for (const f of written) {
            fixes.push({ path: f.relativePath, errors: fileErrors.length, fixed: true });
            log(`FIXER: diagnosis fixed ${f.relativePath}`);
          }
        } else {
          fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: false });
          log(`FIXER: diagnosis produced no file changes`);
        }
      } catch (err) {
        log(`FIXER: diagnosis failed: ${err.message}`);
        fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: false });
      }
      continue;
    }

    const callFn = isSolidity ? medium : cheap;
    const modelLabel = isSolidity ? 'sonnet (solidity fix)' : 'cheap (fix)';

    const systemPrompt = isTestFailure
      ? `You are a test fixer. Tests are failing because they make incorrect assumptions about the contract. The CONTRACT is correct — fix the TESTS to match the contract's actual behavior. Return ONLY the corrected test file contents. No explanations, no markdown fences.`
      : `You are a code fixer. You receive a file with compiler errors and must return ONLY the corrected file contents. No explanations, no markdown fences, no === markers. Output the raw file contents and nothing else.`;

    log(`FIXER: fixing ${resolvedPath} (${fileErrors.length} ${isTestFailure ? 'test failures' : 'errors'}) with ${modelLabel}`);

    try {
      const fixedCode = await callFn(
        systemPrompt,
        `## File: ${resolvedPath}
## ${isTestFailure ? 'Test Failures' : 'Errors'}
${errorSummary}

## Full Error Output
${errorOutput.slice(0, 4000)}

## Current File Contents
${brokenCode}

${relatedContext}

Fix ALL the ${isTestFailure ? 'failing tests' : 'errors'} listed above. ${isTestFailure ? 'The contract is correct — fix the test expectations to match actual behavior.' : ''} Return ONLY the corrected file contents. Do not wrap in code fences or markers.`,
        { role: `fixer-${basename(relPath)}`, maxTokens: 8192 }
      );

      // Strip any accidental fences the model might add
      const cleaned = fixedCode
        .replace(/^```\w*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();

      writeSingleOutput(projectDir, resolvedPath, cleaned);
      fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: true });
      log(`FIXER: wrote fixed ${resolvedPath} (${Buffer.byteLength(cleaned)} bytes)`);
    } catch (err) {
      log(`FIXER: failed to fix ${resolvedPath}: ${err.message}`);
      fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: false });
    }
  }

  return fixes.length > 0 ? fixes : null;
}

/**
 * Parse compiler errors from stderr/stdout output.
 * Handles Solidity (forge) and TypeScript error formats.
 */
function parseErrors(output) {
  const errors = [];

  // Solidity: Error (CODE): message\n --> file:line:col:
  const solRe = /Error\s*\(\d+\):\s*(.+)\n\s*-->\s*([^:]+):(\d+):\d+/g;
  let match;
  while ((match = solRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'solidity',
    });
  }

  // Also catch "Error:" without code
  const solRe2 = /Error:\s*(.+)\n\s*-->\s*([^:]+):(\d+):\d+/g;
  while ((match = solRe2.exec(output)) !== null) {
    const msg = match[1].trim();
    if (msg === 'Compiler run failed:') continue;
    errors.push({
      message: msg,
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'solidity',
    });
  }

  // TypeScript: error TS2304: message\n  file(line,col)
  const tsRe = /error\s+TS\d+:\s*(.+)\n\s*(\S+)\((\d+),\d+\)/g;
  while ((match = tsRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'typescript',
    });
  }

  // Next.js build: ./path/to/file.tsx:line:col\nType error: message
  const nextRe = /\.(\/[^\s:]+\.tsx?):(\d+):\d+\n(?:Type\s+)?error:\s*(.+)/g;
  while ((match = nextRe.exec(output)) !== null) {
    errors.push({
      message: match[3].trim(),
      file: match[1].replace(/^\.\//, ''),  // strip leading ./
      line: parseInt(match[2], 10),
      type: 'typescript',
    });
  }

  // Next.js build: Module not found for local paths (~~/ or ./)
  // Format: ./path/to/importer.tsx\nModule not found: Can't resolve '~~/path/to/missing'
  const moduleNotFoundRe = /\.(\/[^\s]+\.tsx?)\n(?:import\s+\S+\s+from\s+"[^"]+"\s*\n)?Module not found: Can't resolve '([^']+)'/g;
  while ((match = moduleNotFoundRe.exec(output)) !== null) {
    const importingFile = match[1].replace(/^\.\//, '');
    const missingModule = match[2];
    // Only handle local imports (~~ or ./) — npm packages are handled by auto-install
    if (missingModule.startsWith('~~') || missingModule.startsWith('.')) {
      errors.push({
        message: `Module not found: Can't resolve '${missingModule}'`,
        file: importingFile,
        line: 1,
        type: 'typescript',
      });
    }
  }

  // Next.js / generic: Error: message in file:line
  const genericRe = /Error:\s*(.+?)\s+in\s+(\S+):(\d+)/g;
  while ((match = genericRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'generic',
    });
  }

  // Next.js: "Attempted import error: 'X' is not exported from 'module'"
  // Format: ./components/X.tsx\nAttempted import error: '...' is not exported from '...'
  const attemptedImportRe = /\.(\/[^\s]+\.tsx?)\nAttempted import error:\s*'([^']+)' is not exported from '([^']+)'/g;
  while ((match = attemptedImportRe.exec(output)) !== null) {
    errors.push({
      message: `Attempted import error: '${match[2]}' is not exported from '${match[3]}' — remove or replace this import`,
      file: match[1].replace(/^\.\//, ''),
      line: 1,
      type: 'typescript',
    });
  }

  // ESLint errors in Next.js build output:
  // ./components/PostForm.tsx
  // 56:59  Error: 'isApproving' is assigned a value but never used.  @typescript-eslint/no-unused-vars
  const eslintRe = /\.(\/[^\s]+\.tsx?)\n[\s\S]*?(\d+):(\d+)\s+Error:\s+(.+?)\s{2,}@[\w/\-]+/g;
  while ((match = eslintRe.exec(output)) !== null) {
    errors.push({
      message: match[4].trim(),
      file: match[1].replace(/^\.\//, ''),
      line: parseInt(match[2], 10),
      type: 'typescript',
    });
  }

  // Forge deploy: constructor reverted because an address arg was address(0).
  // The deploy script used vm.envOr("TOKEN_ADDRESS", address(0)) but the env var isn't set.
  // Fix: the deploy script must hardcode the real Base mainnet token address as the default.
  if (/cannot be zero|address cannot be zero|invalid token address|zero address/i.test(output)
      && /script failed|Error:/i.test(output)) {
    errors.push({
      message: 'Deploy reverted: address constructor arg is zero — use the real Base mainnet token address as vm.envOr default instead of address(0)',
      file: 'script/Deploy.s.sol',
      line: 1,
      type: 'solidity',
    });
  }

  // Forge script deploy error: vm.startBroadcast called twice (Deploy.s.sol wraps sub-scripts
  // that also use ScaffoldEthDeployerRunner). Point to Deploy.s.sol as the broken file.
  if (/vm\.startBroadcast: a broadcast is active already/i.test(output)) {
    errors.push({
      message: 'vm.startBroadcast called twice — Deploy.s.sol must deploy contracts inline, not call sub-script run() methods that also use ScaffoldEthDeployerRunner',
      file: 'script/Deploy.s.sol',
      line: 1,
      type: 'solidity',
    });
  }

  // Forge test failures — use the "Failing tests:" section which attributes each failure to its file:
  //   "Encountered N failing test in test/BurnBoard.t.sol:BurnBoardTest"
  //   "[FAIL: reason] test_name()"
  const failingSectionRe = /failing tests? in ([^:]+):\w+\s*\n([\s\S]*?)(?=\n\n|Encountered a total)/g;
  while ((match = failingSectionRe.exec(output)) !== null) {
    const file = match[1].trim();
    const block = match[2];
    const failRe2 = /\[FAIL[:\s]*([^\]]*)\]\s*(\w+)\(\)/g;
    let fmatch;
    while ((fmatch = failRe2.exec(block)) !== null) {
      errors.push({
        message: `Test ${fmatch[2]}() failed: ${fmatch[1].trim()}`,
        file,
        line: 0,
        type: 'test_failure',
      });
    }
  }

  return deduplicateErrors(errors);
}

/**
 * Resolve a file path from an error message to its actual location in the project.
 * Forge reports paths relative to packages/foundry/, TypeScript relative to packages/nextjs/.
 */
function resolveProjectPath(errorPath, projectDir) {
  const candidates = [
    errorPath,
    `packages/foundry/${errorPath}`,
    `packages/nextjs/${errorPath}`,
    `packages/foundry/src/${errorPath}`,
    `packages/nextjs/src/${errorPath}`,
  ];

  for (const candidate of candidates) {
    if (existsSync(join(projectDir, candidate))) {
      return candidate;
    }
  }
  return null;
}

function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter(e => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * For EVM revert diagnosis: find all contract .sol files the test imports
 * (and all contracts in packages/foundry/contracts/) to give the LLM
 * the full picture so it can decide which file has the bug.
 */
function gatherContractFiles(testRelPath, projectDir) {
  const parts = [];

  // Read the test file to find its imports
  const absTest = join(projectDir, testRelPath);
  let testCode = '';
  try { testCode = readFileSync(absTest, 'utf-8'); } catch { return ''; }

  // Collect imported local .sol files (not lib/ or forge-std/)
  const importRe = /import\s+["']([^"']+\.sol)["']/g;
  let m;
  while ((m = importRe.exec(testCode)) !== null) {
    const raw = m[1];
    if (raw.includes('forge-std') || raw.includes('lib/') || raw.includes('@openzeppelin')) continue;
    const resolved = join(dirname(testRelPath), raw);
    const abs = join(projectDir, resolved);
    if (existsSync(abs)) {
      try {
        parts.push(`## Contract: ${resolved}\n${readFileSync(abs, 'utf-8').slice(0, 6000)}`);
      } catch { /* skip */ }
    }
  }

  // Also sweep packages/foundry/contracts/ for any .sol files not already included
  const contractsDir = join(projectDir, 'packages/foundry/contracts');
  if (existsSync(contractsDir)) {
    try {
      for (const f of readdirSync(contractsDir)) {
        if (!f.endsWith('.sol')) continue;
        const rel = `packages/foundry/contracts/${f}`;
        if (parts.some(p => p.includes(rel))) continue;
        try {
          parts.push(`## Contract: ${rel}\n${readFileSync(join(contractsDir, f), 'utf-8').slice(0, 6000)}`);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return parts.length > 0 ? `\n## Contract Source Files\n${parts.join('\n\n')}` : '';
}

/**
 * If the broken file imports other project files, read them for context.
 * Helps the fixer understand the interfaces the code is supposed to use.
 */
function gatherRelatedFiles(brokenCode, brokenPath, projectDir) {
  const parts = [];

  // Solidity: import "./Contract.sol" or import "../contracts/Contract.sol"
  const solImports = [...brokenCode.matchAll(/import\s+["']([^"']+)["']/g)];
  for (const m of solImports) {
    const importPath = m[1];
    // Resolve relative to the broken file's directory
    const resolved = join(dirname(brokenPath), importPath);
    const absPath = join(projectDir, resolved);
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, 'utf-8');
        parts.push(`## Related: ${resolved}\n${content.slice(0, 4000)}`);
      } catch { /* skip */ }
    }
  }

  // TypeScript/JS: import from "~~/something" or from "./something"
  const tsImports = [...brokenCode.matchAll(/from\s+["'](~~\/|\.\.?\/)[^"']+["']/g)];
  for (const m of tsImports) {
    const raw = m[0].match(/["']([^"']+)["']/)?.[1];
    if (!raw) continue;
    const resolved = raw.replace('~~/', '');
    const candidates = [resolved, resolved + '.tsx', resolved + '.ts', resolved + '/index.tsx'];
    for (const c of candidates) {
      const absPath = join(projectDir, c);
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, 'utf-8');
          parts.push(`## Related: ${c}\n${content.slice(0, 3000)}`);
        } catch { /* skip */ }
        break;
      }
    }
  }

  return parts.length > 0
    ? `\n## Related Files (for interface reference)\n${parts.join('\n\n')}`
    : '';
}
