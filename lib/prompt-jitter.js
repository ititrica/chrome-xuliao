import lexicon from '../data/jitter-lexicon.js';

export { lexicon };
export const JITTER_KINDS = ['theme', 'entity', 'number', 'tone'];
export const TONE_PROFILES = Object.freeze([
  { id: 'polite', label: '礼貌', prefixes: ['麻烦你', '请你', '烦请你', '请协助我'], suffixes: ['若方便，请按以上要求处理。谢谢。', '感谢你的帮助，请保持以上条件。'] },
  { id: 'normal', label: '普通', prefixes: ['请你', '这次请你', '请帮我', '请协助我完成这个请求'], suffixes: ['', '请保留以上条件。', '以上要求请保持一致。', '就按这些要求来。'] },
  { id: 'casual', label: '随意', prefixes: ['帮我', '这次帮我', '我想请你', '按这个来'], suffixes: ['', '就按这个来。', '先这样处理就行。', '保持前面的条件。'] },
  { id: 'blunt', label: '不太礼貌', prefixes: ['直接', '按要求', '我要你', '别绕开要求，直接'], suffixes: ['', '别展开无关内容，按要求做。', '直接给结果。', '不要改动前面的条件。'] }
]);
const toneById = id => TONE_PROFILES.find(profile => profile.id === id) || TONE_PROFILES[1];
const pick = (items, random) => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const protectedPattern = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|https?:\/\/[^\s]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])*'|“[^”]*”|「[^」]*」|『[^』]*』|《[^》]*》/gu;

function pieces(text) {
  try { const value = JSON.parse(text); if (value && typeof value === 'object') return [{ text, protected: true }]; } catch { /* Normal prose. */ }
  let offset = 0; const parts = [];
  for (const match of text.matchAll(protectedPattern)) {
    parts.push({ text: text.slice(offset, match.index), protected: false }, { text: match[0], protected: true });
    offset = match.index + match[0].length;
  }
  parts.push({ text: text.slice(offset), protected: false });
  return parts;
}
const editable = text => pieces(text).filter(part => !part.protected).map(part => part.text).join('\n');

export function jitterPrompt(text, random = Math.random, tone = 'normal') {
  const profile = toneById(tone);
  const prefix = pick(profile.prefixes, random);
  const body = text.startsWith('请') ? text.slice(1) : text;
  const opening = `${prefix}${body}\n`;
  return opening + pick(profile.suffixes, random);
}

function alternatives(words, from, random) {
  const other = words.filter(word => word !== from);
  return other.length ? pick(other, random) : from;
}

const colorObjects = '墙窗门瓦杯碗盘伞灯帽袍裙衣衫裤鞋靴围巾丝带沙发桌椅书包屋顶';
function entityReplacements(text, category, random) {
  const candidates = lexicon.categories.filter(group => group.kind === 'entity' && (!group.scopes.length || group.scopes.includes(category)))
    .map(group => {
      const words = group.words.filter(word => word.length >= 2 && text.includes(word)).sort((a, b) => b.length - a.length);
      let from = words[0], shortColor = false;
      if (!from && group.id === 'colors') { from = text.match(new RegExp(`[蓝黄红绿紫橙粉白黑灰棕褐](?=[${colorObjects}])`, 'u'))?.[0]; shortColor = Boolean(from); }
      return from ? { group, from, shortColor } : null;
    }).filter(Boolean);
  // Shuffle categories, then select at most three independent details from the
  // opening. Later turns reuse this exact mapping and never resample it.
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
  const chosen = [];
  for (const item of candidates) {
    if (chosen.some(other => other.from.includes(item.from) || item.from.includes(other.from))) continue;
    const words = item.group.id === 'cities-jp' && text.includes(item.from + '站') ? item.group.words.filter(word => !['那霸', '石垣'].includes(word)) : item.group.words;
    chosen.push({ from: item.from, to: alternatives(words, item.from, random), category: item.group.label, kind: 'entity', shortColor: item.shortColor });
    if (chosen.length === 3) break;
  }
  return chosen;
}

const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function parseNumber(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  let total = 0, section = 0, current = 0;
  for (const char of text) {
    if (char in digits) current = digits[char];
    else if (char === '万') { total += (section + current || 1) * 10000; section = 0; current = 0; }
    else { section += (current || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char] || 0); current = 0; }
  }
  return total + section + current;
}
function chineseNumber(number) {
  if (number === 2) return '两';
  if (number >= 10000) return String(number);
  const chars = '零一二三四五六七八九'; let result = '', rest = number;
  for (const [base, suffix] of [[1000, '千'], [100, '百'], [10, '十'], [1, '']]) {
    const digit = Math.floor(rest / base); rest %= base;
    if (digit) result += chars[digit] + suffix;
    else if (result && rest && !result.endsWith('零')) result += '零';
  }
  return result.replace(/^一十/u, '十') || '零';
}
const numberPattern = /([零〇一二两三四五六七八九十百千万\d]+)(平方米|分钟|小时|个月|个人|天|日|周|年|位|名|人|元|岁|个|款|份|顿|页|张|组|种|次|步|字)/gu;
const numberGroup = unit => ({ 分钟: 'minutes', 小时: 'hours', 天: 'days', 日: 'days', 周: 'weeks', 个月: 'months', 年: 'years', 位: 'people', 名: 'people', 人: 'people', 个人: 'people', 平方米: 'area', 元: 'money', 岁: 'age', 个: 'count', 款: 'count', 份: 'count', 顿: 'count', 页: 'count', 张: 'count', 组: 'count', 种: 'count', 次: 'count', 步: 'steps', 字: 'characters' })[unit];

