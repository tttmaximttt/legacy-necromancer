import type { PlanReport, PlanStep } from '@necromancer/core';

const MAX_TOUCHES = 10;

/** Renders a plan as Markdown, for plan.md: one numbered step at a time, each followed by its check. */
export function renderPlanMarkdown(plan: PlanReport): string {
  const out: string[] = [`# Modernization plan for ${plan.repo.source}`, ''];
  out.push(`Generated ${plan.generatedAt}${plan.repo.commit ? ` at commit ${plan.repo.commit.slice(0, 12)}` : ''}.`, '');
  if (plan.intent) out.push(`**What it is for:** ${plan.intent}`, '');
  if (plan.goals.length) out.push('**Goals:**', '', ...plan.goals.map((g) => `- ${g}`), '');
  out.push(`**Target:** Node ${plan.target.node}. ${plan.target.why}`, '');
  out.push(`**Check after every step:** \`${plan.baseline.command}\`. ${plan.baseline.passes}`, '');
  out.push('Do the steps one at a time, in order. A step is done only when its check passes.', '');

  out.push('## Steps', '');
  if (!plan.steps.length) out.push('Nothing to change.', '');
  for (const step of plan.steps) out.push(...renderStep(step));

  if (plan.leftAlone.length) {
    out.push('## Left alone', '', ...plan.leftAlone.map((l) => `- **${l.name}**: ${l.reason}`), '');
  }
  if (plan.warnings.length) out.push('## Warnings', '', ...plan.warnings.map((w) => `- ${w}`), '');
  return out.join('\n');
}

function renderStep(step: PlanStep): string[] {
  const out = [`### ${step.n}. ${step.title}`, '', `Risk: ${step.risk}.${step.after.length ? ` After: ${step.after.join(', ')}.` : ''}`, ''];
  out.push('Change:', '', ...step.change.map((c) => `- ${c.name}: ${c.from ?? 'none'} -> ${c.to ?? 'removed'}`), '');
  if (step.why.length) out.push('Why:', '', ...step.why.map((w) => `- ${w}`), '');
  if (step.goals.length) out.push(`Serves: ${step.goals.join('; ')}`, '');
  if (step.touches.length) {
    const shown = step.touches.slice(0, MAX_TOUCHES).map((f) => `\`${f}\``).join(', ');
    const more = step.touches.length > MAX_TOUCHES ? ` and ${step.touches.length - MAX_TOUCHES} more` : '';
    out.push(`Touches: ${shown}${more}.`, '');
  }
  out.push(`Then check: \`${step.check.command}\`. ${step.check.passes}`, '');
  return out;
}
