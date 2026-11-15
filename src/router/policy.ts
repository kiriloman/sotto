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
  | 'weekly-synthesis' // synthesis across entries in a period
  | 'deep-dive'; // conversation about one entry (history-aware Q&A)

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
  /** Task maintains a conversation history — on-device supports single-turn only. */
  requiresConversation: boolean;
  /** Task's desired path when everything is available. Long inputs are still
   *  size-routed by the engine (a small week can run fully on-device). */
  preferredPath: 'on-device' | 'cloud';
}

export const TASK_POLICIES: Record<TaskId, TaskPolicy> = {
  'entry-analysis': { requiresConversation: false, preferredPath: 'on-device' },
  'title-suggest': { requiresConversation: false, preferredPath: 'on-device' },
  'quick-reflection': { requiresConversation: false, preferredPath: 'on-device' },
  // Synthesis prefers cloud for reasoning quality over full history, but the
  // engine decides by measured input size: a small week fits on-device (and a
  // fully-private small week then synthesizes locally — a feature, not a bug).
  'weekly-synthesis': { requiresConversation: false, preferredPath: 'cloud' },
  // Deep dive is genuinely conversational: each answer is fed back as history
  // for the next question (see ai/prompts.ts buildPrompt + App deepDive state).
  'deep-dive': { requiresConversation: true, preferredPath: 'cloud' },
};

/**
 * The on-device input cap, in tokens (Chrome Prompt API limit).
 * We approximate tokens as chars/4 for English text — documented,
 * conservative (we subtract a safety margin for prompts + schema).
 */
export const ON_DEVICE_TOKEN_CAP = 9216;
export const CHARS_PER_TOKEN = 4;
/** Tokens reserved for the system prompt + output when budgeting. */
export const PROMPT_OVERHEAD_TOKENS = 1200;

export function onDeviceCharBudget(): number {
  return (ON_DEVICE_TOKEN_CAP - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
}

export function onDeviceTokenBudget(): number {
  return ON_DEVICE_TOKEN_CAP - PROMPT_OVERHEAD_TOKENS;
}

/**
 * Conservative token estimate. English ≈ chars/4 (over-estimates — safe),
 * but CJK text runs ~1 token per character, so a 10k-char Chinese entry
 * would blow the real on-device cap while passing a naive chars/4 check.
 * CJK/fullwidth chars are counted as one token each (reviewer-verified fix).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana/Katakana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0xff00 && code <= 0xffef); // Fullwidth forms
    tokens += isCJK ? 1 : 0.25;
  }
  return Math.ceil(tokens);
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
