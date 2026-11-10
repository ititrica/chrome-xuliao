import { jitterConversation, JITTER_KINDS } from './prompt-jitter.js';
export { jitterPrompt } from './prompt-jitter.js';

export const DEFAULT_CONFIG = Object.freeze({
  sessions: 6, parallel: false,
  minDelay: 12, maxDelay: 45, typing: true, responseTimeout: 1200,
  imageTimeout: 1200, categories: [], includeImages: true, imageRatio: 30, promptJitter: true,
  jitterKinds: [...JITTER_KINDS],
  selectors: { editor: '', send: '', stop: '', assistant: '', user: '', complete: '', bottom: '' }
});

export const TERMINAL = new Set(['done', 'skipped', 'stopped']);
export const ACTIVE = new Set(['opening', 'running', 'blocked']);
const integer = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function normalizeConfig(value = {}) {
  const d = DEFAULT_CONFIG;
  const minDelay = integer(value.minDelay, d.minDelay, 2, 300);
  const maxDelay = Math.max(minDelay, integer(value.maxDelay, d.maxDelay, 2, 300));
  const selectors = Object.fromEntries(Object.keys(d.selectors).map(key => [key, String(value.selectors?.[key] || '').trim().slice(0, 500)]));
  return {
    sessions: integer(value.sessions, d.sessions, 1, 300),
    parallel: typeof value.parallel === 'boolean' ? value.parallel : value.mode === 'parallel',
    minDelay, maxDelay,
    typing: value.typing !== false,
    responseTimeout: integer(value.responseTimeout, d.responseTimeout, 30, 1800),
    imageTimeout: integer(value.imageTimeout, d.imageTimeout, 60, 3600),
    categories: Array.isArray(value.categories) ? [...new Set(value.categories.filter(x => typeof x === 'string'))] : [],
    includeImages: value.includeImages !== false,
    imageRatio: integer(value.imageRatio, d.imageRatio, 0, 100), promptJitter: value.promptJitter !== false,
    jitterKinds: Array.isArray(value.jitterKinds) ? JITTER_KINDS.filter(kind => value.jitterKinds.includes(kind)) : [...JITTER_KINDS], selectors
  };
}

export function migrateConfig(value, version) {
  const config = { ...(value || DEFAULT_CONFIG) };
  if (value && version !== 3) {
    for (const [key, previous] of Object.entries({ sessions: 3, minDelay: 5, maxDelay: 12, responseTimeout: 240, imageTimeout: 600, includeImages: false })) {
      if (config[key] === previous) config[key] = DEFAULT_CONFIG[key];
    }
  }
  return normalizeConfig(config);
}

export async function mergeBuiltins(library, builtin, history) {
  const merged = [...library];
  for (const item of builtin) {
    const index = merged.findIndex(old => old.id === item.id);
    if (index < 0) merged.push(item);
    else {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(merged[index]))))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (history[item.id]?.includes(digest)) merged[index] = item;
    }
  }
  return merged;
}

