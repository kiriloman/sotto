// Sotto — opt-in Firestore sync for standard-tier entries.
//
// Privacy model: private entries are STRUCTURALLY excluded — the sync layer
// refuses to serialize them at all, not just "usually doesn't" send them.
// Sync is off by default; the user enables it per deployment in settings.
//
// Firebase usage: anonymous auth (identity for merge keys) + Firestore
// (entries collection). One document per entry, keyed by entry id.

import {
  signInAnonymously,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { getAuth } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  setDoc,
} from 'firebase/firestore';
import type { FirebaseApp } from 'firebase/app';
import type { JournalEntry } from '../storage/db.ts';

/** Serialized shape — note what is deliberately NOT here. */
interface SyncedEntry {
  date: string;
  title: string;
  body: string;
  mood?: string;
  analysis?: JournalEntry['analysis'];
  updatedAt: number;
}

export class EntrySync {
  private app: FirebaseApp | null = null;
  private user: User | null = null;
  private started = false;

  constructor(app: FirebaseApp | null) {
    this.app = app;
  }

  /** Sign in anonymously and start listening. Safe to call once at boot. */
  async start(): Promise<void> {
    if (!this.app || this.started) return;
    this.started = true;
    try {
      const auth = getAuth(this.app);
      onAuthStateChanged(auth, (u) => {
        this.user = u;
      });
      await signInAnonymously(auth);
    } catch (err) {
      console.warn('[Sotto] anonymous auth unavailable — sync disabled:', err);
      this.user = null;
    }
  }

  get ready(): boolean {
    return this.user !== null;
  }

  /** Sync one entry. Private entries are refused — structurally excluded. */
  async syncEntry(entry: JournalEntry): Promise<'synced' | 'skipped-private' | 'unavailable'> {
    if (!this.app || !this.user) return 'unavailable';
    if (entry.privacy === 'private') return 'skipped-private'; // hard exclusion
    const payload: SyncedEntry & { ownerUid: string } = {
      ownerUid: this.user.uid, // firestore.rules enforce owner-only access
      date: entry.date,
      title: entry.title,
      body: entry.body,
      mood: entry.mood,
      analysis: entry.analysis,
      updatedAt: entry.updatedAt,
    };
    try {
      await setDoc(doc(collection(getFirestore(this.app), 'entries'), entry.id), payload);
      return 'synced';
    } catch (err) {
      console.warn('[Sotto] entry sync failed:', err);
      return 'unavailable';
    }
  }

  /** Remove an entry's document (called after local delete). */
  async removeEntry(entryId: string): Promise<void> {
    if (!this.app || !this.user) return;
    try {
      await deleteDoc(doc(collection(getFirestore(this.app), 'entries'), entryId));
    } catch (err) {
      console.warn('[Sotto] entry remove failed:', err);
    }
  }
}
