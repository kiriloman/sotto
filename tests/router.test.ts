// Sotto — routing engine tests.
// Table-driven, same style as Faultline's engine tests. These pin the
// behavior that makes the routing trustworthy: capability walls, the
// private-entry hard rule (at decision AND execution time), size budget
// (incl. CJK-aware token estimation), offline behavior, and fallbacks.

import test from 'node:test';
import assert from 'node:assert';
import { decideRoute, toInferenceMode } from '../src/router/engine.ts';
import {
  DEFAULT_THRESHOLDS,
  onDeviceCharBudget,
  onDeviceTokenBudget,
  estimateTokens,
  TASK_POLICIES,
} from '../src/router/policy.ts';

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

test('entry-analysis: private entry stays on-device even when cloud is available', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'on-device');
  assert.ok(d.reasons.some((r) => /never leave this device/.test(r)));
});

test('entry-analysis: private entry degrades (never silently sends) when no on-device model', () => {
  const d = decideRoute({ task: 'entry-analysis', input: small, privacy: 'private', device: ONLINE_NO_MODEL });
  assert.equal(d.path, 'degraded');
  assert.ok(d.reasons.some((r) => /forbidden/.test(r)));
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
  assert.ok(d.reasons.some((r) => /cloud required for length/.test(r)));
});

test('oversized private entry: degraded rather than sent to cloud (hard rule beats convenience)', () => {
  const d = decideRoute({ task: 'entry-analysis', input: huge, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'degraded');
  assert.ok(d.reasons.some((r) => /forbidden/.test(r) && /trim the entry/.test(r)));
});

test('weekly-synthesis: prefers cloud, but size is measured — a small week is NOT claimed to exceed the cap', () => {
  const d = decideRoute({ task: 'weekly-synthesis', input: small, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  // The reason must be the honest preference, not a false cap claim.
  assert.ok(!d.reasons.some((r) => /exceeds/i.test(r)), JSON.stringify(d.reasons));
  assert.ok(d.reasons.some((r) => /prefers cloud reasoning quality/i.test(r)));
});

test('weekly-synthesis: large history routes to cloud BY MEASURED SIZE (honest reason)', () => {
  const d = decideRoute({ task: 'weekly-synthesis', input: huge, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /cloud required for length/.test(r)));
});

test('weekly-synthesis: a small fully-private week synthesizes ON-DEVICE (privacy as a feature)', () => {
  const d = decideRoute({ task: 'weekly-synthesis', input: small, privacy: 'private', device: ONLINE_READY });
  assert.equal(d.path, 'on-device');
  assert.ok(d.reasons.some((r) => /never leave this device/.test(r)));
});

test('deep-dive: needs a conversation — cloud for standard, degraded for private', () => {
  const std = decideRoute({ task: 'deep-dive', input: small, privacy: 'standard', device: ONLINE_READY });
  assert.equal(std.path, 'cloud');
  assert.ok(std.reasons.some((r) => /single-turn only/.test(r)));
  const priv = decideRoute({ task: 'deep-dive', input: small, privacy: 'private', device: ONLINE_READY });
  assert.equal(priv.path, 'degraded');
  assert.ok(priv.reasons.some((r) => /forbidden/.test(r)));
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
  assert.ok(d.reasons.some((r) => /cloud required for length/.test(r)));
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

test('toInferenceMode: PRIVATE on-device → ONLY_ON_DEVICE (execution-time privacy rule)', () => {
  // PREFER_ON_DEVICE would grant the SDK silent cloud-fallback permission —
  // for private entries that is a leak vector (model eviction mid-flight).
  // ONLY_ON_DEVICE throws instead; the provider records it as degraded.
  const d = { task: 'entry-analysis' as const, path: 'on-device' as const, reasons: [], inputChars: 0, inputTokens: 0, privacy: 'private' as const };
  assert.equal(toInferenceMode(d), 'ONLY_ON_DEVICE');
});

test('toInferenceMode: STANDARD on-device → PREFER_ON_DEVICE (cloud fallback allowed)', () => {
  const d = { task: 'entry-analysis' as const, path: 'on-device' as const, reasons: [], inputChars: 0, inputTokens: 0, privacy: 'standard' as const };
  assert.equal(toInferenceMode(d), 'PREFER_ON_DEVICE');
});

test('toInferenceMode: cloud → ONLY_IN_CLOUD, degraded → null', () => {
  assert.equal(
    toInferenceMode({ task: 'entry-analysis', path: 'cloud', reasons: [], inputChars: 0, inputTokens: 0, privacy: 'standard' }),
    'ONLY_IN_CLOUD'
  );
  assert.equal(
    toInferenceMode({ task: 'entry-analysis', path: 'degraded', reasons: [], inputChars: 0, inputTokens: 0, privacy: 'private' }),
    null
  );
});

test('on-device budgets are consistent with the documented token cap', () => {
  assert.equal(onDeviceCharBudget(), (9216 - 1200) * 4);
  assert.equal(onDeviceTokenBudget(), 9216 - 1200);
});

test('estimateTokens: English ≈ chars/4 (conservative)', () => {
  assert.equal(estimateTokens('x'.repeat(100)), 25);
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: CJK counts ~1 token per character (chars/4 would under-count)', () => {
  const cjk = '今'.repeat(4000); // 4000 chars → ~4000 tokens, not 1000
  assert.equal(estimateTokens(cjk), 4000);
});

test('CJK entry under the char threshold but over the token budget is size-routed (not leaked to on-device)', () => {
  // 30k CJK chars: under the 32k char threshold, but ~30k tokens > 8016 budget.
  const cjk = '日'.repeat(30_000);
  assert.ok(cjk.length < DEFAULT_THRESHOLDS.onDeviceMaxInputChars);
  const d = decideRoute({ task: 'entry-analysis', input: cjk, privacy: 'standard', device: ONLINE_READY });
  assert.equal(d.path, 'cloud');
  assert.ok(d.reasons.some((r) => /tokens exceeds the on-device model cap/.test(r)));
});

test('every task has a policy and every policy field is explicit', () => {
  for (const [id, p] of Object.entries(TASK_POLICIES)) {
    assert.equal(typeof p.requiresConversation, 'boolean', `${id}.requiresConversation`);
    assert.ok(['on-device', 'cloud'].includes(p.preferredPath), `${id}.preferredPath`);
  }
});
