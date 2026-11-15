// Sotto — routing policy: the capability table every AI task is judged against.
//
// This is the contract between the app and the Firebase AI Logic hybrid SDK:
// each task declares what it needs (single-turn? structured output? long
// context? chat?), and the router matches those needs against device state
// (on-device availability, connectivity) and the entry's privacy tier.
//
// Pure data + pure functions — no Firebase, no DOM. Unit-testable.

/** Tasks the app can run. Each maps to a prompt in ai/prompts.ts. */
export type TaskId =
  | 'entry-analysis' // mood + themes + tags for one entry (structured JSON)
  | 'title-suggest' // short title for one entry
  | 'quick-reflection' // single-paragraph reflection prompt on one entry
  | 'weekly-synthesis' // synthesis across all entries in a period
  | 'deep-dive'; // follow-up Q&A about one entry

export type PrivacyTier = 'private' | 'standard';

/**
 * Capability requirements per task.
 *
 * The on-device model (Chrome Prompt API / Gemini Nano 4, via Firebase AI
 * Logic) supports ONLY single-turn text generation — no multi-turn chat —
 * with an input cap of 9216 tokens. Tasks that need chat or long context
 * can never run on-device; the router refuses them up front instead of
 * letting the SDK fall back silently. That refusal is the product.
 */
export interface TaskPolicy {
  /** Task needs multi-turn conversation (unsupported on-device). */
  requiresChat: boolean;
  /** Task needs context longer than the on-device token cap. */
  requiresLongContext: boolean;
  /** Task output is structured JSON (supported on-device). */
  structuredOutput: boolean;
  /** Default desired path when everything is available. */
  preferredPath: 'on-device' | 'cloud';
}

export const TASK_POLICIES: Record<TaskId, TaskPolicy> = {
  'entry-analysis': {
    requiresChat: false,
    requiresLongContext: false,
    structuredOutput: true,
    preferredPath: 'on-device', // small, private, frequent — the on-device showcase
  },
  'title-suggest': {
    requiresChat: false,
    requiresLongContext: false,
    structuredOutput: true,
    preferredPath: 'on-device',
  },
  'quick-reflection': {
    requiresChat: false,
    requiresLongContext: false,
    structuredOutput: false,
    preferredPath: 'on-device',
  },
  'weekly-synthesis': {
    requiresChat: false,
    requiresLongContext: true, // full history — exceeds the 9216-token cap
    structuredOutput: false,
    preferredPath: 'cloud',
  },
  'deep-dive': {
    requiresChat: true, // follow-up questions — on-device has no chat
    requiresLongContext: false,
    structuredOutput: false,
    preferredPath: 'cloud',
  },
};

/**
 * The on-device input cap, in tokens (Chrome Prompt API limit).
 * We approximate tokens as chars/4 for English text — documented,
 * conservative (we subtract a safety margin for prompts + schema).
 */
export const ON_DEVICE_TOKEN_CAP = 9216;
export const CHARS_PER_TOKEN = 4;
/** Tokens reserved for the system prompt + output schema when budgeting. */
export const PROMPT_OVERHEAD_TOKENS = 1200;

export function onDeviceCharBudget(): number {
  return (ON_DEVICE_TOKEN_CAP - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
}

/**
 * Routing thresholds. Defaults live here; production overrides come from
 * Firebase Remote Config (see firebase/app.ts) so behavior can be tuned
 * without a redeploy. All keys documented in README.
 */
export interface RoutingThresholds {
  /** Entries (or synthesis inputs) above this many chars cannot run on-device. */
  onDeviceMaxInputChars: number;
}

export const DEFAULT_THRESHOLDS: RoutingThresholds = {
  onDeviceMaxInputChars: onDeviceCharBudget(),
};

/** Device/network state snapshot the router decides against. */
export interface DeviceState {
  /** 'available' | 'downloading' | 'downloadable' | 'unavailable' (Prompt API). */
  onDeviceAvailability: 'available' | 'downloading' | 'downloadable' | 'unavailable';
  online: boolean;
}

export const DEVICE_UNKNOWN: DeviceState = {
  onDeviceAvailability: 'unavailable',
  online: true,
};
