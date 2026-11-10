import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lexicon, jitterConversation } from '../lib/prompt-jitter.js';
import { buildRun, normalizeConfig } from '../lib/core.js';

test('categorized dictionary has over 2000 distinct meaningful nonnumeric entries plus typed numbers', () => {
  const words = lexicon.categories.flatMap(group => group.words);
  const lexical = lexicon.categories.filter(group => group.kind !== 'number').flatMap(group => group.words);
  assert.ok(new Set(lexical).size > 2000);
  assert.equal(words.length, lexicon.count);
  assert.equal(new Set(words).size, lexicon.uniqueCount);
  assert.equal(new Set(lexicon.categories.map(group => group.id)).size, lexicon.categories.length);
  assert.ok(lexicon.categories.every(group => group.words.length >= 20 && group.words.every(word => word.trim() === word && word.length > 0)));
});

test('theme and details change between groups but repeated image details share one mapping', () => {
  const source = [{ kind: 'image', text: '请直接生成一张图片：海边小书店的灰猫，水彩绘本风。' }, { kind: 'image', text: '继续修改海边小书店的灰猫，保持水彩绘本风，不改变角色。' }];
  const before = structuredClone(source);
  const a = jitterConversation(source, '图片创作', () => 0), b = jitterConversation(source, '图片创作', () => 0.999);
  assert.notEqual(a.jitter.theme, b.jitter.theme);
  assert.equal(a.jitter.replacements.length, 3);
  for (const row of a.jitter.replacements) {
    assert.notEqual(row.from, row.to);
    assert.ok(a.turns.every(turn => turn.text.includes(row.to)));
    assert.ok(a.turns.every(turn => !turn.text.includes(row.from)));
    assert.ok(lexicon.categories.find(group => group.label === row.category).words.includes(row.to));
  }
  assert.deepEqual(source, before);
  assert.equal(a.turns[0].sourceText, source[0].text);
});

test('number jitter uses unit pools, shares alternate spellings and retains ordered time budgets', () => {
  const source = [{ text: '为两位成年人设计六周计划，每天二十分钟。', kind: 'text' }, { text: '第三周改为每天十分钟。六周后回顾两个人的结果，原来每天20分钟。', kind: 'text' }];
  const { turns, jitter } = jitterConversation(source, '学习成长', () => 0.999, ['number']);
  const people = jitter.replacements.find(row => row.from === '两位');
  assert.equal(people.to, '三位');
  assert.ok(turns[1].text.includes('三个人'));
  const minutes = jitter.replacements.find(row => row.from === '二十分钟');
  assert.equal(minutes.to, '二十四分钟');
  assert.ok(turns[1].text.includes('24分钟'));
  assert.ok(turns[1].text.includes('第三周'));
  assert.ok(turns[1].text.includes('十分钟'));
  assert.ok(jitter.replacements.every(row => row.kind === 'number'));
});

test('code, literals, JSON, ordinals, dates, ranges and larger numbers remain intact', () => {
  const source = [{ text: '在京都安排三天，预算200元。序号第三天，日期2026年11月10日，范围200–220元，另有1200元。引用“京都三天200元”，代码 `京都 200元`，网址 https://example.com/京都/200元 。', kind: 'text' }, { text: '{"city":"京都","budget":200}', kind: 'text' }];
  const { turns } = jitterConversation(source, '旅行规划', () => 0.999);
  assert.ok(!turns[0].text.includes('在京都安排三天，预算200元'));
  for (const text of ['第三天', '2026年11月10日', '200–220元', '“京都三天200元”', '`京都 200元`', 'https://example.com/京都/200元']) assert.ok(turns[0].text.includes(text), text);
  assert.ok(turns[1].text.includes(source[1].text));
});

test('numeric plan duration cannot shrink below explicit later ordinal references', () => {
  const { jitter } = jitterConversation([{ text: '制定六周计划。', kind: 'text' }, { text: '第六周需要复盘。', kind: 'text' }], '学习成长', () => 0, ['number']);
  assert.ok(jitter.replacements.every(row => row.newValue >= 6));
});

test('numeric jitter preserves ordering even when a smaller quantity cannot be changed', () => {
  const { jitter } = jitterConversation([{ text: '准备三种样品和两种备用样品，预算二十元，另有十元应急。', kind: 'text' }], '产品经营', () => 0, ['number']);
  const value = (from, fallback) => jitter.replacements.find(row => row.from === from)?.newValue ?? fallback;
  assert.ok(value('三种', 3) > value('两种', 2));
  assert.ok(value('二十元', 20) > value('十元', 10));
});

test('wording only mode and jitter off are explicit and stable configuration choices', () => {
  assert.deepEqual(normalizeConfig({ jitterKinds: ['invalid', 'number', 'number'] }).jitterKinds, ['number']);
  const source = Array(6).fill({ text: '请在京都安排三天，灰猫在海边小书店，水彩绘本风。', kind: 'text' });
  const wording = jitterConversation(source, '旅行规划', () => 0, []);
  assert.deepEqual(wording.jitter, { version: lexicon.version, theme: '', replacements: [] });
  assert.ok(wording.turns[0].text.includes(source[0].text.slice(1)));
  const run = buildRun([{ id: 'one', title: 'one', category: '旅行规划', turns: source }], { sessions: 1, promptJitter: false });
  assert.equal(run.tasks[0].jitter, null); assert.deepEqual(run.tasks[0].turns, source);
});

test('every built-in topic actually samples a compatible theme and most use detail or number jitter', async () => {
  const raw = JSON.parse(await readFile(new URL('../data/conversations.json', import.meta.url), 'utf8'));
  const library = Array.isArray(raw) ? raw : raw.conversations;
  let semantic = 0;
  for (const item of library) {
    const result = jitterConversation(item.turns, item.category, () => 0.6);
    assert.ok(result.jitter.theme, item.title);
    assert.ok(lexicon.categories.find(group => group.kind === 'theme' && group.scopes.includes(item.category)).words.includes(result.jitter.theme));
    if (result.jitter.replacements.length) semantic++;
    assert.ok(result.turns.every(turn => turn.text.length <= 12000));
  }
  assert.ok(semantic >= 200, `${semantic} scripts have eligible detail/number slots`);
});
