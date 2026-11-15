// Sotto — the deterministic hybrid routing engine.
//
// Every AI action in the app passes through decideRoute() BEFORE any SDK
// call. The decision is a pure function of (task, content, privacy tier,
// device state, thresholds) — no heuristics, no magic, fully unit-tested.
// The chosen decision drives the Firebase AI Logic InferenceMode, and the
// reasons are surfaced to the user as an "inference receipt" — you always
// know where your words went and why.
//
// Routing rules, in precedence order:
//   R1. Task needs conversation history   → cloud is the only capable path.
//   R2. Privacy tier 'private'           → cloud is FORBIDDEN. If on-device
//                                           can't run it, the action degrades
//                                           with a clear reason — and at
//                                           EXECUTION time the provider uses
//                                           ONLY_ON_DEVICE, which throws
//                                           rather than silently falling
//                                           back to cloud.
//   R3. Content larger than the on-device budget → cloud (if allowed).
//   R4. Offline                           → on-device only (cloud unreachable).
//   R5. On-device model unavailable       → cloud (if allowed).
//   R6. Otherwise                         → task's preferred path.

import {
  TASK_POLICIES,
  DEFAULT_THRESHOLDS,
  estimateTokens,
  onDeviceTokenBudget,
  type TaskId,
  type PrivacyTier,
  type RoutingThresholds,
  type DeviceState,
  DEVICE_UNKNOWN,
} from './policy.ts';

export type RoutePath = 'on-device' | 'cloud' | 'degraded';

export interface RouteDecision {
  task: TaskId;
  /** Where the work will actually run. 'degraded' = cannot run at all. */
  path: RoutePath;
  /** Ordered, human-readable reasons — shown verbatim in the inference ledger. */
  reasons: string[];
  /** Approximate input size that fed the decision. */
  inputChars: number;
  /** Estimated tokens (CJK-aware) that fed the decision. */
  inputTokens: number;
  /** The privacy tier this decision must respect. */
  privacy: PrivacyTier;
}

export interface RouteRequest {
  task: TaskId;
  /** The user content that would be sent (entry body, or joined history). */
  input: string;
  privacy: PrivacyTier;
  device?: DeviceState;
  thresholds?: RoutingThresholds;
}

const p = (n: number) => `~${Math.round(n / 1000)}k chars`;

export function decideRoute(req: RouteRequest): RouteDecision {
  const policy = TASK_POLICIES[req.task];
  const device = req.device ?? DEVICE_UNKNOWN;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(req.thresholds ?? {}) };
  const reasons: string[] = [];
  const inputChars = req.input.length;
  const inputTokens = estimateTokens(req.input);
  const tokenBudget = onDeviceTokenBudget();

  const exceedsBudget =
    inputChars > thresholds.onDeviceMaxInputChars || inputTokens > tokenBudget;
  const budgetReason = inputTokens > tokenBudget
    ? `Input ~${Math.round(inputTokens / 100) / 10}k tokens exceeds the on-device model cap (~${Math.round(tokenBudget / 100) / 10}k tokens) — cloud required for length`
    : `Input ${p(inputChars)} exceeds the on-device budget ${p(thresholds.onDeviceMaxInputChars)} — cloud required for length`;

  // R1 — capability wall: on-device supports single-turn only.
  if (policy.requiresConversation) {
    reasons.push('Task keeps a conversation history — on-device inference is single-turn only');
    // R2 — private content never leaves the device. Hard rule, no fallback.
    if (req.privacy === 'private') {
      reasons.push('Entry is marked private — cloud is forbidden, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    if (!device.online) {
      reasons.push('Offline — cloud unreachable, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    return { task: req.task, path: 'cloud', reasons, inputChars, inputTokens, privacy: req.privacy };
  }

  // R2 — private content: on-device is the ONLY permitted path.
  if (req.privacy === 'private') {
    if (exceedsBudget) {
      reasons.push(budgetReason);
      reasons.push('Entry is private — cloud is forbidden; trim the entry or lower its privacy tier');
      return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    if (device.onDeviceAvailability !== 'available') {
      reasons.push(
        `Entry is private (cloud forbidden) and the on-device model is ${device.onDeviceAvailability} — this action waits until the model is ready`
      );
      return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    if (!device.online) {
      reasons.push('Offline — private entries still work: running fully on-device');
    } else {
      reasons.push('Entry is private — routed to the on-device model so your words never leave this device');
    }
    return { task: req.task, path: 'on-device', reasons, inputChars, inputTokens, privacy: req.privacy };
  }

  // R3 — size: anything over the on-device budget goes to cloud.
  if (exceedsBudget) {
    reasons.push(budgetReason);
    if (!device.online) {
      reasons.push('Offline — cloud unreachable, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    return { task: req.task, path: 'cloud', reasons, inputChars, inputTokens, privacy: req.privacy };
  }

  // R4 — offline: on-device is the only reachable path.
  if (!device.online) {
    if (device.onDeviceAvailability === 'available') {
      reasons.push('Offline — routed to the on-device model (journal keeps working)');
      return { task: req.task, path: 'on-device', reasons, inputChars, inputTokens, privacy: req.privacy };
    }
    reasons.push('Offline and no on-device model — this action is unavailable until you reconnect');
    return { task: req.task, path: 'degraded', reasons, inputChars, inputTokens, privacy: req.privacy };
  }

  // R5 — on-device model unavailable: fall back to cloud (privacy permitting).
  if (device.onDeviceAvailability !== 'available') {
    reasons.push(
      `On-device model is ${device.onDeviceAvailability} — falling back to cloud (entry is standard tier)`
    );
    return { task: req.task, path: 'cloud', reasons, inputChars, inputTokens, privacy: req.privacy };
  }

  // R6 — everything available: run the task's preferred path.
  if (policy.preferredPath === 'on-device') {
    reasons.push('Small, frequent, and local-first — routed to the on-device model');
    return { task: req.task, path: 'on-device', reasons, inputChars, inputTokens, privacy: req.privacy };
  }
  if (req.task === 'weekly-synthesis') {
    reasons.push('Synthesis prefers cloud reasoning quality over full history; a small week can still run on-device when private or offline');
  } else {
    reasons.push('Routed to cloud per task policy');
  }
  return { task: req.task, path: 'cloud', reasons, inputChars, inputTokens, privacy: req.privacy };
}

/**
 * Maps a decision to the Firebase AI Logic InferenceMode.
 *
 * CRITICAL: a private entry routed on-device must use ONLY_ON_DEVICE, which
 * THROWS if the device model can't serve the request — the SDK's
 * PREFER_ON_DEVICE mode is explicit permission to silently fall back to a
 * cloud model, which would violate the private-tier hard rule mid-flight
 * (e.g. if the model is evicted between our probe and the call). The throw
 * is caught by the provider and recorded as an honest degraded receipt.
 */
export function toInferenceMode(
  decision: RouteDecision
): 'ONLY_IN_CLOUD' | 'PREFER_ON_DEVICE' | 'ONLY_ON_DEVICE' | null {
  switch (decision.path) {
    case 'cloud':
      return 'ONLY_IN_CLOUD';
    case 'on-device':
      return decision.privacy === 'private' ? 'ONLY_ON_DEVICE' : 'PREFER_ON_DEVICE';
    default:
      return null; // degraded — never call the SDK
  }
}
