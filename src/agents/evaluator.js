import { medium } from '../llm.js';
import { logDecision } from '../logger.js';

export async function evaluatePlan(plan, job, analysis) {
  const prompt = `You are a build plan evaluator for LeftClaw Services. Review this plan and score it.

## Job Summary
- ID: ${job.id}
- Type: Build (service type 6)
- Client: ${job.client}
- Description (first 300 chars): ${(job.description || '').slice(0, 300)}

## Orchestrator Analysis
${JSON.stringify(analysis, null, 2)}

## The Plan
${plan}

## Evaluate Against These Criteria
1. Does the plan cover ALL contract functions from the job description?
2. Does the plan follow ethskills.com patterns (SE2 hooks, three-button flow, loading states)?
3. Does the plan address client preferences from chat?
4. Are security considerations addressed?
5. Is the build step sequence logical and complete?
6. Are model assignments cost-efficient (cheap where possible, expensive only for contracts)?
7. Does the deployment plan cover both contract (Base mainnet) and frontend (BGIPFS via \`yarn ipfs\`)?

## HARD REQUIREMENTS (if ANY of these are missing, set approved=false)
- Plan MUST include a step that runs \`yarn deploy --network base\` (Base mainnet contract deploy)
- Plan MUST include a step that runs \`yarn ipfs\` (BGIPFS frontend deploy) — NOT Vercel. Vercel is NOT acceptable for production.
- Plan MUST include contract verification (\`yarn verify --network base\`)
If any hard requirement is missing, approved MUST be false regardless of score.

## Output (JSON)
{
  "overallScore": 1-10,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "missingItems": ["..."],
  "suggestions": ["..."],
  "approved": true/false
}

Output ONLY valid JSON, no markdown fences.`;

  const result = await medium(
    'You are a critical code reviewer. Be thorough but fair.',
    prompt,
    { role: 'evaluator', maxTokens: 2048 }
  );

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const evaluation = JSON.parse(cleaned);
    logDecision('evaluator', `score=${evaluation.overallScore}/10 approved=${evaluation.approved}`,
      `Strengths: ${evaluation.strengths?.length || 0}, Weaknesses: ${evaluation.weaknesses?.length || 0}`);
    return evaluation;
  } catch {
    logDecision('evaluator', 'parse_failed', 'Could not parse evaluation JSON');
    return { raw: result, approved: true, overallScore: 0 };
  }
}
