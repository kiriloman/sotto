// Sotto — local-first journal storage.
//
// Entries live in IndexedDB on the user's device, always. Firestore sync is
// a separate opt-in layer for standard-tier entries only (see firebase/sync.ts)
// — private entries are structurally excluded from it.
//
// The store is a small class with an in-memory fallback (used in tests and
// when IndexedDB is unavailable). Pure data layer: no UI, no AI.

import type { PrivacyTier } from '../router/policy.ts';

export interface JournalEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  date: string; // YYYY-MM-DD, journaling day
  title: string;
  body: string;
  privacy: PrivacyTier;
  mood?: string; // from entry analysis, if analyzed
  analysis?: { mood: string; themes: string[]; oneLineSummary: string };
  reflection?: string; // quick-reflection output, if generated
}

export interface InferenceReceipt {
  id: string;
  at: number;
  task: string;
  entryId?: string;
  path: 'on-device' | 'cloud' | 'degraded' | 'mock';
  reasons: string[];
  inputChars: number;
  latencyMs?: number;
  inferenceSource?: string; // SDK-reported: ON_DEVICE | IN_CLOUD
  mode: 'real' | 'demo'; // real Firebase AI Logic vs labeled mock
}

const DB_NAME = 'sotto-journal';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const RECEIPTS_STORE = 'receipts';

function uid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export class JournalStore {
  private db: IDBDatabase | null = null;
  private memEntries = new Map<string, JournalEntry>();
  private memReceipts: InferenceReceipt[] = [];
  readonly backend: 'indexeddb' | 'memory';

  constructor(backend: 'indexeddb' | 'memory' = 'indexeddb') {
    this.backend = backend;
  }

  async open(): Promise<void> {
    if (this.backend === 'memory' || typeof indexedDB === 'undefined') {
      if (this.backend === 'indexeddb') {
        this.db = null; // fall through to memory silently
      }
      return;
    }
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          const s = db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains(RECEIPTS_STORE)) {
          db.createObjectStore(RECEIPTS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => {
        this.db = null; // memory fallback
        resolve();
      };
      setTimeout(() => {
        if (!this.db) resolve(); // never hang
      }, 2000);
    });
  }

  async saveEntry(entry: Omit<JournalEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<JournalEntry> {
    const now = Date.now();
    const id = entry.id ?? uid();
    const existing = await this.getEntry(id);
    const full: JournalEntry = {
      ...entry,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (this.db) {
      await this.tx('readwrite', ENTRIES_STORE, (s) => s.put(full));
    }
    this.memEntries.set(full.id, full); // memory mirror keeps API uniform
    return full;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    if (this.db) {
      const v = await this.tx('readonly', ENTRIES_STORE, (s) => s.get(id));
      if (v) return v as JournalEntry;
    }
    return this.memEntries.get(id) ?? null;
  }

  async listEntries(): Promise<JournalEntry[]> {
    let all: JournalEntry[] = [];
    if (this.db) {
      all = (await this.tx('readonly', ENTRIES_STORE, (s) => s.getAll())) as JournalEntry[];
    }
    for (const [id, e] of this.memEntries) {
      if (!all.find((x) => x.id === id)) all.push(e);
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteEntry(id: string): Promise<void> {
    if (this.db) await this.tx('readwrite', ENTRIES_STORE, (s) => s.delete(id));
    this.memEntries.delete(id);
  }

  async addReceipt(r: Omit<InferenceReceipt, 'id' | 'at'>): Promise<InferenceReceipt> {
    const full: InferenceReceipt = { ...r, id: uid(), at: Date.now() };
    if (this.db) {
      await this.tx('readwrite', RECEIPTS_STORE, (s) => s.put(full));
    }
    this.memReceipts.unshift(full);
    if (this.memReceipts.length > 500) this.memReceipts.pop();
    return full;
  }

  async listReceipts(): Promise<InferenceReceipt[]> {
    let all: InferenceReceipt[] = [];
    if (this.db) {
      all = (await this.tx('readonly', RECEIPTS_STORE, (s) => s.getAll())) as InferenceReceipt[];
    }
    const merged = [...all, ...this.memReceipts.filter((m) => !all.find((a) => a.id === m.id))];
    return merged.sort((a, b) => b.at - a.at).slice(0, 200);
  }

  private tx<T>(mode: IDBTransactionMode, store: string, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(undefined as T);
      const t = this.db.transaction(store, mode);
      const req = op(t.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }
}
/** Entries eligible for a synthesis over a date range (inclusive), joined oldest-first. */
export function synthesisInput(entries: JournalEntry[], fromISO: string, toISO: string): { text: string; count: number } {
  const inRange = entries
    .filter((e) => e.date >= fromISO && e.date <= toISO)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  const text = inRange
    .map((e) => `[${e.date}] ${e.title || '(untitled)'} (${e.privacy})\n${e.body}`)
    .join('\n\n');
  return { text, count: inRange.length };
}
