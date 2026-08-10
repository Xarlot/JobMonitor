#!/usr/bin/env node
/**
 * Fail if the checked-in generated code no longer matches the .proto.
 *
 * The generated code is committed so that neither the electron-builder build nor the Docker build
 * needs a codegen toolchain, and so a wire-format change shows up as a reviewable diff instead of
 * hiding inside a build step. The cost of that choice is that the two can drift, and drift here is
 * the bad kind: the client would encode against one shape while the receiver validates another,
 * and the symptom is batches quietly failing to parse.
 *
 * So: regenerate into a temp directory and compare. This runs in CI alongside the tests.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = join(pkgRoot, 'src', 'gen');
const scratch = mkdtempSync(join(tmpdir(), 'telemetry-proto-'));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

try {
  execFileSync(
    join(pkgRoot, '..', '..', 'node_modules', '.bin', 'buf'),
    ['generate', '--template', 'buf.gen.yaml', '-o', scratch],
    {
      cwd: pkgRoot,
      stdio: 'inherit',
      // buf invokes protoc-gen-es as a subprocess found on PATH.
      env: { ...process.env, PATH: `${join(pkgRoot, '..', '..', 'node_modules', '.bin')}:${process.env.PATH}` },
    },
  );

  const fresh = walk(join(scratch, 'src', 'gen'));
  const old = walk(committed);

  const rel = (base) => (f) => relative(base, f);
  const freshNames = fresh.map(rel(join(scratch, 'src', 'gen')));
  const oldNames = old.map(rel(committed));

  if (freshNames.join('\n') !== oldNames.join('\n')) {
    console.error('proto drift: generated file list differs.');
    console.error(`  committed:   ${oldNames.join(', ') || '(none)'}`);
    console.error(`  regenerated: ${freshNames.join(', ') || '(none)'}`);
    process.exit(1);
  }

  for (const name of freshNames) {
    const a = readFileSync(join(committed, name), 'utf8');
    const b = readFileSync(join(scratch, 'src', 'gen', name), 'utf8');
    if (a !== b) {
      console.error(`proto drift: ${name} differs from the .proto.`);
      console.error('Run `npm run proto:gen -w @jobmonitor/telemetry-schema` and commit the result.');
      process.exit(1);
    }
  }

  console.log(`proto: ${freshNames.length} generated file(s) match the schema.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
