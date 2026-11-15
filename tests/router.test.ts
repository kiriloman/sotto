// Sotto — routing engine tests.
// Table-driven, same style as Faultline's engine tests. These pin the
// behavior that makes the routing trustworthy: capability walls, the
// private-entry hard rule, size budget, offline behavior, and fallbacks.

import test from 'node:test';
import assert from 'node:assert';
import { decideRoute, toInferenceMode } from '../src/router/engine.ts';
import { DEFAULT_THRESHOLDS, onDeviceCharBudget, TASK_POLICIES } from '../src/router/policy.ts';

const ONLINE_READY = { onDeviceAvailability: 'available', online: true } as const;
const ONLINE_NO_MODEL = { onDeviceAvailability: 'unavailable', online: true } as const;
const OFFLINE_READY = { onDeviceAvailability: 'available', online: false } as const;
const OFFLINE_NO_MODEL = { onDeviceAvailability: 'unavailable', online: false } as const;

const small = 'A short entry about a good day.';
const huge = 'x'.repeat(DEFAULT_THRESHOLDS.onDeviceMaxInputChars + 1000);

test('entry-analysis: on-device when model ready and entry is small (the showcase)', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'on-device');
  assert.ok(d.reasons.some((r) => /on-device/.test(r)));
});

test('entry-analysis: private entry stays on-device even when cloud is faster/better', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'on-device');
  assert.ok(d.reasons.some((r) => /never leave this device/.test(r)));
});

test('entry-analysis: private entry degrades (never silently sends) when no on-device model', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'private', device: ONLINE_NO_MODEL });
  assert.equal(d.path, 'degraded');
  assert.ok(d.reasons.some((r) => /cloud forbidden/.test(r)));
});

test('entry-analysis: standard entry falls back to cloud when no on-device model', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'standard', device: ONLINE_NO_MODEL });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /falling back to cloud/.test(r)));
});

test('entry-analysis: offline works fully on-device (journal keeps working)', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'standard', device: OFFLINE_READY });
  assert.equal(d.path, 'on-device');
  assert.ok(d.reasons.some((r) => /Offline/.test(r)));
});

test('entry-analysis: offline with no on-device model degrades', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'standard', device: OFFLINE_NO_MODEL });
  assert.equal(d.path, 'degraded');
});

test('oversized input: routed to cloud for length (standard tier)', () => {
  const d = decideRoute({ task: 'entry-analysis', input: huge, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /exceeds the on-device budget/.test(r)));
});

test('oversized private entry: degraded rather than sent to cloud (hard rule beats convenience)', () => {
  const d = decideRoute({ task: 'entry-analysis', input: huge, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'degraded');
  assert.ok(d.reasons.some((r) => /cloud forbidden/.test(r) && /too large/.test(r)));
});

test('weekly-synthesis: always cloud — long context exceeds the on-device cap', () => {
  const d = decideRoute({ task: 'weekly-synthesis', input: small, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /exceeds the on-device model input cap/.test(r)));
});

test('weekly-synthesis: private journal degrades — never sends full history to cloud', () => {
  const d = decideRoute({ task: 'weekly-synthesis', input: small, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'degraded');
});

test('deep-dive: always cloud — needs multi-turn chat, unsupported on-device', () => {
  const d = decideRoute({ task: 'deep-dive', input: small, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /single-turn only/.test(r)));
});

test('remote config threshold override is honored', () => {
  const d = decideRoute({
    task: 'entry-analysis',
    input: 'y'.repeat(2000),
    privacy: 'standard',
    device: ONLINE_READY,
    thresholds: { onDeviceMaxInputChars: 1000 },
  });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /exceeds the on-device budget/.test(r)));
});

test('downloading on-device model behaves like unavailable (fall back, do not block)', () => {
  const d = decideRoute({
    task: 'entry-analysis',
    input: small,
    privacy: 'standard',
    device: { onDeviceAvailability: 'downloading', online: true },
  });
  assert.equal(d.path, 'cloud');
});

test('toInferenceMode: cloud → ONLY_IN_CLOUD, on-device → PREFER_ON_DEVICE, degraded → null', () => {
  assert.equal(toInferenceMode({ task: 'entry-analysis', path: 'cloud', reasons: [], inputChars: 0 }), 'ONLY_IN_CLOUD');
  assert.equal(toInferenceMode({ task: 'entry-analysis', path: 'on-device', reasons: [], inputChars: 0 }), 'PREFER_ON_DEVICE');
  assert.equal(toInferenceMode({ task: 'entry-analysis', path: 'degraded', reasons: [], inputChars: 0 }), null);
});

test('on-device budget is consistent with the documented token cap', () => {
  // (9216 tokens - 1200 prompt overhead) * 4 chars/token
  assert.equal(onDeviceCharBudget(), (9216 - 1200) * 4);
});

test('every task has a policy and every policy field is explicit', () => {
  for (const [id, p] of Object.entries(TASK_POLICIES)) {
    assert.equal(typeof p.requiresChat, 'boolean', `${id}.requiresChat`);
    assert.equal(typeof p.requiresLongContext, 'boolean', `${id}.requiresLongContext`);
    assert.equal(typeof p.structuredOutput, 'boolean', `${id}.structuredOutput`);
    assert.ok(['on-device', 'cloud'].includes(p.preferredPath), `${id}.preferredPath`);
  }
});
