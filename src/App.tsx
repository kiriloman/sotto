// Sotto — app shell and orchestration.
// Owns: journal store, AI provider (real Firebase AI Logic or labeled demo
// mode), device state (single source: provider.probeDevice), routing
// thresholds (Remote Config with local defaults), and the inference ledger.
// All AI actions flow through the router first; every outcome is recorded as
// a receipt, and every surfaced AI action carries a path badge.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  JournalStore,
  synthesisInput,
  todayISO,
  type JournalEntry,
  type InferenceReceipt,
} from './storage/db.ts';
import type { AiProvider, RunOptions } from './ai/provider.ts';
import { parseEntryAnalysis, parseTitle, TASK_LABELS, type DeepDiveTurn } from './ai/prompts.ts';
import type { EntrySync } from './firebase/sync.ts';
import { DEFAULT_THRESHOLDS, type RoutingThresholds, type DeviceState } from './router/policy.ts';
import { RouterBadge } from './ui/RouterBadge.tsx';

type Tab = 'journal' | 'week' | 'ledger';

const MOOD_EMOJI: Record<string, string> = {
  great: '🌟', good: '🙂', neutral: '😐', low: '😕', rough: '🌧️',
};

export default function App() {
  const [store] = useState(() => new JournalStore());
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sync, setSync] = useState<EntrySync | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [device, setDevice] = useState<DeviceState>({ onDeviceAvailability: 'unavailable', online: true });
  const [thresholds, setThresholds] = useState<RoutingThresholds>({ ...DEFAULT_THRESHOLDS });
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [receipts, setReceipts] = useState<InferenceReceipt[]>([]);
  const [tab, setTab] = useState<Tab>('journal');
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [initError, setInitError] = useState('');
  const [search, setSearch] = useState('');

  // Boot: open store, wire Firebase (or demo mode), probe device.
  // The Firebase + AI SDK load in an async chunk so the journal paints first —
  // a journaling app shouldn't wait on an 800 kB SDK to show an editor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await store.open();
      if (cancelled) return;
      setEntries(await store.listEntries());
      setReceipts(await store.listReceipts());
      const [{ setupFirebase, activateAndReadThresholds }, { FirebaseAiProvider, MockProvider }, { EntrySync: EntrySyncImpl }] =
        await Promise.all([import('./firebase/app.ts'), import('./ai/provider.ts'), import('./firebase/sync.ts')]);
      if (cancelled) return;
      const fb = setupFirebase();
      if (fb) {
        const p = new FirebaseAiProvider(fb.app);
        setProvider(p);
        setDevice(await p.probeDevice());
        const s = new EntrySyncImpl(fb.app);
        setSync(s);
        void s.start();
        // Remote Config: first paint uses local defaults; fetched values
        // apply as soon as the fetch resolves.
        void activateAndReadThresholds(fb.remoteConfig).then(setThresholds);
      } else {
        setProvider(new MockProvider());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // Re-probe on online/offline changes (the provider also re-probes before
  // every decision — this keeps the header status fresh).
  useEffect(() => {
    const onChange = async () => {
      if (provider) setDevice(await provider.probeDevice());
    };
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
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
    async (task: Parameters<AiProvider['run']>[0], input: string, privacy: 'private' | 'standard', opts?: RunOptions) => {
      if (!provider) return { text: '', receipt: null };
      const out = await provider.run(task, input, privacy, { ...opts, thresholds });
      await store.addReceipt(out.receipt);
      setReceipts(await store.listReceipts());
      return { text: out.text, receipt: out.receipt };
    },
    [provider, store, thresholds]
  );

  const maybeSync = useCallback(
    async (entry: JournalEntry) => {
      if (syncEnabled && sync) {
        const result = await sync.syncEntry(entry);
        if (result === 'skipped-private') {
          console.info('[Sotto] private entry not synced (structurally excluded)');
        }
      }
    },
    [sync, syncEnabled]
  );

  const initializeModel = useCallback(async () => {
    if (!provider || provider.mode !== 'real') return;
    setInitError('');
    setDownloadPct(0);
    try {
      await provider.initializeDeviceModel((pct: number) => setDownloadPct(pct));
      setDevice(await provider.probeDevice());
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadPct(null);
    }
  }, [provider]);

  const statusLine = useMemo(() => {
    const parts: string[] = [];
    parts.push(device.online ? 'online' : 'offline');
    parts.push(`on-device model: ${device.onDeviceAvailability}`);
    parts.push(
      provider?.mode === 'demo' ? 'demo mode (no Firebase config)' : provider ? 'Firebase AI Logic' : '…'
    );
    return parts;
  }, [device, provider]);

  return (
    <>
      <header className="app">
        <h1>
          Sotto{' '}
          <span className="quiet">
            a journal that thinks locally — every AI decision shows where your words went
          </span>
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
              {initError && <div className="warn" style={{ marginTop: 4, maxWidth: 260 }}>{initError}</div>}
            </div>
          )}
        </div>
      </header>

      {provider?.mode === 'demo' && (
        <div className="demo-banner">
          <b>Demo mode</b> — running without Firebase configuration. All routing logic, privacy rules, and
          the inference ledger are real; responses are deterministic mocks marked 🧪. To go live: create
          a Firebase project, enable <b>AI Logic</b> (Gemini Developer API), register a web app, then set{' '}
          <code>window.__SOTTO_FIREBASE_CONFIG__</code> (see README).
        </div>
      )}

      <nav className="tabs">
        {(['journal', 'week', 'ledger'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'journal' ? 'Journal' : t === 'week' ? 'Week in review' : `Inference ledger (${receipts.length})`}
          </button>
        ))}
        <label className="sync-toggle" title="Opt-in Firestore sync for standard-tier entries (private entries are structurally excluded)">
          <input
            type="checkbox"
            checked={syncEnabled}
            disabled={!sync}
            onChange={(e) => setSyncEnabled(e.target.checked)}
          />{' '}
          cloud backup (standard entries)
        </label>
      </nav>

      {tab === 'journal' && (
        <>
          <EntryEditor
            onSave={async (draft) => {
              const saved = await store.saveEntry({ ...draft, date: draft.date || todayISO() });
              const out = await runTask('entry-analysis', saved.body, saved.privacy, { entryId: saved.id });
              let final = saved;
              if (out.text) {
                try {
                  const analysis = parseEntryAnalysis(out.text);
                  final = await store.saveEntry({ ...saved, analysis, mood: analysis.mood });
                } catch {
                  /* entry is saved regardless; analysis is best-effort */
                }
              }
              await maybeSync(final); // sync AFTER analysis is persisted — no stale cloud copy
              await refreshEntries();
            }}
            onSuggestTitle={async (body, privacy) => {
              const out = await runTask('title-suggest', body, privacy);
              if (!out.text) return '';
              try {
                return parseTitle(out.text);
              } catch {
                return '';
              }
            }}
          />
          <div className="search-row">
            <input
              type="text"
              placeholder="Search entries (local, no AI)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search entries"
            />
          </div>
          <EntryList
            entries={filterEntries(entries, search)}
            onReflect={async (e) => {
              const out = await runTask('quick-reflection', e.body, e.privacy, { entryId: e.id });
              if (out.text) {
                await store.saveEntry({ ...e, reflection: out.text });
                await maybeSync({ ...e, reflection: out.text });
              }
              await refreshEntries();
              return out.receipt ? out.receipt.path : null;
            }}
            onDeepDive={async (e, question, history) => {
              const out = await runTask('deep-dive', e.body, e.privacy, {
                entryId: e.id,
                extra: question,
                history: history.map((t) => ({ q: t.q, a: t.a })),
              });
              return { text: out.text, path: out.receipt ? out.receipt.path : null };
            }}
            onSaveDeepDive={async (e, turns) => {
              await store.saveEntry({ ...e, deepDive: turns });
              await refreshEntries();
            }}
            onEdit={async (e) => {
              await store.saveEntry(e);
              await maybeSync(e); // re-sync on edit — no stale cloud copy
              await refreshEntries();
            }}
            onReanalyze={async (e) => {
              const out = await runTask('entry-analysis', e.body, e.privacy, { entryId: e.id });
              if (out.text) {
                try {
                  const analysis = parseEntryAnalysis(out.text);
                  await store.saveEntry({ ...e, analysis, mood: analysis.mood });
                } catch {
                  /* keep old analysis on parse failure */
                }
              }
              await refreshEntries();
            }}
            onDelete={async (id) => {
              await store.deleteEntry(id);
              if (sync) await sync.removeEntry(id);
              await refreshEntries();
            }}
            device={device}
            onPrepareModel={initializeModel}
            allEntries={entries}
            searchQuery={search}
            onSampleWeek={async (week) => {
              for (const d of week) {
                await store.saveEntry(d);
              }
              await refreshEntries();
            }}
          />
        </>
      )}

      {tab === 'week' && <WeeklySynthesis entries={entries} runTask={runTask} device={device} />}

      {tab === 'ledger' && (
        <div className="panel ledger">
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Inference ledger</h2>
          <p className="hint">
            Every AI action Sotto has taken, where it ran, and why — including the <b>requested</b> path
            versus where the SDK <b>actually</b> served it (drift shows in red). This transparency is the
            point: a routing decision you can't audit is a routing decision you can't trust.
          </p>
          {receipts.length === 0 && <div className="empty">No AI actions yet.</div>}
          {receipts.map((r) => (
            <div className={`receipt${r.drifted ? ' drifted' : ''}`} key={r.id}>
              <div className="top">
                <div>
                  <RouterBadge path={r.path} mode={r.mode} />{' '}
                  <b>{TASK_LABELS[r.task as keyof typeof TASK_LABELS] ?? r.task}</b>
                  {r.drifted && <span className="drift-tag"> requested {r.requestedPath} → served {r.path}</span>}
                </div>
                <span className="when">
                  {new Date(r.at).toLocaleString()} · {r.inputChars.toLocaleString()} chars
                  {r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : ''}
                  {r.inferenceSource ? ` · SDK: ${r.inferenceSource}` : ''}
                  {r.requestedMode ? ` · mode: ${r.requestedMode}` : ''}
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

/** Local, deterministic search — no AI involved (by design; see README). */
function filterEntries(entries: JournalEntry[], query: string): JournalEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const hay = `${e.title}\n${e.body}\n${e.analysis?.themes.join(' ') ?? ''}\n${e.reflection ?? ''}`;
    return hay.toLowerCase().includes(q);
  });
}

function daysAgoISO(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}

/* ---------- Journal tab ---------- */

interface Draft {
  title: string;
  body: string;
  privacy: 'private' | 'standard';
  date: string;
}

function EntryEditor(props: {
  onSave: (d: Draft) => Promise<void>;
  onSuggestTitle: (body: string, privacy: 'private' | 'standard') => Promise<string>;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'standard'>('private');
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const canSave = body.trim().length > 0 && !busy;
  const privacyHint =
    privacy === 'private'
      ? 'Private: analysis runs ONLY on this device. Until the on-device model is ready (Chrome 139+, one-time ~2 GB download), private AI features politely wait — they never send.'
      : 'Standard: analysis prefers the on-device model; if unavailable, it falls back to cloud Gemini with your knowledge.';

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
        <button
          className="primary"
          disabled={!canSave}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onSave({ title: title.trim(), body: body.trim(), privacy, date });
              setTitle('');
              setBody('');
              setSaved(true);
              setTimeout(() => setSaved(false), 2500);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving & analyzing…' : 'Save entry'}
        </button>
        <button
          className="ghost"
          disabled={body.trim().length < 20 || busy}
          title="Generate a title with AI (routed per your privacy tier)"
          onClick={async () => {
            setBusy(true);
            try {
              const t = await props.onSuggestTitle(body.trim(), privacy);
              if (t) setTitle(t);
            } finally {
              setBusy(false);
            }
          }}
        >
          Suggest title
        </button>
        {saved && <span className="hint">Saved. ✦</span>}
      </div>
    </div>
  );
}

function EntryList(props: {
  entries: JournalEntry[];
  onReflect: (e: JournalEntry) => Promise<'on-device' | 'cloud' | 'degraded' | 'mock' | 'unknown' | null>;
  onDeepDive: (
    e: JournalEntry,
    question: string,
    history: DeepDiveTurn[]
  ) => Promise<{ text: string; path: 'on-device' | 'cloud' | 'degraded' | 'mock' | 'unknown' | null }>;
  onSaveDeepDive: (e: JournalEntry, turns: DeepDiveTurn[]) => Promise<void>;
  onEdit: (e: JournalEntry) => Promise<void>;
  onReanalyze: (e: JournalEntry) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  device: DeviceState;
  onPrepareModel: () => Promise<void>;
  /** The FULL journal for exports — never the search-filtered subset. */
  allEntries: JournalEntry[];
  /** Current search query — to distinguish 'no entries' from 'no matches'. */
  searchQuery: string;
  /** Load a clearly-labeled sample week (demo/first-run helper). */
  onSampleWeek: (week: Omit<JournalEntry, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diveId, setDiveId] = useState<string | null>(null);
  const [diveQ, setDiveQ] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editPrivacy, setEditPrivacy] = useState<'private' | 'standard'>('private');
  // Receipt-path badges: what the receipt SAID, not what the privacy tier implies.
  const [reflectBadge, setReflectBadge] = useState<Record<string, string | null>>({});
  const [diveBadge, setDiveBadge] = useState<Record<string, string | null>>({});

  const sampleWeek = useMemo(
    () => [
      { date: daysAgoISO(6), title: 'Slow start', body: 'Woke up heavy, dragged myself through the morning. Coffee helped more than it should. Work was a blur of small tasks that never ended.', privacy: 'private' as const },
      { date: daysAgoISO(5), title: 'Better shape', body: 'Slept well. Had a good focus block before lunch and finally closed the thing I had been avoiding. Evening walk cleared my head.', privacy: 'private' as const },
      { date: daysAgoISO(4), title: 'Family dinner', body: 'Long dinner with everyone at the table. Loud, warm, a bit tiring — the good kind. Noticed how much lighter the mood has been lately.', privacy: 'standard' as const },
      { date: daysAgoISO(3), title: 'Tired but proud', body: 'Shipped the project milestone. Exhausted, but proud of how the team held together when the demo almost broke. Slept early.', privacy: 'standard' as const },
      { date: daysAgoISO(2), title: 'Quiet day', body: 'Nothing dramatic. Read, ran errands, called mom. Energy steady. These are the days I used to skip writing about.', privacy: 'private' as const },
      { date: daysAgoISO(1), title: 'Ideas returning', body: 'Curiosity is back — a long list of things I want to learn next month. Great to feel excited about something again.', privacy: 'private' as const },
    ],
    []
  );

  if (props.entries.length === 0) {
    return (
      <>
        <div className="panel empty">
          {props.searchQuery
            ? `No entries match “${props.searchQuery}” — try a different word, or clear the search.`
            : 'Nothing here yet — your first entry is one paragraph away.'}
          {!props.searchQuery && props.allEntries.length === 0 && (
            <div style={{ marginTop: 12 }}>
              <button className="ghost" onClick={() => void props.onSampleWeek(sampleWeek)}>
                Load a sample week (6 entries, deletable — great for seeing the full flow)
              </button>
            </div>
          )}
        </div>
        <ExportBar entries={props.allEntries} />
      </>
    );
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

          {editId === e.id ? (
            <>
              <label>Editing — title</label>
              <input type="text" value={editTitle} onChange={(ev) => setEditTitle(ev.target.value)} />
              <label>Editing — entry</label>
              <textarea value={editBody} onChange={(ev) => setEditBody(ev.target.value)} />
              <div className="row">
                <div className="privacy-toggle">
                  <button
                    className={editPrivacy === 'private' ? 'active-private' : ''}
                    onClick={() => setEditPrivacy('private')}
                    title="On-device only, cloud forbidden"
                  >
                    🔒 Private
                  </button>
                  <button
                    className={editPrivacy === 'standard' ? 'active-standard' : ''}
                    onClick={() => setEditPrivacy('standard')}
                    title="Prefer on-device, cloud fallback allowed"
                  >
                    ☁️ Standard
                  </button>
                </div>
                <button
                  className="primary"
                  onClick={async () => {
                    await props.onEdit({
                      ...e,
                      title: editTitle.trim() || e.title,
                      body: editBody.trim() || e.body,
                      privacy: editPrivacy,
                    });
                    setEditId(null);
                  }}
                >
                  Save changes
                </button>
                <button className="ghost" onClick={() => setEditId(null)}>
                  Cancel
                </button>
                <span className="hint">Changing privacy applies to future AI actions on this entry.</span>
              </div>
            </>
          ) : (
            <>
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

              {!e.analysis && e.privacy === 'private' && props.device.onDeviceAvailability !== 'available' && (
                <div className="analysis pending">
                  🔒 Analysis pending — the on-device model isn't ready yet, and a private entry will
                  never be sent to the cloud instead.{' '}
                  <button className="linkish" onClick={props.onPrepareModel}>
                    Prepare the on-device model
                  </button>{' '}
                  (one-time ~2 GB download).
                </div>
              )}

              {e.reflection ? (
                <div className="reflection">
                  {e.reflection}
                  <div style={{ marginTop: 6 }}>
                    {reflectBadge[e.id] ? (
                      <RouterBadge path={reflectBadge[e.id] as string} />
                    ) : (
                      <span className="hint">path recorded in the inference ledger</span>
                    )}
                  </div>
                </div>
              ) : null}

              {diveId === e.id && (
                <div className="analysis">
                  {e.deepDive?.map((t, i) => (
                    <div key={i} className="dive-turn">
                      <div className="q">Q: {t.q}</div>
                      <div className="a">{t.a}</div>
                    </div>
                  ))}
                  <div className="row" style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      placeholder="Ask anything about this entry…"
                      value={diveQ}
                      style={{ flex: 1, minWidth: 200 }}
                      onChange={(ev) => setDiveQ(ev.target.value)}
                      onKeyDown={async (ev) => {
                        if (ev.key === 'Enter' && diveQ.trim() && busyId !== e.id) {
                          setBusyId(e.id);
                          try {
                            const { text, path } = await props.onDeepDive(e, diveQ.trim(), e.deepDive ?? []);
                            if (text) {
                              await props.onSaveDeepDive(e, [...(e.deepDive ?? []), { q: diveQ.trim(), a: text, at: Date.now() }]);
                              setDiveBadge((b) => ({ ...b, [e.id]: path }));
                              setDiveQ('');
                            }
                          } finally {
                            setBusyId(null);
                          }
                        }
                      }}
                    />
                    <button
                      className="ghost"
                      disabled={!diveQ.trim() || busyId === e.id}
                      onClick={async () => {
                        setBusyId(e.id);
                        try {
                          const { text, path } = await props.onDeepDive(e, diveQ.trim(), e.deepDive ?? []);
                          if (text) {
                            await props.onSaveDeepDive(e, [...(e.deepDive ?? []), { q: diveQ.trim(), a: text, at: Date.now() }]);
                            setDiveBadge((b) => ({ ...b, [e.id]: path }));
                            setDiveQ('');
                          }
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      Ask
                    </button>
                    {diveBadge[e.id] && <RouterBadge path={diveBadge[e.id] as string} />}
                  </div>
                  {e.privacy === 'private' && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      Deep dive keeps a conversation — cloud only. A private entry's deep dive politely
                      declines; switch the entry to standard to enable it.
                    </div>
                  )}
                </div>
              )}

              <div className="row">
                <button
                  className="ghost"
                  disabled={busyId === e.id}
                  onClick={async () => {
                    setBusyId(e.id);
                    try {
                      const path = await props.onReflect(e);
                      if (path) setReflectBadge((b) => ({ ...b, [e.id]: path }));
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  {busyId === e.id ? 'Reflecting…' : e.reflection ? 'Reflect again' : 'Reflect on this'}
                </button>
                {diveId === e.id ? (
                  <button className="ghost" onClick={() => setDiveId(null)}>
                    Close dive
                  </button>
                ) : (
                  <button className="ghost" onClick={() => { setDiveId(e.id); setDiveQ(''); }}>
                    Deep dive {e.deepDive?.length ? `(${e.deepDive.length})` : ''}
                  </button>
                )}
                <button
                  className="ghost"
                  onClick={() => {
                    setEditId(e.id);
                    setEditTitle(e.title);
                    setEditBody(e.body);
                    setEditPrivacy(e.privacy);
                  }}
                >
                  Edit
                </button>
                {e.analysis && (
                  <button className="ghost" disabled={busyId === e.id} onClick={() => void props.onReanalyze(e)}>
                    Re-analyze
                  </button>
                )}
                {confirmId === e.id ? (
                  <>
                    <button className="ghost danger" onClick={() => { void props.onDelete(e.id); setConfirmId(null); }}>
                      Confirm delete
                    </button>
                    <button className="ghost" onClick={() => setConfirmId(null)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="ghost" style={{ marginLeft: 'auto' }} onClick={() => setConfirmId(e.id)}>
                    Delete
                  </button>
                )}
              </div>
            </>
          )}
        </article>
      ))}
      <ExportBar entries={props.allEntries} />
    </>
  );
}

/** Export bar — ALWAYS exports the full journal, never the search-filtered
 *  subset (a silent partial export is a data-loss footgun for the 'your
 *  words, yours to take' promise). The parent passes ALL entries separately
 *  from the filtered list it renders. */
function ExportBar(props: { entries: JournalEntry[] }) {
  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const md = () =>
    props.entries
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((e) => {
        const mood = e.analysis ? ` · ${e.analysis.mood}` : '';
        const themes = e.analysis?.themes.length ? ` · ${e.analysis.themes.join(', ')}` : '';
        const dive = (e.deepDive ?? [])
          .map((t) => `\n**Q:** ${t.q}\n**A:** ${t.a}`)
          .join('\n');
        return (
          `# ${e.date} — ${e.title || '(untitled)'} (${e.privacy}${mood}${themes})\n\n${e.body}` +
          (e.reflection ? `\n> ${e.reflection}\n` : '') +
          (dive ? `\n## Conversation\n${dive}\n` : '')
        );
      })
      .join('\n---\n\n');
  return (
    <div className="row" style={{ justifyContent: 'center' }}>
      <span className="hint">Your words, yours to take (exports the full journal):</span>
      <button className="ghost" onClick={() => download(JSON.stringify(props.entries, null, 2), 'sotto-journal.json', 'application/json')}>
        Export JSON
      </button>
      <button className="ghost" onClick={() => download(md(), 'sotto-journal.md', 'text/markdown')}>
        Export Markdown
      </button>
    </div>
  );
}

function WeeklySynthesis(props: {
  entries: JournalEntry[];
  runTask: (
    task: 'weekly-synthesis',
    input: string,
    privacy: 'private' | 'standard',
    opts?: { extra?: string }
  ) => Promise<{ text: string; receipt: { path: string } | null }>;
  device: DeviceState;
}) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 86400_000);
  const [from, setFrom] = useState(weekAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  // Safe default: 'private' = this synthesis never sends to cloud. The user
  // must explicitly choose standard to allow entries to leave the device —
  // and even then, PRIVATE entries are excluded from the input (their
  // per-entry hard rule cannot be overridden by a synthesis toggle).
  const [privacy, setPrivacy] = useState<'private' | 'standard'>('private');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [badge, setBadge] = useState<string | null>(null);
  const [excludedNote, setExcludedNote] = useState('');

  const inRange = useMemo(() => props.entries.filter((e) => e.date >= from && e.date <= to), [props.entries, from, to]);
  const privateCount = inRange.filter((e) => e.privacy === 'private').length;

  // No-AI mood timeline — deterministic, local, free.
  const moodTimeline = useMemo(
    () =>
      inRange
        .filter((e) => e.mood)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((e) => ({ date: e.date, mood: e.mood!, emoji: MOOD_EMOJI[e.mood!] ?? '😐' })),
    [inRange]
  );
  const streak = useMemo(() => {
    const dates = new Set(props.entries.map((e) => e.date));
    let n = 0;
    const d = new Date();
    while (dates.has(d.toISOString().slice(0, 10))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }, [props.entries]);

  const run = async () => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      // Private entries are structurally excluded from a standard synthesis —
      // the per-entry hard rule cannot be overridden by an aggregate toggle.
      const { text: joined, excludedPrivate } = synthesisInput(props.entries, from, to, {
        // Private-tier synthesis INCLUDES private entries — it routes on-device
        // or degrades, never cloud, so the input can safely contain them.
        // Standard-tier synthesis excludes them (per-entry hard rule).
        includePrivate: privacy === 'private',
      });
      setExcludedNote(
        excludedPrivate > 0
          ? `${excludedPrivate} private ${excludedPrivate === 1 ? 'entry was' : 'entries were'} kept on this device and excluded from the synthesis — their 🔒 rule is not overridden by this toggle.`
          : ''
      );
      const out = await props.runTask('weekly-synthesis', joined, privacy, { extra: `${from} to ${to}` });
      if (out.text) setResult(out.text);
      else setError('Synthesis unavailable — open the Inference ledger to see exactly why.');
      setBadge(out.receipt ? out.receipt.path : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Week in review</h2>
      <p className="hint">
        Synthesis reads your history for the period and prefers cloud reasoning quality — but a
        small week that fits the on-device model runs locally when you choose Private only. Private
        entries are always excluded from a Standard synthesis: their 🔒 per-entry rule cannot be
        overridden by this toggle, no matter what you pick here.
      </p>

      {moodTimeline.length > 0 && (
        <div className="mood-timeline" aria-label="Mood timeline (deterministic, no AI)">
          <span className="hint">Mood this week:</span>{' '}
          {moodTimeline.map((m) => (
            <span key={m.date} title={`${m.date} — ${m.mood}`}>
              {m.emoji}
            </span>
          ))}
          {streak > 1 && <span className="hint" style={{ marginLeft: 8 }}>🔥 {streak}-day streak</span>}
        </div>
      )}

      <div className="row">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
        <span className="hint">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
        <div className="privacy-toggle">
          <button className={privacy === 'private' ? 'active-private' : ''} onClick={() => setPrivacy('private')} title="Never sends to cloud">
            🔒 Private only
          </button>
          <button className={privacy === 'standard' ? 'active-standard' : ''} onClick={() => setPrivacy('standard')} title="May send entries to cloud Gemini">
            ☁️ Standard
          </button>
        </div>
        <button className="primary" disabled={busy || inRange.length === 0} onClick={run}>
          {busy ? 'Synthesizing…' : `Synthesize ${inRange.length} entr${inRange.length === 1 ? 'y' : 'ies'}`}
        </button>
      </div>
      {privateCount > 0 && (
        <p className="privacy-note">
          {privateCount} private {privateCount === 1 ? 'entry is' : 'entries are'} in this range. Private
          entries always stay on this device — a Standard synthesis includes only your standard
          entries; “🔒 Private only” runs the whole synthesis on-device (small week) or declines.
        </p>
      )}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {result && (
        <div className="synthesis panel" style={{ marginTop: 12 }}>
          {result}
          <div style={{ marginTop: 8 }}>
            {badge ? <RouterBadge path={badge} /> : <span className="hint">path recorded in the inference ledger</span>}
          </div>
        </div>
      )}
      {excludedNote && <p className="privacy-note">{excludedNote}</p>}
      {inRange.length === 0 && <div className="empty">No entries in this range yet.</div>}
    </div>
  );
}
