// Sotto — AI inference service.
//
// One interface, two implementations:
//  - FirebaseAiProvider: real Firebase AI Logic hybrid inference
//    (getGenerativeModel with a mode derived from the router decision).
//  - MockProvider: deterministic, clearly-labeled responses so the full app
//    runs with zero Firebase configuration (judges cloning the repo, CI,
//    offline dev). Every mock receipt is stamped mode:'demo'.
//
// The provider NEVER decides where inference runs — the router does. The
// provider only executes a RouteDecision and reports where it actually ran
// via result.response.inferenceSource (ON_DEVICE | IN_CLOUD).

import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import type { FirebaseApp } from 'firebase/app';
import { decideRoute, toInferenceMode, type RouteDecision } from '../router/engine.ts';
import type { DeviceState, RoutingThresholds, TaskId } from '../router/policy.ts';
import { buildPrompt, systemPrompt } from './prompts.ts';
import type { InferenceReceipt } from '../storage/db.ts';

export interface InferenceOutcome {
  text: string;
  decision: RouteDecision;
  receipt: Omit<InferenceReceipt, 'id' | 'at'>;
}

export interface AiProvider {
  readonly mode: 'real' | 'demo';
  /** Probe the Chrome Prompt API (LanguageModel.availability()). */
  probeDevice(): Promise<DeviceState>;
  /** Download the on-device model; call from a user gesture (Chrome requirement). */
  initializeDeviceModel(onProgress?: (pct: number) => void): Promise<void>;
  run(task: TaskId, input: string, privacy: 'private' | 'standard', opts?: {
    entryId?: string;
    extra?: string;
    thresholds?: RoutingThresholds;
  }): Promise<InferenceOutcome>;
}

export class FirebaseAiProvider implements AiProvider {
  readonly mode = 'real' as const;
  private device: DeviceState = { onDeviceAvailability: 'unavailable', online: true };
  private app: FirebaseApp | null = null;

  constructor(app: FirebaseApp | null) {
    this.app = app;
  }

  async probeDevice(): Promise<DeviceState> {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    let availability: DeviceState['onDeviceAvailability'] = 'unavailable';
    try {
      const lm = (globalThis as unknown as { LanguageModel?: { availability(): Promise<string> } }).LanguageModel;
      if (lm) {
        availability = (await lm.availability()) as DeviceState['onDeviceAvailability'];
      }
    } catch {
      availability = 'unavailable';
    }
    this.device = { onDeviceAvailability: availability, online };
    return this.device;
  }

  async initializeDeviceModel(onProgress?: (pct: number) => void): Promise<void> {
    if (!this.app) throw new Error('Firebase not configured');
    const model = this.buildModel('PREFER_ON_DEVICE');
    await model.initializeDeviceModel((pct: number) => onProgress?.(pct));
    await this.probeDevice();
  }

  async run(task: TaskId, input: string, privacy: 'private' | 'standard', opts?: {
    entryId?: string;
    extra?: string;
    thresholds?: RoutingThresholds;
  }): Promise<InferenceOutcome> {
    const decision = decideRoute({
      task,
      input,
      privacy,
      device: this.device,
      thresholds: opts?.thresholds,
    });
    if (decision.path === 'degraded' || !this.app) {
      return this.degradedOutcome(decision, task, opts?.entryId, input);
    }
    const mode = toInferenceMode(decision)!;
    const model = this.buildModel(mode);
    const prompt = buildPrompt(task, input, opts?.extra);
    const t0 = performance.now();
    let text = '';
    let inferenceSource: string | undefined;
    try {
      const result = await model.generateContent(prompt);
      text = result.response.text();
      inferenceSource = (result.response as { inferenceSource?: string }).inferenceSource;
    } catch (err) {
      // SDK failed (e.g. model unavailable despite probe) — record honestly.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        text: '',
        decision,
        receipt: {
          task,
          entryId: opts?.entryId,
          path: 'degraded',
          reasons: [...decision.reasons, `SDK error: ${reason}`],
          inputChars: input.length,
          mode: 'real',
        },
      };
    }
    const latencyMs = Math.round(performance.now() - t0);
    const actualPath: 'on-device' | 'cloud' =
      inferenceSource === 'ON_DEVICE' ? 'on-device' : 'cloud';
    return {
      text,
      decision,
      receipt: {
        task,
        entryId: opts?.entryId,
        path: actualPath, // report where it RAN, not where we asked
        reasons: decision.reasons,
        inputChars: input.length,
        latencyMs,
        inferenceSource,
        mode: 'real',
      },
    };
  }

  private buildModel(mode: 'ONLY_IN_CLOUD' | 'PREFER_ON_DEVICE') {
    const ai = getAI(this.app!, { backend: new GoogleAIBackend() });
    return getGenerativeModel(ai, {
      mode: mode === 'ONLY_IN_CLOUD' ? InferenceMode.ONLY_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          initialPrompts: [
            { role: 'system', content: [{ type: 'text', value: systemPrompt() }] },
          ],
        },
      },
    });
  }

  private degradedOutcome(decision: RouteDecision, task: TaskId, entryId: string | undefined, input: string): InferenceOutcome {
    return {
      text: '',
      decision,
      receipt: {
        task,
        entryId,
        path: 'degraded',
        reasons: decision.reasons,
        inputChars: input.length,
        mode: 'real',
      },
    };
  }
}

export class MockProvider implements AiProvider {
  readonly mode = 'demo' as const;
  private device: DeviceState = { onDeviceAvailability: 'available', online: true };

  constructor(device?: Partial<DeviceState>) {
    if (device) this.device = { ...this.device, ...device };
  }

  async probeDevice(): Promise<DeviceState> {
    return this.device;
  }

  async initializeDeviceModel(onProgress?: (pct: number) => void): Promise<void> {
    onProgress?.(1);
  }

  async run(task: TaskId, input: string, privacy: 'private' | 'standard', opts?: {
    entryId?: string;
    extra?: string;
    thresholds?: RoutingThresholds;
  }): Promise<InferenceOutcome> {
    const decision = decideRoute({ task, input, privacy, device: this.device, thresholds: opts?.thresholds });
    const latencyMs = 40 + Math.floor(Math.random() * 60);
    let text = '';
    switch (task) {
      case 'entry-analysis':
        text = JSON.stringify({
          mood: /sad|tired|hard|rough|anxious/i.test(input) ? 'low' : 'good',
          themes: ['demo', 'mock'],
          oneLineSummary: 'DEMO MODE — connect Firebase for real analysis.',
        });
        break;
      case 'title-suggest':
        text = JSON.stringify({ title: 'DEMO MODE title' });
        break;
      case 'quick-reflection':
        text = 'DEMO MODE reflection — connect Firebase for real reflections.';
        break;
      case 'weekly-synthesis':
        text = 'DEMO MODE synthesis — connect Firebase for a real week-in-review.';
        break;
      case 'deep-dive':
        text = 'DEMO MODE answer — connect Firebase for real answers.';
        break;
    }
    return {
      text,
      decision,
      receipt: {
        task,
        entryId: opts?.entryId,
        path: decision.path === 'degraded' ? 'degraded' : 'mock',
        reasons: [...decision.reasons, 'Demo mode: deterministic mock response (labeled)'],
        inputChars: input.length,
        latencyMs,
        mode: 'demo',
      },
    };
  }
}

export { InferenceMode };