function numberReplacements(opening, allText, random) {
  const chosen = [], slots = new Map(), factors = new Map();
  const matches = [...opening.matchAll(numberPattern)];
  const originals = new Map(matches.map(match => [numberGroup(match[2]) + ':' + parseNumber(match[1]), parseNumber(match[1])]));
  for (const match of matches) {
    const [from, raw, unit] = match, before = opening.slice(Math.max(0, match.index - 3), match.index);
    const value = parseNumber(raw), id = numberGroup(unit);
    // Ordinal references, dates, ages, decimals and fractions are not quantities.
    const after = opening.slice(match.index + from.length);
    if (/[第前上这那每\/\.\d–—~～至到-]$/u.test(before) || /^[–—~～至到-]/u.test(after) || /^[龄级]/u.test(after) || value < 2 || value > 10000) continue;
    if (unit === '年' && value >= 1000 || unit === '日' && /月$/u.test(before)) continue;
    const group = lexicon.categories.find(item => item.id === 'number-' + id);
    if (!group) continue;
    const key = id + ':' + value;
    if (!slots.has(key)) {
      if (!factors.has(id)) factors.set(id, pick([0.8, 0.9, 1.1, 1.2], random));
      let candidates = group.words.map(word => Number(word.match(/^\d+/u)[0])).filter(n => n !== value && Math.sign(n - value) === Math.sign(factors.get(id) - 1) && n >= Math.max(2, Math.floor(value * 0.75)) && n <= Math.ceil(value * 1.25));
      // Keep explicit later ordinal references inside the new plan's duration.
      const ordinal = new RegExp(`第([零〇一二两三四五六七八九十百千万\\d]+)${escapeRegex(unit)}`, 'gu');
      const maxOrdinal = Math.max(0, ...[...allText.matchAll(ordinal)].map(m => parseNumber(m[1])));
      candidates = candidates.filter(n => n >= maxOrdinal);
      if (id === 'days' && /[一1]周|每周/u.test(allText)) candidates = candidates.filter(n => n <= 7);
      // Include unchanged parameters in ordering checks. E.g. 2 and 3 items
      // must not both become 2 merely because the smaller value cannot shrink.
      candidates = candidates.filter(n => ![...originals].some(([oldKey, oldValue]) => oldKey !== key && oldKey.startsWith(id + ':') && (oldValue - value) * ((slots.get(oldKey) ?? oldValue) - n) <= 0));
      if (!candidates.length) continue;
      const target = value * factors.get(id);
      candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      const replacement = candidates[0];
      slots.set(key, replacement);
    }
    const replacement = slots.get(key);
    chosen.push({ from, to: (/^\d+$/u.test(raw) ? String(replacement) : chineseNumber(replacement)) + unit, category: group.label, kind: 'number', numberId: id, oldValue: value, newValue: replacement });
  }
  // Include alternate spellings/units of the same quantity in following turns.
  for (const match of allText.matchAll(numberPattern)) {
    const [from, raw, unit] = match, value = parseNumber(raw), id = numberGroup(unit);
    const replacement = slots.get(id + ':' + value);
    if (replacement == null || chosen.some(row => row.from === from)) continue;
    chosen.push({ from, to: (/^\d+$/u.test(raw) ? String(replacement) : chineseNumber(replacement)) + unit, category: lexicon.categories.find(item => item.id === 'number-' + id).label, kind: 'number', numberId: id, oldValue: value, newValue: replacement });
  }
  return chosen.filter((row, index) => chosen.findIndex(other => other.from === row.from) === index);
}

function replaceText(text, replacements) {
  if (!replacements.length) return text;
  const rows = [...replacements].sort((a, b) => b.from.length - a.from.length);
  const expression = new RegExp(rows.map(row => escapeRegex(row.from) + (row.shortColor ? `(?=[${colorObjects}])` : '')).join('|'), 'gu');
  return pieces(text).map(part => part.protected ? part.text : part.text.replace(expression, (from, offset, source) => {
    const row = rows.find(item => item.from === from);
    if (row.kind === 'number' && (/[第前上这那每\/\.\d零〇一二两三四五六七八九十百千万–—~～至到-]$/u.test(source.slice(Math.max(0, offset - 3), offset)) || /^[–—~～至到-]/u.test(source.slice(offset + from.length)) || /日$/u.test(from) && /月$/u.test(source.slice(0, offset)))) return from;
    // No cascading replacements: the regexp only visits the original text.
    return row.to;
  })).join('');
}

export function jitterConversation(turns, category, random = Math.random, kinds = JITTER_KINDS) {
  const opening = editable(turns[0].text), allText = turns.map(turn => editable(turn.text)).join('\n');
  const replacements = [
    ...(kinds.includes('entity') ? entityReplacements(opening, category, random) : []),
    ...(kinds.includes('number') ? numberReplacements(opening, allText, random) : [])
  ];
  const themeGroup = kinds.includes('theme') && lexicon.categories.find(group => group.kind === 'theme' && group.scopes.includes(category));
  const theme = themeGroup ? pick(themeGroup.words, random) : '';
  const toneProfile = kinds.includes('tone') ? pick(TONE_PROFILES, random) : null;
  return {
    jitter: { version: lexicon.version, theme, tone: toneProfile?.id || '', toneLabel: toneProfile?.label || '', replacements },
    turns: turns.map((turn, index) => ({ ...turn, sourceText: turn.text,
      text: jitterPrompt(replaceText(turn.text, replacements), random, toneProfile?.id || 'normal') + (index === 0 && theme ? `\n本组侧重：${theme}。若与正文的明确条件冲突，以正文为准；后续请延续本组设定。` : '')
    }))
  };
}
