# Sotto — a journal that thinks locally

**Google #BuildHybridAI 2026 entry.** A privacy-first journal whose AI features run **on-device when possible and in the cloud when needed — with every routing decision visible and auditable.**

Journaling is inherently private; weekly synthesis needs long-context cloud reasoning. Sotto makes that trade-off *explicit* instead of invisible: a deterministic routing engine decides where each AI action runs, and an **inference ledger** shows every decision, its reasons, where it actually executed (per the SDK's `inferenceSource`), its latency, and its size. A routing decision you can't audit is a routing decision you can't trust.

## How the workload is split (the heart of the entry)

| Task | Where it runs | Why |
|---|---|---|
| Entry analysis (mood/themes/summary, structured JSON) | 🔒 **on-device** | small, private, frequent — the on-device showcase |
| Title suggestion | 🔒 **on-device** | tiny and private |
| Quick reflection (one paragraph) | 🔒 **on-device** | single-turn, no long context |
| Weekly synthesis (full history) | ☁️ **cloud only** | exceeds the on-device model's 9216-token input cap |
| Deep dive (follow-up Q&A) | ☁️ **cloud only** | needs multi-turn chat — unsupported on-device |
| Search/indexing | ✂️ **no AI at all** | deterministic local text processing |

The router applies, in precedence order: capability walls (chat/long-context) → **private-tier hard rule (cloud is forbidden — the action degrades with a clear reason, it never silently sends)** → size budget vs the on-device cap → offline state → model availability → task preference. All of it is pure, deterministic, and unit-tested ([tests/router.test.ts](tests/router.test.ts)) — 31 tests covering every rule and edge case, including "private + oversized degrades rather than sends."

## Tech

- **Firebase AI Logic** (hybrid inference SDK): `getGenerativeModel({ mode: InferenceMode.PREFER_ON_DEVICE | ONLY_IN_CLOUD })` chosen per routing decision; actual execution location reported via `result.response.inferenceSource` and surfaced in the UI.
- **Chrome Prompt API / Gemini Nano** for on-device inference (Chrome desktop 139+).
- **Cloud Gemini** (default `gemini-3.5-flash-lite`) for long-context synthesis and chat.
- **App Check** — required for AI Logic; debug provider on localhost, reCAPTCHA v3 site key for deployment.
- **Remote Config** — routing thresholds tunable without redeploy; local defaults in [src/router/policy.ts](src/router/policy.ts) so the app never depends on it.
- **Local-first storage** — entries live in IndexedDB; Firestore sync for standard-tier entries is a deliberate opt-in (private entries are structurally excluded).
- React 19 + TypeScript + Vite. No UI framework — hand-rolled CSS.

## Run it

```bash
npm install
npm run dev        # full app in demo mode — no Firebase needed
npm test           # 31 tests: routing engine, storage, prompt parsing
npm run build      # typecheck + production build
```

**Demo mode** runs the complete product with deterministic, clearly-labeled mock responses — the routing logic, privacy rules, and inference ledger are all real; only the model output is mocked. Judges can clone and experience the full flow with zero setup.

## Go live with Firebase (~10 minutes)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com) → **AI Services → AI Logic → Get started** (choose the Gemini Developer API — free tier).
2. Register a **Web app** and copy the config object.
3. Before `npm run dev`, set the config as a runtime global in `index.html`:

```html
<script>
  window.__SOTTO_FIREBASE_CONFIG__ = {
    apiKey: "…", authDomain: "…", projectId: "…", appId: "…"
    // optional: "appCheckSiteKey": "…" (reCAPTCHA v3) for non-localhost
  };
</script>
```

4. On localhost, open DevTools: the App Check debug provider prints a token — register it under **Security → App Check → Manage debug tokens**.
5. In Chrome, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, restart, and click **"prepare on-device model"** in Sotto's header (needs ~2 GB download and ≥22 GB free disk).
6. Write an entry marked 🔒 **Private** — its analysis runs on-device. Write a **Week in review** — it runs in cloud. The inference ledger shows both, with reasons.

## What the demo shows (3-minute video script)

1. Write a private entry → analysis chip appears with a 🔒 on-device badge.
2. The inference ledger: task, reasons, "SDK: ON_DEVICE", latency.
3. Weekly synthesis → ☁️ cloud badge + reason ("exceeds the on-device model input cap").
4. Kill the network → journaling and private-entry analysis still work (offline + on-device).
5. A private entry's cloud-only action politely refuses: "private — cloud forbidden."

## Repository layout

```
src/router/    engine.ts (deterministic router), policy.ts (capability table + budgets)
src/ai/        provider.ts (Firebase AI Logic + labeled mock), prompts.ts (prompts + parsing)
src/storage/   db.ts (IndexedDB, memory fallback, synthesis input builder)
src/firebase/  app.ts (config injection, App Check, Remote Config), sync.ts (opt-in Firestore sync)
src/ui/        RouterBadge.tsx (the honesty widget)
src/App.tsx    journal / week-in-review / inference-ledger tabs
tests/         router.test.ts, prompts.test.ts, storage.test.ts (37 tests)
```

## Honest limitations

- Single-platform (web/Chrome) — the on-device path requires Chrome desktop 139+; other browsers run the cloud path only.
- On-device model limits: single-turn only, 9216-token input cap, text/JPEG/PNG input.
- The token budget uses a chars-per-token approximation (conservative, documented in [policy.ts](src/router/policy.ts)).
- Demo mode is clearly labeled in the UI and in every mock receipt — never presented as real inference.
