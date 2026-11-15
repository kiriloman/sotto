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
//   R1. Task needs chat or long context  → cloud is the only capable path.
//   R2. Privacy tier 'private'           → cloud is FORBIDDEN. If on-device
//                                           can't run it, the action degrades
//                                           with a clear reason — it never
//                                           silently sends.
//   R3. Content larger than the on-device budget → cloud (if allowed).
//   R4. Offline                           → on-device only (cloud unreachable).
//   R5. On-device model unavailable       → cloud (if allowed).
//   R6. Otherwise                         → task's preferred path.

import {
  TASK_POLICIES,
  DEFAULT_THRESHOLDS,
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

  // R1 — capability wall: on-device cannot do chat or long context.
  if (policy.requiresChat || policy.requiresLongContext) {
    reasons.push(
      policy.requiresChat
        ? 'Task needs multi-turn conversation — on-device supports single-turn only'
        : 'Task needs long context — exceeds the on-device model input cap'
    );
    // R2 — private content never leaves the device. Hard rule, no fallback.
    if (req.privacy === 'private') {
      reasons.push('Entry is marked private — cloud is forbidden, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars };
    }
    if (!device.online) {
      reasons.push('Offline — cloud unreachable, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars };
    }
    return { task: req.task, path: 'cloud', reasons, inputChars };
  }

  // R2 — private content: on-device is the ONLY permitted path.
  if (req.privacy === 'private') {
    if (inputChars > thresholds.onDeviceMaxInputChars) {
      reasons.push(
        `Entry is private (cloud forbidden) and too large for on-device (${p(inputChars)} > ${p(
          thresholds.onDeviceMaxInputChars
        )}) — trim the entry or lower its privacy tier`
      );
      return { task: req.task, path: 'degraded', reasons, inputChars };
    }
    if (device.onDeviceAvailability !== 'available') {
      reasons.push(
        `Entry is private (cloud forbidden) and the on-device model is ${device.onDeviceAvailability} — this action waits until the model is ready`
      );
      return { task: req.task, path: 'degraded', reasons, inputChars };
    }
    if (!device.online) {
      reasons.push('Offline — private entries still work: running fully on-device');
    } else {
      reasons.push('Entry is private — routed to the on-device model so your words never leave this device');
    }
    return { task: req.task, path: 'on-device', reasons, inputChars };
  }

  // R3 — size: anything over the on-device budget goes to cloud.
  if (inputChars > thresholds.onDeviceMaxInputChars) {
    reasons.push(
      `Input ${p(inputChars)} exceeds the on-device budget ${p(thresholds.onDeviceMaxInputChars)} — cloud required for length`
    );
    if (!device.online) {
      reasons.push('Offline — cloud unreachable, so this action is unavailable');
      return { task: req.task, path: 'degraded', reasons, inputChars };
    }
    return { task: req.task, path: 'cloud', reasons, inputChars };
  }

  // R4 — offline: on-device is the only reachable path.
  if (!device.online) {
    if (device.onDeviceAvailability === 'available') {
      reasons.push('Offline — routed to the on-device model (journal keeps working)');
      return { task: req.task, path: 'on-device', reasons, inputChars };
    }
    reasons.push('Offline and no on-device model — this action is unavailable until you reconnect');
    return { task: req.task, path: 'degraded', reasons, inputChars };
  }

  // R5 — on-device model unavailable: fall back to cloud (privacy permitting).
  if (device.onDeviceAvailability !== 'available') {
    reasons.push(
      `On-device model is ${device.onDeviceAvailability} — falling back to cloud (entry is standard tier)`
    );
    return { task: req.task, path: 'cloud', reasons, inputChars };
  }

  // R6 — everything available: run the task's preferred path.
  if (policy.preferredPath === 'on-device') {
    reasons.push('Small, frequent, and local-first — routed to the on-device model');
    return { task: req.task, path: 'on-device', reasons, inputChars };
  }
  reasons.push('Routed to cloud per task policy');
  return { task: req.task, path: 'cloud', reasons, inputChars };
}

/** Maps a decision to the Firebase AI Logic InferenceMode string. */
export function toInferenceMode(decision: RouteDecision): 'ONLY_IN_CLOUD' | 'PREFER_ON_DEVICE' | null {
  switch (decision.path) {
    case 'cloud':
      return 'ONLY_IN_CLOUD';
    case 'on-device':
      return 'PREFER_ON_DEVICE';
    default:
      return null; // degraded — never call the SDK
  }
}
