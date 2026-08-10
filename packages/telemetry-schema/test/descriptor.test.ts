/**
 * The structural privacy guarantee.
 *
 * Sanitizers, deny-pattern scans and code review are all defences that depend on somebody being
 * careful. This one does not: it walks the generated protobuf descriptor and fails the build if a
 * `string` field appears anywhere outside a short allowlist.
 *
 * The reasoning is that free text is the only thing in this system that can carry a repository
 * name, a file path, a branch, or a token. A counter cannot. So rather than trying to guarantee
 * that no bad string is ever *put* into the format, the format is kept almost entirely numeric and
 * this test guards the exception list. Adding a string field is then a deliberate act that fails
 * CI and has to be argued for in review, which is exactly the friction it deserves.
 *
 * If you are here because this test failed: do not add your field to the allowlist to make it pass.
 * Ask whether the thing you want to send can be an id from a registry instead. It almost always can.
 */

import { describe, expect, it } from 'vitest';
import { ScalarType, type DescField, type DescMessage } from '@bufbuild/protobuf';

import { file_jobmonitor_telemetry_v1_telemetry } from '../src/gen/jobmonitor/telemetry/v1/telemetry_pb';

/**
 * Every string field the wire format is permitted to carry, and why it has to be a string.
 *
 * Note what is absent: nothing carries a name, a path, a URL, an identifier of a repository, or a
 * message of any kind. `exception_type` is a class name and is validated against a class-name shape
 * by the receiver; `stack` is sanitized client-side and re-checked server-side.
 */
const ALLOWED_STRING_FIELDS = new Set([
  'TelemetryBatch.app_version',
  'TelemetryBatch.electron_version',
  'CrashRecord.app_version',
  'CrashRecord.exception_type',
  'CrashRecord.stack',
]);

/** Recurse through nested messages too, so a nested type cannot be a side door. */
function allMessages(messages: readonly DescMessage[]): DescMessage[] {
  return messages.flatMap((m) => [m, ...allMessages(m.nestedMessages ?? [])]);
}

function stringFieldsOf(message: DescMessage): string[] {
  const found: string[] = [];
  for (const field of message.fields as readonly DescField[]) {
    const isString =
      (field.fieldKind === 'scalar' && field.scalar === ScalarType.STRING) ||
      (field.fieldKind === 'list' && field.listKind === 'scalar' && field.scalar === ScalarType.STRING) ||
      // A map with string values is a free-text dictionary wearing a hat — the exact shape the
      // "no generic track(name, dict)" rule exists to prevent.
      (field.fieldKind === 'map' && field.mapKind === 'scalar' && field.scalar === ScalarType.STRING);
    if (isString) found.push(`${message.name}.${field.name}`);
  }
  return found;
}

describe('wire format', () => {
  const messages = allMessages(file_jobmonitor_telemetry_v1_telemetry.messages);

  it('contains no string field outside the allowlist', () => {
    const actual = messages.flatMap(stringFieldsOf).sort();
    expect(actual).toEqual([...ALLOWED_STRING_FIELDS].sort());
  });

  it('has no map fields at all', () => {
    // A map is an arbitrary key/value bag. The client API deliberately exposes no way to send one,
    // and the format deliberately offers nowhere to put one.
    const maps = messages.flatMap((m) =>
      (m.fields as readonly DescField[])
        .filter((f) => f.fieldKind === 'map')
        .map((f) => `${m.name}.${f.name}`),
    );
    expect(maps).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // Guards against the allowlist naming a field that no longer exists — which would let a real
    // string field slip in under a stale entry.
    const every = new Set(
      messages.flatMap((m) => (m.fields as readonly DescField[]).map((f) => `${m.name}.${f.name}`)),
    );
    for (const allowed of ALLOWED_STRING_FIELDS) {
      expect(every.has(allowed), `${allowed} is allow-listed but does not exist`).toBe(true);
    }
  });
});
