/**
 * Write the repo's copy of the failure-triage skill from its single source.
 *
 * The app ships the skill as a string (electron/failureTriageSkill.cjs) because a packaged
 * build has no repo to read from, while a developer wants the same procedure available to
 * an ordinary `claude` session here. Rather than maintain both, one is generated — and a
 * test fails if they drift.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { failureTriageSkill, flowBlameSkill } = require('../electron/skills.cjs');
const skills = [failureTriageSkill, flowBlameSkill];

for (const { SKILL_NAME, SKILL_MARKDOWN } of skills) {
  const dir = `.claude/skills/${SKILL_NAME}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/SKILL.md`, SKILL_MARKDOWN, 'utf8');
  console.log(`wrote ${dir}/SKILL.md`);
}
