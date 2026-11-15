// Sotto — prompt/parsing tests: model-output tolerance (fenced JSON,
// prose-wrapped JSON) and mood/theme clamping.

import test from 'node:test';
import assert from 'node:assert';
import { parseEntryAnalysis, parseTitle, buildPrompt } from '../src/ai/prompts.ts';

test('parseEntryAnalysis: plain JSON', () => {
  const a = parseEntryAnalysis('{"mood":"good","themes":["work","focus"],"oneLineSummary":"Steady day."}');
  assert.equal(a.mood, 'good');
  assert.deepEqual(a.themes, ['work', 'focus']);
});

test('parseEntryAnalysis: fenced JSON (models love fences)', () => {
  const a = parseEntryAnalysis('```json\n{"mood":"low","themes":["sleep"],"oneLineSummary":"Tired."}\n```');
  assert.equal(a.mood, 'low');
});

test('parseEntryAnalysis: prose around JSON', () => {
  const a = parseEntryAnalysis('Here is the analysis: {"mood":"great","themes":["a"],"oneLineSummary":"Great!"} hope it helps');
  assert.equal(a.mood, 'great');
});

test('parseEntryAnalysis: unknown mood clamps to neutral, never throws', () => {
  const a = parseEntryAnalysis('{"mood":"ecstatic","themes":[],"oneLineSummary":""}');
  assert.equal(a.mood, 'neutral');
});

test('parseEntryAnalysis: more than 3 themes are truncated', () => {
  const a = parseEntryAnalysis('{"mood":"good","themes":["a","b","c","d","e"],"oneLineSummary":"x"}');
  assert.equal(a.themes.length, 3);
});

test('parseTitle: fenced JSON', () => {
  assert.equal(parseTitle('```json\n{"title":"A quiet win"}\n```'), 'A quiet win');
});

test('parseTitle: missing title yields empty string, never throws', () => {
  assert.equal(parseTitle('{"nope":1}'), '');
});

test('buildPrompt: entry-analysis embeds the entry', () => {
  const p = buildPrompt('entry-analysis', 'My entry text');
  assert.ok(p.includes('My entry text'));
  assert.ok(p.includes('mood'));
});

test('buildPrompt: weekly-synthesis embeds the range and history', () => {
  const p = buildPrompt('weekly-synthesis', '[2026-11-10] Day one…', 'Nov 10 to Nov 16');
  assert.ok(p.includes('Nov 10 to Nov 16'));
  assert.ok(p.includes('[2026-11-10]'));
});

test('buildPrompt: deep-dive embeds the question', () => {
  const p = buildPrompt('deep-dive', 'entry body', 'What did I learn?');
  assert.ok(p.includes('What did I learn?'));
});
