// Sotto — app shell and orchestration.
// Owns: journal store, AI provider (real Firebase AI Logic or labeled demo
// mode), device state, routing thresholds (Remote Config with local
// defaults), and the inference ledger. All AI actions flow through the
// router first; every outcome is recorded as a receipt.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { JournalStore, synthesisInput, todayISO, type JournalEntry, type InferenceReceipt } from './storage/db.ts';
import { FirebaseAiProvider, MockProvider, type AiProvider } from './ai/provider.ts';
import { parseEntryAnalysis, parseTitle, TASK_LABELS } from './ai/prompts.ts';
import { setupFirebase, thresholdsFromRemoteConfig } from './firebase/app.ts';
import { DEFAULT_THRESHOLDS, type RoutingThresholds, type DeviceState } from './router/policy.ts';
import { RouterBadge } from './ui/RouterBadge.tsx';

type Tab = 'journal' | 'week' | 'ledger';

const MOOD_EMOJI: Record<string, string> = {
  great: '🌟', good: '🙂', neutral: '😐', low: '😕', rough: '🌧️',
};

export default function App() {
  const [store] = useState(() => new JournalStore());
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [device, setDevice] = useState<DeviceState>({ onDeviceAvailability: 'unavailable', online: true });
  const [thresholds, setThresholds] = useState<RoutingThresholds>({ ...DEFAULT_THRESHOLDS });
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [receipts, setReceipts] = useState<InferenceReceipt[]>([]);
  const [tab, setTab] = useState<Tab>('journal');
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [modelInit, setModelInit] = useState(false);

  // Boot: open store, wire Firebase (or demo mode), probe device.
  useEffect(() => {
    (async () => {
      await store.open();
      setEntries(await store.listEntries());
      setReceipts(await store.listReceipts());
      const fb = setupFirebase();
      if (fb) {
        const p = new FirebaseAiProvider(fb.app);
        setProvider(p);
        setThresholds(thresholdsFromRemoteConfig(fb.remoteConfig));
      } else {
        setProvider(new MockProvider());
      }
    })();
  }, [store]);

  // Re-probe on online/offline changes.
  useEffect(() => {
    const onChange = async () => {
      if (provider) setDevice(await provider.probeDevice());
    };
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    onChange();
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }, [provider]);

  const refreshEntries = useCallback(async () => {
    setEntries(await store.listEntries());
    setReceipts(await store.listReceipts());
  }, [store]);

  const runTask = useCallback(
    async (
      task: Parameters<AiProvider['run']>[0],
      input: string,
      privacy: 'private' | 'standard',
      opts?: { entryId?: string; extra?: string }
    ) => {
      if (!provider) return { text: '' };
      const out = await provider.run(task, input, privacy, { ...opts, thresholds });
      await store.addReceipt(out.receipt);
      setReceipts(await store.listReceipts());
      return out;
    },
    [provider, store, thresholds]
  );

  const initializeModel = useCallback(async () => {
    if (!provider || provider.mode !== 'real') return;
    setDownloadPct(0);
    try {
      await provider.initializeDeviceModel((pct: number) => setDownloadPct(pct));
      setModelInit(true);
      setDevice(await provider.probeDevice());
    } finally {
      setDownloadPct(null);
    }
  }, [provider]);

  const statusLine = useMemo(() => {
    const parts: string[] = [];
    parts.push(device.online ? 'online' : 'offline');
    parts.push(`on-device model: ${device.onDeviceAvailability}`);
    parts.push(provider?.mode === 'demo' ? 'demo mode (no Firebase config)' : provider ? 'Firebase AI Logic' : '…');
    return parts;
  }, [device, provider]);

  return (
    <>
      <header className="app">
        <h1>
          Sotto <span className="quiet">a journal that thinks locally — every AI decision shows where your words went</span>
        </h1>
        <div className="status">
          {statusLine.map((s, i) => (
            <div key={i} className={s.includes('available') || s.includes('demo') ? 'ok' : s.includes('unavailable') ? 'warn' : ''}>
              {s}
            </div>
          ))}
          {provider?.mode === 'real' && device.onDeviceAvailability !== 'available' && (
            <div>
              <button className="ghost" style={{ marginTop: 6 }} onClick={initializeModel} disabled={downloadPct !== null}>
                {downloadPct !== null ? `downloading model… ${Math.round(downloadPct * 100)}%` : 'prepare on-device model'}
              </button>
            </div>
          )}
        </div>
      </header>

      {provider?.mode === 'demo' && (
        <div className="demo-banner">
          <b>Demo mode</b> — running without Firebase configuration. All routing logic is real; responses are
      labeled deterministic mocks. To go live: create a Firebase project, enable <b>AI Logic</b> (Gemini
      Developer API), register a web app, then set <code>window.__SOTTO_FIREBASE_CONFIG__</code> (see README).
        </div>
      )}

      <nav className="tabs">
        {(['journal', 'week', 'ledger'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'journal' ? 'Journal' : t === 'week' ? 'Week in review' : `Inference ledger (${receipts.length})`}
          </button>
        ))}
      </nav>

      {tab === 'journal' && (
        <>
          <EntryEditor
            onSave={async (draft) => {
              const saved = await store.saveEntry({ ...draft, date: draft.date || todayISO() });
              const out = await runTask('entry-analysis', saved.body, saved.privacy, { entryId: saved.id });
              if (out.text) {
                try {
                  const analysis = parseEntryAnalysis(out.text);
                  await store.saveEntry({ ...saved, analysis, mood: analysis.mood });
                } catch { /* analysis optional — entry already saved */ }
              }
              await refreshEntries();
            }}
            onSuggestTitle={async (body, privacy) => {
              const out = await runTask('title-suggest', body, privacy);
              if (!out.text) return '';
              try { return parseTitle(out.text); } catch { return ''; }
            }}
            device={device}
            demo={provider?.mode === 'demo'}
          />
          <EntryList
            entries={entries}
            onReflect={async (e) => {
              const out = await runTask('quick-reflection', e.body, e.privacy, { entryId: e.id });
              if (out.text) {
                await store.saveEntry({ ...e, reflection: out.text });
                await refreshEntries();
              }
            }}
            onDeepDive={async (e, question) => {
              const out = await runTask('deep-dive', e.body, e.privacy, { entryId: e.id, extra: question });
              return out.text || 'Unavailable: see the inference ledger for why.';
            }}
            onDelete={async (id) => {
              await store.deleteEntry(id);
              await refreshEntries();
            }}
            modelReady={modelInit || device.onDeviceAvailability === 'available'}
          />
        </>
      )}

      {tab === 'week' && <WeeklySynthesis entries={entries} runTask={runTask} />}

      {tab === 'ledger' && (
        <div className="panel ledger">
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Inference ledger</h2>
          <p className="hint">
            Every AI action Sotto has taken, where it ran, and why. This transparency is the point —
            a routing decision you can't audit is a routing decision you can't trust.
          </p>
          {receipts.length === 0 && <div className="empty">No AI actions yet.</div>}
          {receipts.map((r) => (
            <div className="receipt" key={r.id}>
              <div className="top">
                <div>
                  <RouterBadge path={r.path} mode={r.mode} />{' '}
                  <b>{TASK_LABELS[r.task as keyof typeof TASK_LABELS] ?? r.task}</b>
                </div>
                <span className="when">
                  {new Date(r.at).toLocaleString()} · {r.inputChars.toLocaleString()} chars
                  {r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : ''}
                  {r.inferenceSource ? ` · SDK: ${r.inferenceSource}` : ''}
                </span>
              </div>
              <ul className="reasons">
                {r.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------- Journal tab ---------- */

import { useRef, useState as useLocalState } from 'react';

interface Draft {
  title: string;
  body: string;
  privacy: 'private' | 'standard';
  date: string;
}

function EntryEditor(props: {
  onSave: (d: Draft) => Promise<void>;
  onSuggestTitle: (body: string, privacy: 'private' | 'standard') => Promise<string>;
  device: DeviceState;
  demo?: boolean;
}) {
  const [title, setTitle] = useLocalState('');
  const [body, setBody] = useLocalState('');
  const [privacy, setPrivacy] = useLocalState<'private' | 'standard'>('private');
  const [date, setDate] = useLocalState(todayISO());
  const [busy, setBusy] = useLocalState(false);
  const [saved, setSaved] = useLocalState(false);

  const canSave = body.trim().length > 0 && !busy;
  const privacyHint =
    privacy === 'private'
      ? 'Private entries never leave this device — AI runs on-device only (Chrome model required for analysis).'
      : 'Standard entries prefer on-device but may fall back to cloud Gemini when the device model is unavailable.';

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>New entry</h2>
        <div className="privacy-toggle">
          <button
            className={privacy === 'private' ? 'active-private' : ''}
            onClick={() => setPrivacy('private')}
            title="On-device only, cloud forbidden"
          >
            🔒 Private
          </button>
          <button
            className={privacy === 'standard' ? 'active-standard' : ''}
            onClick={() => setPrivacy('standard')}
            title="Prefer on-device, cloud fallback allowed"
          >
            ☁️ Standard
          </button>
        </div>
      </div>
      <div className="privacy-note">{privacyHint}</div>

      <label htmlFor="sotto-date">Date</label>
      <input id="sotto-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

      <label htmlFor="sotto-title">Title</label>
      <input
        id="sotto-title"
        type="text"
        value={title}
        placeholder="What happened today?"
        onChange={(e) => setTitle(e.target.value)}
      />

      <label htmlFor="sotto-body">Entry</label>
      <textarea
        id="sotto-body"
        value={body}
        placeholder="Write freely. Private entries are analyzed on this device only."
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="row">
        <button className="primary" disabled={!canSave} onClick={async () => {
          setBusy(true);
          try {
            await props.onSave({ title: title.trim(), body: body.trim(), privacy, date });
            setTitle(''); setBody(''); setSaved(true);
            setTimeout(() => setSaved(false), 2500);
          } finally { setBusy(false); }
        }}>
          {busy ? 'Saving & analyzing…' : 'Save entry'}
        </button>
        <button
          className="ghost"
          disabled={body.trim().length < 20 || busy}
          title="Generate a title with AI"
          onClick={async () => {
            setBusy(true);
            try {
              const t = await props.onSuggestTitle(body.trim(), privacy);
              if (t) setTitle(t);
            } finally { setBusy(false); }
          }}
        >
          Suggest title
        </button>
        {saved && <span className="hint">Saved — see the analysis chip below the entry. ✦</span>}
      </div>
    </div>
  );
}

function EntryList(props: {
  entries: JournalEntry[];
  onReflect: (e: JournalEntry) => Promise<void>;
  onDeepDive: (e: JournalEntry, q: string) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  modelReady: boolean;
}) {
  const [busyId, setBusyId] = useLocalState<string | null>(null);
  const [diveId, setDiveId] = useLocalState<string | null>(null);
  const [diveQ, setDiveQ] = useLocalState('');
  const [diveA, setDiveA] = useLocalState('');
  const diveRef = useRef<HTMLInputElement>(null);

  if (props.entries.length === 0) {
    return <div className="panel empty">Nothing here yet — your first entry is one paragraph away.</div>;
  }

  return (
    <>
      {props.entries.map((e) => (
        <article className="entry" key={e.id}>
          <header>
            <h3>{e.title || '(untitled)'}</h3>
            <span className="meta">
              {e.date} · {e.privacy === 'private' ? '🔒 private' : '☁️ standard'}
            </span>
          </header>
          <div className="body">{e.body}</div>
          {e.analysis && (
            <div className="analysis">
              <span className="mood">{MOOD_EMOJI[e.analysis.mood] ?? '😐'}</span>
              {e.analysis.oneLineSummary}
              <div className="themes">
                {e.analysis.themes.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          )}
          {e.reflection && <div className="reflection">{e.reflection}</div>}
          {diveId === e.id && diveA && <div className="analysis">{diveA}</div>}
          <div className="row">
            <button className="ghost" disabled={busyId === e.id} onClick={async () => {
              setBusyId(e.id);
              try { await props.onReflect(e); } finally { setBusyId(null); }
            }}>
              {busyId === e.id ? 'Reflecting…' : 'Reflect on this'}
            </button>
            {diveId === e.id ? (
              <>
                <input
                  ref={diveRef}
                  type="text"
                  placeholder="Ask anything about this entry…"
                  value={diveQ}
                  style={{ flex: 1, minWidth: 200 }}
                  onChange={(ev) => setDiveQ(ev.target.value)}
                  onKeyDown={async (ev) => {
                    if (ev.key === 'Enter' && diveQ.trim()) {
                      setDiveA(await props.onDeepDive(e, diveQ.trim()));
                    }
                  }}
                />
                <button
                  className="ghost"
                  disabled={!diveQ.trim()}
                  onClick={async () => setDiveA(await props.onDeepDive(e, diveQ.trim()))}
                >
                  Ask
                </button>
              </>
            ) : (
              <button className="ghost" onClick={() => { setDiveId(e.id); setDiveA(''); setDiveQ(''); setTimeout(() => diveRef.current?.focus(), 50); }}>
                Deep dive
              </button>
            )}
            <button className="ghost" style={{ marginLeft: 'auto' }} onClick={() => props.onDelete(e.id)}>Delete</button>
          </div>
        </article>
      ))}
    </>
  );
}

function WeeklySynthesis(props: {
  entries: JournalEntry[];
  runTask: (task: 'weekly-synthesis', input: string, privacy: 'private' | 'standard', opts?: { extra?: string }) => Promise<{ text: string }>;
}) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 86400_000);
  const [from, setFrom] = useLocalState(weekAgo.toISOString().slice(0, 10));
  const [to, setTo] = useLocalState(today.toISOString().slice(0, 10));
  const [privacy, setPrivacy] = useLocalState<'private' | 'standard'>('standard');
  const [result, setResult] = useLocalState('');
  const [busy, setBusy] = useLocalState(false);
  const [error, setError] = useLocalState('');

  const inRange = useMemo(
    () => props.entries.filter((e) => e.date >= from && e.date <= to),
    [props.entries, from, to]
  );
  const privateCount = inRange.filter((e) => e.privacy === 'private').length;

  const run = async () => {
    setBusy(true); setError(''); setResult('');
    try {
      const { text: joined } = synthesisInput(props.entries, from, to);
      const { text } = await props.runTask('weekly-synthesis', joined, privacy, { extra: `${from} to ${to}` });
      if (text) setResult(text);
      else setError('Synthesis unavailable — open the Inference ledger to see exactly why.');
    } finally { setBusy(false); }
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Week in review</h2>
      <p className="hint">
        Synthesis reads your full history for the period — that exceeds the on-device model's input
        cap, so it always runs in the cloud. Private entries are only included if you explicitly
        choose standard-tier synthesis; a fully-private week will simply decline.
      </p>
      <div className="row">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
        <span className="hint">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
        <div className="privacy-toggle">
          <button className={privacy === 'private' ? 'active-private' : ''} onClick={() => setPrivacy('private')}>🔒 Private only</button>
          <button className={privacy === 'standard' ? 'active-standard' : ''} onClick={() => setPrivacy('standard')}>☁️ Standard</button>
        </div>
        <button className="primary" disabled={busy || inRange.length === 0} onClick={run}>
          {busy ? 'Synthesizing…' : `Synthesize ${inRange.length} entr${inRange.length === 1 ? 'y' : 'ies'}`}
        </button>
      </div>
      {privateCount > 0 && (
        <p className="privacy-note">
          {privateCount} private {privateCount === 1 ? 'entry is' : 'entries are'} in this range — with
          “Private only” they stay on-device and synthesis will decline; with “Standard” they will be
          sent to cloud Gemini for this synthesis only.
        </p>
      )}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {result && <div className="synthesis panel" style={{ marginTop: 12 }}>{result}</div>}
      {inRange.length === 0 && <div className="empty">No entries in this range yet.</div>}
    </div>
  );
}
