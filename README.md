# Sotto — a journal that thinks locally

**Google #BuildHybridAI 2026 entry.** A privacy-first journal whose AI features run **on-device when possible and in the cloud when needed — with every routing decision visible and auditable.**

Journaling is inherently private; weekly synthesis needs long-context cloud reasoning. Sotto makes that trade-off *explicit* instead of invisible: a deterministic routing engine decides where each AI action runs, and an **inference ledger** shows every decision, its reasons, where it actually executed (per the SDK's `inferenceSource`), its latency, and its size. A routing decision you can't audit is a routing decision you can't trust.

## How the workload is split (the heart of the entry)

| Task | Where it runs | Why |
|---|---|---|
| Entry analysis (mood/themes/summary, structured JSON) | 🔒 **on-device** | small, private, frequent — the on-device showcase |
| Title suggestion | 🔒 **on-device** | tiny and private |
| Quick reflection (one paragraph) | 🔒 **on-device** | single-turn, no long context |
| Weekly synthesis | ☁️ **cloud-preferred, size-measured** | prefers cloud reasoning quality; a small week that fits the on-device budget runs locally — including fully-private weeks. Private entries are excluded from standard syntheses — their per-entry 🔒 rule cannot be overridden by an aggregate toggle |
| Deep dive (follow-up Q&A) | ☁️ **cloud only** | needs multi-turn chat — unsupported on-device |
| Search/indexing | ✂️ **no AI at all** | deterministic local text processing |

The router applies, in precedence order: capability walls (conversation-requiring tasks) → **private-tier hard rule (cloud is forbidden — the action degrades with a clear reason, it never silently sends; and at execution time the provider uses `ONLY_ON_DEVICE`, which throws rather than fall back, so even a mid-flight model eviction cannot leak a private entry)** → measured size budget vs the on-device cap (chars *and* CJK-aware token estimation) → offline state → model availability → task preference. All of it is pure, deterministic, and unit-tested ([tests/router.test.ts](tests/router.test.ts)) — 39 tests covering every rule and edge case, including "private + oversized degrades rather than sends," "PRIVATE → ONLY_ON_DEVICE," "a CJK entry under the char threshold but over the token budget is size-routed," and "private entries never enter a synthesis input."

## Tech

- **Firebase AI Logic** (hybrid inference SDK): `getGenerativeModel({ mode: InferenceMode.PREFER_ON_DEVICE | ONLY_IN_CLOUD | ONLY_ON_DEVICE })` chosen per routing decision; actual execution location reported via `result.response.inferenceSource` (lowercase `'on_device' | 'in_cloud'` per the SDK typings) and surfaced in the UI. **Drift — requested vs actual path — is a first-class receipt field**, shown in red in the ledger.
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
npm test           # 39 tests: routing engine, storage, prompt parsing
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

1. Click **"Load a sample week"** (or write a private entry) → analysis chip appears with a 🔒 on-device badge (or the honest "analysis pending — never sent instead" state pre-model-download).
2. The inference ledger: task, ordered reasons, "SDK: on_device", requested-vs-actual mode, latency, drift-in-red.
3. Weekly synthesis (defaults to 🔒 private) → small week runs locally; switch to ☁️ standard → cloud badge with the honest reason; private entries are reported as excluded.
4. Kill the network → journaling, private analysis, search, and mood timeline still work (offline + on-device).
5. A private entry's cloud-only action politely declines: "private — cloud forbidden."
6. Compare moment: the same week, synthesized 🔒 private (on-device) vs ☁️ standard (cloud) — two receipts side by side in the ledger.
7. Export the full journal to JSON/Markdown — your words, yours to take.

## Repository layout

```
src/router/    engine.ts (deterministic router), policy.ts (capability table + budgets)
src/ai/        provider.ts (Firebase AI Logic + labeled mock), prompts.ts (prompts + parsing)
src/storage/   db.ts (IndexedDB, memory fallback, synthesis input builder)
src/firebase/  app.ts (config injection, App Check, Remote Config), sync.ts (opt-in Firestore sync)
src/ui/        RouterBadge.tsx (the honesty widget)
src/App.tsx    journal / week-in-review / inference-ledger tabs
tests/         router.test.ts, prompts.test.ts, storage.test.ts (39 tests)
```

## Honest limitations

- Single-platform (web/Chrome) — the on-device path requires Chrome desktop 139+; other browsers run the cloud path only.
- On-device model limits: single-turn only, 9216-token input cap, text/JPEG/PNG input.
- Token budgeting approximates: English at chars/4 (conservative) and CJK at ~1 token/char — a deliberate, tested approximation; the SDK's `measureInputUsage` would be exact but is not part of the hybrid path.
- Demo mode is clearly labeled in the UI and in every mock receipt (🧪) — never presented as real inference.
- No E2E browser tests yet — the on-device path needs Chrome 139+ and a ~2 GB model download; all routing/storage/parsing logic is unit-tested instead.
- Firestore sync ships with [firestore.rules](firestore.rules) (owner-scoped) but is not wired to a live project in this repo — that is the developer's Firebase config step.
