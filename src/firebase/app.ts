// Sotto — Firebase bootstrap.
//
// Configuration is injected at runtime (window.__SOTTO_FIREBASE_CONFIG__ or
// import.meta.env.VITE_FIREBASE_CONFIG) so the public repo ships without
// secrets and runs in demo mode with zero setup. When config is present we
// initialize: FirebaseApp → App Check (debug provider on localhost) →
// Remote Config (routing thresholds, with local defaults as fallback).

import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import {
  fetchAndActivate,
  getRemoteConfig,
  getValue,
  type RemoteConfig,
} from 'firebase/remote-config';
import { DEFAULT_THRESHOLDS, type RoutingThresholds } from '../router/policy.ts';

export interface FirebaseSetup {
  app: FirebaseApp;
  remoteConfig: RemoteConfig | null;
}

declare global {
  interface Window {
    __SOTTO_FIREBASE_CONFIG__?: Record<string, string>;
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}

export interface SottoFirebaseConfig extends FirebaseOptions {
  /** reCAPTCHA v3 site key for App Check in production deployments. */
  appCheckSiteKey?: string;
}

export function readFirebaseConfig(): SottoFirebaseConfig | null {
  const runtime = typeof window !== 'undefined' ? window.__SOTTO_FIREBASE_CONFIG__ : undefined;
  const raw = runtime ?? (import.meta.env?.VITE_FIREBASE_CONFIG as string | undefined);
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && obj.apiKey && obj.projectId) {
      return obj as SottoFirebaseConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function setupFirebase(): FirebaseSetup | null {
  const config = readFirebaseConfig();
  if (!config) return null;

  const app = initializeApp(config);

  // App Check is REQUIRED for Firebase AI Logic (enforced since Nov 2026).
  // Localhost: debug provider (console prints a token to safelist in the
  // Firebase console). Deployed origins REQUIRE a reCAPTCHA v3 site key —
  // without one, App Check breaks asynchronously (the try/catch around
  // initializeAppCheck is theater: the failure surfaces later as opaque
  // errors on every cloud inference). So we fail LOUDLY instead of pretending.
  if (typeof window !== 'undefined') {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (isLocal) {
      window.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      try {
        initializeAppCheck(app, {
          provider: new ReCaptchaV3Provider('placeholder'),
          isTokenAutoRefreshEnabled: true,
        });
      } catch (err) {
        console.error('[Sotto] App Check debug provider failed to initialize:', err);
      }
    } else if (!config.appCheckSiteKey) {
      console.error(
        '[Sotto] App Check: no appCheckSiteKey configured for a non-localhost origin. ' +
          'Firebase AI Logic requires App Check — every cloud inference will fail. ' +
          'Register a reCAPTCHA v3 site key and pass it as appCheckSiteKey in __SOTTO_FIREBASE_CONFIG__.'
      );
    } else {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(config.appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    }
  }

  let remoteConfig: RemoteConfig | null = null;
  try {
    remoteConfig = getRemoteConfig(app);
    remoteConfig.settings.minimumFetchIntervalMillis = 3600_000;
    // Note: the caller re-reads thresholds after this resolves (see App boot)
    // — first paint uses local defaults, fetched values apply as soon as they land.
  } catch {
    remoteConfig = null;
  }

  return { app, remoteConfig };
}

/** Fetch-and-activate Remote Config, then read thresholds. Resolves with
 *  local defaults when fetch fails — the app never depends on it. */
export async function activateAndReadThresholds(
  rc: RemoteConfig | null
): Promise<RoutingThresholds> {
  if (!rc) return { ...DEFAULT_THRESHOLDS };
  try {
    await fetchAndActivate(rc);
  } catch {
    // offline / not configured — fall through to defaults
  }
  return thresholdsFromRemoteConfig(rc);
}

/** Routing thresholds from Remote Config, falling back to local defaults. */
export function thresholdsFromRemoteConfig(rc: RemoteConfig | null): RoutingThresholds {
  if (!rc) return { ...DEFAULT_THRESHOLDS };
  const read = (key: string, fallback: number): number => {
    const v = getValue(rc, key).asNumber();
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    onDeviceMaxInputChars: read('sotto_on_device_max_input_chars', DEFAULT_THRESHOLDS.onDeviceMaxInputChars),
  };
}
