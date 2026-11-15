// Sotto — task prompts and structured-output schemas.
//
// Every task that goes through the router has its prompt defined here, so
// the on-device and cloud paths run byte-identical instructions. Structured
// tasks (analysis, title) use responseSchema — supported on BOTH paths.

import type { TaskId } from '../router/policy';

export interface EntryAnalysis {
  mood: 'great' | 'good' | 'neutral' | 'low' | 'rough';
  themes: string[];
  oneLineSummary: string;
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

export function buildPrompt(task: TaskId, input: string, extra?: string): string {
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
    case 'deep-dive':
      return (
        'Answer the question about this journal entry. Ground every claim in the entry; say so when the entry does not contain the answer.\n\n' +
        `Question: ${extra ?? '(no question provided)'}\n\n---\n` +
        input +
        '\n---'
      );
  }
}

/** JSON schema for structured-output tasks (Firebase AI Logic responseSchema).
 *  Only used by tasks whose policy sets structuredOutput: true. */
export const ENTRY_ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mood: { type: 'STRING', enum: ['great', 'good', 'neutral', 'low', 'rough'] },
    themes: { type: 'ARRAY', items: { type: 'STRING' } },
    oneLineSummary: { type: 'STRING' },
  },
  required: ['mood', 'themes', 'oneLineSummary'],
} as const;

export const TITLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
  },
  required: ['title'],
} as const;

export function responseSchemaFor(task: TaskId): object | undefined {
  switch (task) {
    case 'entry-analysis':
      return ENTRY_ANALYSIS_SCHEMA;
    case 'title-suggest':
      return TITLE_SCHEMA;
    default:
      return undefined;
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
