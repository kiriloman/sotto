// Sotto — task prompts.
//
// Every task that goes through the router has its prompt defined here, so
// the on-device and cloud paths run byte-identical instructions. Structured
// tasks (analysis, title) ask for JSON in the prompt itself and are parsed
// tolerantly (parseEntryAnalysis handles fenced/prose-wrapped JSON) — a
// deliberate choice that works identically on both inference paths rather
// than SDK schema plumbing that differs between them.

import type { TaskId } from '../router/policy.ts';

export interface EntryAnalysis {
  mood: 'great' | 'good' | 'neutral' | 'low' | 'rough';
  themes: string[];
  oneLineSummary: string;
}

export interface DeepDiveTurn {
  q: string;
  a: string;
  at: number;
}

export const TASK_LABELS: Record<TaskId, string> = {
  'entry-analysis': 'Entry analysis',
  'title-suggest': 'Title suggestion',
  'quick-reflection': 'Quick reflection',
  'weekly-synthesis': 'Weekly synthesis',
  'deep-dive': 'Deep dive',
};

const SYSTEM_PROMPT =
  'You are Sotto, a gentle journaling companion. You are concise, warm, and never judgmental. ' +
  'You never invent facts that are not in the entry.';

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildPrompt(
  task: TaskId,
  input: string,
  extra?: string,
  history?: { q: string; a: string }[]
): string {
  switch (task) {
    case 'entry-analysis':
      return (
        'Analyze this journal entry. Respond with JSON only, matching this shape: ' +
        '{"mood": one of "great" | "good" | "neutral" | "low" | "rough", "themes": up to 3 short lowercase keywords, ' +
        '"oneLineSummary": one sentence, max 15 words}.\n\n---\n' +
        input +
        '\n---'
      );
    case 'title-suggest':
      return (
        'Suggest a short title (max 6 words) for this journal entry. ' +
        'Respond with JSON only: {"title": "..."}.\n\n---\n' +
        input +
        '\n---'
      );
    case 'quick-reflection':
      return (
        'Write a single short paragraph (max 80 words) reflecting back on this journal entry: ' +
        'acknowledge the feeling, notice one thread worth attention. No questions, no advice unless clearly asked.\n\n---\n' +
        input +
        '\n---'
      );
    case 'weekly-synthesis': {
      const range = extra ?? 'the past week';
      return (
        `Here are all journal entries from ${range}, oldest first:\n\n---\n` +
        input +
        '\n---\n\n' +
        'Write a "week in review": (1) three bullets on the emotional arc of the week, ' +
        '(2) one recurring theme with a short quote from the entries, ' +
        '(3) one gentle suggestion for next week. Warm, concise, grounded in the entries only.'
      );
    }
    case 'deep-dive': {
      const question = extra ?? '(no question provided)';
      const turns = (history ?? [])
        .map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`)
        .join('\n\n');
      return (
        'You are discussing this journal entry with its author. Answer the question, using the ' +
        'conversation so far as context. Ground every claim in the entry; say so when the entry ' +
        'does not contain the answer.\n\n' +
        (turns ? `Conversation so far:\n${turns}\n\n` : '') +
        `Question: ${question}\n\n---\n` +
        input +
        '\n---'
      );
    }
  }
}

/** Parse a model response into an EntryAnalysis, tolerating prose-wrapped JSON. */
export function parseEntryAnalysis(raw: string): EntryAnalysis {
  const cleaned = stripToJson(raw);
  const obj = JSON.parse(cleaned) as Partial<EntryAnalysis>;
  const moods: EntryAnalysis['mood'][] = ['great', 'good', 'neutral', 'low', 'rough'];
  return {
    mood: moods.includes(obj.mood as EntryAnalysis['mood']) ? (obj.mood as EntryAnalysis['mood']) : 'neutral',
    themes: Array.isArray(obj.themes) ? obj.themes.slice(0, 3).map(String) : [],
    oneLineSummary: typeof obj.oneLineSummary === 'string' ? obj.oneLineSummary : '',
  };
}

export function parseTitle(raw: string): string {
  const obj = JSON.parse(stripToJson(raw)) as { title?: unknown };
  return typeof obj.title === 'string' ? obj.title : '';
}

function stripToJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return raw.slice(first, last + 1);
  return raw.trim();
}
