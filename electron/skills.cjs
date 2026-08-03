/**
 * The Claude Code skills the app installs for its analyses.
 *
 * **Plain Markdown files, deliberately.** These lived as template literals in JS, which
 * meant every backtick and every fence needed escaping — and an escaping slip produced
 * either a syntax error or, worse, a skill that loaded with stray backslashes in it. A
 * `.md` file has no escaping at all, is diffable, and renders in an editor. `electron/**`
 * is packaged (see electron-builder.yml), so they ship with the app.
 *
 * Read once at require time: they are a few kilobytes and are needed on every analysis.
 */

const fs = require('node:fs');
const path = require('node:path');

function load(name) {
  return {
    SKILL_NAME: name,
    SKILL_MARKDOWN: fs.readFileSync(path.join(__dirname, 'skills', `${name}.md`), 'utf8'),
  };
}

/** Why this run failed — reads one run. */
const failureTriageSkill = load('failure-triage');
/** Who broke it and when — reads a branch's run history and the diffs in between. */
const flowBlameSkill = load('flow-blame');

module.exports = { failureTriageSkill, flowBlameSkill };