export function validateLibrary(input) {
  const items = Array.isArray(input) ? input : input?.conversations;
  if (!Array.isArray(items) || !items.length || items.length > 1000) throw new Error('聊天库应包含 1–1000 组会话。');
  const ids = new Set();
  return items.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${i + 1} 组会话格式错误。`);
    const id = String(item.id || `custom-${i + 1}`);
    if (ids.has(id) || id.length > 100) throw new Error(`第 ${i + 1} 组会话的 ID 重复或过长。`);
    ids.add(id);
    const title = String(item.title || '').trim();
    if (!title || title.length > 100) throw new Error(`第 ${i + 1} 组需要 1–100 字的标题。`);
    if (!Array.isArray(item.turns) || item.turns.length < 1 || item.turns.length > 20) throw new Error(`「${title}」需要 1–20 轮提示词；文字会话至少 6 轮，图片会话至少 12 轮才能运行。`);
    const turns = item.turns.map((turn, j) => {
      const text = typeof turn === 'string' ? turn : turn?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error(`「${title}」第 ${j + 1} 轮需要 1–12000 字。`);
      if (typeof turn === 'object' && turn.kind != null && !['text', 'image'].includes(turn.kind)) throw new Error(`「${title}」第 ${j + 1} 轮的类型必须是 text 或 image。`);
      return { text: text.trim(), kind: turn?.kind === 'image' ? 'image' : 'text' };
    });
    return { id, title, category: String(item.category || '自定义').trim().slice(0, 40) || '自定义', turns };
  });
}

export function eligibleLibrary(library, config) {
  return library.filter(item =>
    (!config.categories.length || config.categories.includes(item.category)) &&
    item.turns.length >= (isImageSession(item) ? 12 : 6) &&
    (config.includeImages || !isImageSession(item))
  );
}

export const isImageSession = item => item.turns.some(turn => turn.kind === 'image');

export function imageAllocation(library, rawConfig) {
  const config = normalizeConfig(rawConfig), pool = eligibleLibrary(library, config);
  const imageAvailable = pool.filter(isImageSession).length, textAvailable = pool.length - imageAvailable;
  const requested = config.includeImages ? Math.round(config.sessions * config.imageRatio / 100) : 0;
  const images = Math.min(imageAvailable, Math.max(requested, config.sessions - textAvailable));
  return { images, text: Math.min(textAvailable, config.sessions - images), requested, available: pool.length };
}

function taskTurns(item, config, random) {
  const minimum = isImageSession(item) ? 12 : 6;
  const maximum = Math.min(isImageSession(item) ? 20 : 15, item.turns.length);
  const count = minimum + Math.floor(random() * (maximum - minimum + 1));
  const turns = structuredClone(item.turns.slice(0, count));
  return config.promptJitter ? jitterConversation(turns, item.category, random, config.jitterKinds) : { turns, jitter: null };
}

export function buildRun(library, rawConfig, random = Math.random, now = Date.now()) {
  const config = normalizeConfig(rawConfig);
  const pool = [...eligibleLibrary(library, config)];
  if (pool.length < config.sessions) throw new Error(`当前只有 ${pool.length} 组符合条件的会话，请减少会话数量或扩大主题范围。文字至少 6 轮、图片至少 12 轮，每批抽取不重复。`);
  const shuffle = items => { for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; } return items; };
  const allocation = imageAllocation(library, config);
  const selected = shuffle([...shuffle(pool.filter(isImageSession)).slice(0, allocation.images), ...shuffle(pool.filter(item => !isImageSession(item))).slice(0, allocation.text)]);
  return {
    id: `run-${now}-${Math.floor(random() * 1e8).toString(36)}`, status: 'running',
    createdAt: now, updatedAt: now, config, logs: [],
    concurrencyLimit: config.parallel ? 1 + Math.floor(random() * 3) : 1,
    imageSessions: allocation.images,
    tasks: selected.map((item, i) => ({
      id: `task-${i + 1}`, sourceId: item.id, title: item.title, category: item.category,
      ...taskTurns(item, config, random), completed: 0,
      status: 'queued', phase: 'ready', tabId: null, url: '', nextAt: 0,
      checkpoint: null, recoveryCheckpoint: null, transcript: [], error: '', heartbeatAt: now,
      retryAt: 0, turnRetries: 0, recoveries: 0, revision: 0, pageReady: false, closePending: false
    }))
  };
}

export function appendLog(run, text, level = 'info', taskId = null) {
  run.updatedAt = Date.now();
  run.logs.push({ at: run.updatedAt, text, level, taskId });
  if (run.logs.length > 400) run.logs.splice(0, run.logs.length - 400);
}

export function settleRun(run) {
  if (run.status !== 'stopped' && run.tasks.every(task => TERMINAL.has(task.status))) {
    run.status = 'completed';
    run.finishedAt = Date.now();
  }
  return run;
}

export function progress(run) {
  if (!run) return { completed: 0, total: 0, sessions: 0 };
  return {
    completed: run.tasks.reduce((sum, t) => sum + t.completed, 0),
    total: run.tasks.reduce((sum, t) => sum + t.turns.length, 0),
    sessions: run.tasks.filter(t => t.status === 'done').length
  };
}
