import { normalizeConfig, migrateConfig, mergeBuiltins, validateLibrary, buildRun, appendLog, settleRun, ACTIVE, TERMINAL } from './lib/core.js';
import { createDeviceInput } from './lib/device-input.js';

const STORE_VERSION = 1;
let state;
let queue = Promise.resolve();
const loaded = (async () => {
  const saved = await chrome.storage.local.get(['config', 'library', 'run', 'builtinLibraryVersion', 'configVersion']);
  const builtin = validateLibrary(await (await fetch(chrome.runtime.getURL('data/conversations.json'))).json());
  // Replace only recognizable built-ins. User-edited scripts and custom ids survive upgrades.
  let library = saved.library ? validateLibrary(saved.library) : builtin;
  if (saved.library && saved.builtinLibraryVersion !== 3) {
    const history = await (await fetch(chrome.runtime.getURL('data/builtin-history.json'))).json();
    library = await mergeBuiltins(library, builtin, history);
  }
  state = {
    version: STORE_VERSION,
    config: migrateConfig(saved.config, saved.configVersion),
    library,
    run: saved.run || null
  };
  if (state.run) {
    state.run.concurrencyLimit ||= state.run.config.mode === 'parallel' ? Math.min(3, state.run.config.concurrency || 2) : 1;
    for (const task of state.run.tasks) {
      task.revision ||= 0; task.turnRetries ||= 0; task.recoveries ||= 0; task.retryAt ||= 0;
      if (task.status === 'blocked') { task.status = 'running'; task.retryAt = 0; }
    }
  }
  await chrome.storage.local.set({ config: state.config, library: state.library, run: state.run, builtinLibraryVersion: 3, configVersion: 3 });
})();
const device = createDeviceInput(chrome, async (tabId, message) => {
  await loaded;
  const { run, task } = activeTask({ tab: { id: tabId } }, message.taskId);
  requireTurn(task, message);
  if (message.runId !== run.id || message.revision !== task.revision || run.status !== 'running' || task.status !== 'running') throw new Error('XULIAO_CANCELLED');
  if (run.tasks.some(other => other.id !== task.id && other.status === 'opening')) throw new Error('XULIAO_PAGE_LOADING');
  if (['send', 'enter'].includes(message.action) && task.phase !== 'dispatching') throw new Error('发送检查点不存在。');
  if (['clear', 'type'].includes(message.action) && task.phase !== 'preparing') throw new Error('XULIAO_CANCELLED');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(tab.url || '')) throw new Error('任务标签页离开了 ChatGPT。');
});

function serialize(fn) {
  const result = queue.then(async () => { await loaded; return fn(); });
  queue = result.catch(error => console.error('[续聊]', error));
  return result;
}
async function save() {
  await chrome.storage.local.set({ config: state.config, library: state.library, run: state.run });
}
async function openWorkbench() {
  const url = chrome.runtime.getURL('ui/index.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url?.split('#')[0] === url);
  if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}
function panelSnapshot() {
  const { run } = state;
  return {
    config: state.config,
    run: run ? { id: run.id, status: run.status, config: run.config, concurrencyLimit: run.concurrencyLimit,
      tasks: run.tasks.map(task => ({ id: task.id, title: task.title, status: task.status, phase: task.phase, completed: task.completed, total: task.turns.length, error: task.error, tabId: task.tabId, retryAt: task.retryAt, recoveries: task.recoveries })),
      logs: run.logs.slice(-4)
    } : null
  };
}
function snapshot(includeLibrary = true) {
  return {
    version: state.version, config: state.config,
    ...(includeLibrary ? { library: state.library } : {}),
    run: state.run ? { ...state.run, tasks: state.run.tasks.map(task => ({ ...task, turns: task.turns.map(turn => ({ kind: turn.kind })), transcript: undefined })) } : null
  };
}
function activeTask(sender, taskId) {
  const run = state.run;
  const task = run?.tasks.find(t => t.id === taskId && t.tabId === sender.tab?.id);
  if (!task) throw new Error('此页面没有对应的运行任务。');
  return { run, task };
}
function requireTurn(task, message) {
  if (task.completed !== message.turn || TERMINAL.has(task.status)) throw new Error('这一轮任务已变化，请刷新任务状态。');
  if (message.runId && message.runId !== state.run.id || message.revision != null && message.revision !== task.revision) throw new Error('XULIAO_CANCELLED');
}
async function recover(task, reason, kind = 'retry') {
  if (!state.run || !['running', 'paused'].includes(state.run.status) || TERMINAL.has(task.status)) return;
  task.turnRetries = (task.turnRetries || 0) + 1;
  task.recoveries = (task.recoveries || 0) + 1;
  task.revision = (task.revision || 0) + 1;
  task.error = reason;
  if (kind === 'skip' || task.turnRetries > 3) {
    task.status = 'skipped'; task.retryAt = 0;
    appendLog(state.run, `「${task.title}」已自动跳过：${reason}`, 'error', task.id);
    task.closePending = task.tabId != null;
    await closeTaskTab(task);
    return;
  }
  task.status = task.pageReady === false ? 'opening' : 'running';
  if (task.status === 'opening') task.openedAt = Date.now();
  task.retryAt = Date.now() + [2000, 5000, 10000][task.turnRetries - 1];
  if (kind === 'wait' && task.checkpoint) task.checkpoint.waitStartedAt = task.retryAt;
  else {
    task.recoveryCheckpoint = task.checkpoint || task.recoveryCheckpoint || null;
    task.checkpoint = null; task.phase = 'ready';
  }
  appendLog(state.run, `「${task.title}」自动恢复 ${task.turnRetries}/3：${reason}`, 'warn', task.id);
  // Persist intent before reload; a reloaded script can reconcile the previous user bubble.
  await save();
  if (task.turnRetries === 2 && kind !== 'wait' && task.tabId != null) {
    task.openedAt = Date.now();
    await chrome.tabs.reload(task.tabId).catch(() => {});
  }
}
async function closeTaskTab(task) {
  if (task.tabId == null) { task.closePending = false; return true; }
  const tabId = task.tabId;
  await device.release(tabId);
  // Closing a finished task is intentional, and must survive worker restarts.
  task.closePending = true;
  await save();
  try { await chrome.tabs.remove(tabId); }
  catch {
    if (await chrome.tabs.get(tabId).catch(() => null)) return false;
  }
  task.tabId = null; task.closePending = false;
  await save();
  return true;
}
async function notify() {
  if (!state.run) return;
  await Promise.allSettled(state.run.tasks.filter(t => t.tabId != null).map(t =>
    chrome.tabs.sendMessage(t.tabId, { type: 'CONTROL', status: state.run.status })
  ));
}
async function schedule() {
  const run = state.run;
  if (!run) return;
  for (const task of run.tasks.filter(t => t.closePending && TERMINAL.has(t.status))) if (!await closeTaskTab(task)) return;
  if (run.status !== 'running') return;
  settleRun(run);
  if (run.status !== 'running') return;
  const limit = run.concurrencyLimit || 1;
  // Keep each newly created page in front until its content script confirms readiness.
  if (run.tasks.some(t => t.status === 'opening')) return;
  let count = run.tasks.filter(t => ACTIVE.has(t.status)).length;
  for (const task of run.tasks) {
    if (count >= limit) break;
    if (task.status !== 'queued') continue;
    task.status = 'opening';
    task.openedAt = Date.now();
    count++;
    try {
      if (Number.isInteger(run.windowId)) await chrome.windows.update(run.windowId, { focused: true });
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true, ...(Number.isInteger(run.windowId) ? { windowId: run.windowId } : {}) });
      task.tabId = tab.id;
      appendLog(run, `已打开「${task.title}」的新会话`, 'info', task.id);
      break;
    } catch (error) { await recover(task, `无法打开标签页：${error.message}`, 'skip'); }
  }
}

async function handle(message, sender = {}) {
  // Content scripts can only operate their assigned tab. Workbench commands must originate in this extension.
  const pageCommand = ['PULL', 'PAGE_READY', 'CLAIM', 'COMMIT', 'ADOPT_SENT', 'RECOVER', 'ABORT_DISPATCH', 'SENT', 'COMPLETE', 'BLOCK', 'CANCEL_PREPARE', 'HEARTBEAT'].includes(message.type);
  const panelCommand = ['PANEL_STATE', 'PANEL_ACTION'].includes(message.type);
  if (panelCommand && (!sender.tab || !/^https?:\/\//.test(sender.url || '') || (sender.id && sender.id !== chrome.runtime.id))) throw new Error('悬浮菜单只能在已授权的网页上使用。');
  if (!pageCommand && !panelCommand && !sender.url?.startsWith(chrome.runtime.getURL('ui/'))) throw new Error('此操作只能从续聊工作台发起。');
  if (pageCommand && !sender.tab) throw new Error('缺少会话标签页。');
  if (message.type === 'PANEL_STATE') return panelSnapshot();
  if (message.type === 'PANEL_ACTION') {
    if (message.action === 'console') { await openWorkbench(); return panelSnapshot(); }
    const types = { start: 'RUN_START', pause: 'RUN_PAUSE', resume: 'RUN_RESUME', stop: 'RUN_STOP' };
    const type = types[message.action];
    if (!type) throw new Error('未知快捷操作。');
    const config = { ...state.config };
    for (const key of ['sessions', 'parallel', 'imageRatio', 'promptJitter']) if (message.config?.[key] != null) config[key] = message.config[key];
    await handle({ type, config }, { url: chrome.runtime.getURL('ui/index.html'), tab: sender.tab });
    return panelSnapshot();
  }
  const run = state.run;
  if (message.type === 'GET_STATE') return snapshot();
  if (message.type === 'GET_RUNTIME') return snapshot(false);
  if (message.type === 'RUN_EXPORT') return state.run;
  if (message.type === 'SAVE_CONFIG') {
    state.config = normalizeConfig(message.config);
    await save();
    return snapshot();
  }
  if (message.type === 'LIBRARY_SAVE') {
    state.library = validateLibrary(message.library);
    await save();
    return snapshot();
  }
  if (message.type === 'LIBRARY_RESET') {
    state.library = validateLibrary(await (await fetch(chrome.runtime.getURL('data/conversations.json'))).json());
    await save();
    return snapshot();
  }
  if (message.type === 'RUN_START') {
    if (run && ['running', 'paused'].includes(run.status)) throw new Error('请先停止当前任务，再开始新任务。');
    state.config = normalizeConfig(message.config || state.config);
    state.run = buildRun(state.library, state.config);
    if (Number.isInteger(sender.tab?.windowId)) state.run.windowId = sender.tab.windowId;
    appendLog(state.run, `开始 ${state.config.sessions} 组会话：文字 ${state.config.sessions - state.run.imageSessions} 组（6–15 轮），图片 ${state.run.imageSessions} 组（12–20 轮），${state.config.parallel ? `并发开启：本批同时 ${state.run.concurrencyLimit} 组` : '并发关闭：依次进行'}`);
    // Persist the task intent before creating any tab.
    await save();
    await schedule();
  } else if (message.type === 'RUN_PAUSE') {
    if (run?.status === 'running') {
      run.status = 'paused';
      appendLog(run, '任务已暂停，正在生成的回复仍会被记录。');
      await notify();
      await device.releaseAll();
    }
  } else if (message.type === 'RUN_RESUME') {
    if (run?.status === 'paused') { device.resume(); run.status = 'running'; appendLog(run, '任务已继续。'); await schedule(); }
    await notify();
  } else if (message.type === 'RUN_STOP') {
    if (run && ['running', 'paused'].includes(run.status)) {
      run.status = 'stopped';
      run.finishedAt = Date.now();
      for (const task of run.tasks) if (!TERMINAL.has(task.status)) task.status = 'stopped';
      appendLog(run, '任务已停止。');
      await notify();
      await device.releaseAll();
    }
  } else if (message.type === 'TASK_RETRY' || message.type === 'TASK_RESTART' || message.type === 'TASK_SKIP') {
    if (!run || !['running', 'paused'].includes(run.status)) throw new Error('当前没有可恢复的任务。');
    const task = run.tasks.find(t => t.id === message.taskId);
    if (!task || TERMINAL.has(task.status)) throw new Error('会话已结束。');
    if (message.type === 'TASK_SKIP') {
      task.status = 'skipped';
      task.revision++;
      await closeTaskTab(task);
      appendLog(run, `已跳过「${task.title}」`, 'info', task.id);
    } else if (message.type === 'TASK_RESTART') {
      if (!await closeTaskTab(task)) throw new Error('旧标签页暂时无法关闭，稍后重试。');
      Object.assign(task, { status: 'queued', phase: 'ready', tabId: null, completed: 0, checkpoint: null, recoveryCheckpoint: null, nextAt: 0, transcript: [], error: '', retryAt: 0, turnRetries: 0, revision: task.revision + 1, pageReady: false });
      appendLog(run, `「${task.title}」将从第 1 轮重新开始`, 'info', task.id);
    } else {
      if (task.tabId == null) throw new Error('标签页已关闭，请选择“新开并重来”或“跳过”。');
      await chrome.tabs.get(task.tabId).catch(() => { throw new Error('标签页已关闭，请选择“新开并重来”。'); });
      // 0.1.1 threw this exact error only before button.click(). Its checkpoint is safe to undo.
      if (task.phase === 'dispatching' && !task.checkpoint?.dispatchId && task.error === '发送按钮不可用，请检查网页或在设置中更新发送按钮选择器。') {
        task.checkpoint = null;
        task.phase = 'preparing';
      }
      task.status = 'running';
      task.retryAt = 0;
      task.error = '';
      if (task.checkpoint) task.checkpoint.waitStartedAt = Date.now();
      // Keep dispatching/waiting checkpoints. An uncertain send is never automatically repeated.
      appendLog(run, `重新检查「${task.title}」`, 'info', task.id);
    }
    settleRun(run);
    await schedule();
    await notify();
  } else if (message.type === 'PULL') {
    const task = run?.tasks.find(t => t.tabId === sender.tab.id);
    if (!task || !ACTIVE.has(task.status)) return null;
    return { runId: run.id, status: run.status, config: run.config, task: { ...task, transcript: undefined } };
  } else if (pageCommand) {
    const { run: current, task } = activeTask(sender, message.taskId);
    requireTurn(task, message);
    task.heartbeatAt = Date.now();
    if (message.type === 'HEARTBEAT') return { status: current.status, taskStatus: task.status, revision: task.revision };
    if (message.type === 'PAGE_READY') {
      if (task.status === 'opening') { task.status = 'running'; task.pageReady = true; await schedule(); }
    } else if (message.type === 'CLAIM') {
      if (current.status !== 'running' || task.status !== 'running' || !['ready', 'preparing'].includes(task.phase) || Date.now() < Math.max(task.nextAt, task.retryAt || 0)) return { allowed: false };
      task.phase = 'preparing';
    } else if (message.type === 'COMMIT') {
      if (current.status !== 'running' || task.status !== 'running' || task.phase !== 'preparing') return { allowed: false };
      task.checkpoint = { ...message.checkpoint, sentAt: Date.now(), dispatchId: crypto.randomUUID() };
      task.phase = 'dispatching';
      await save();
      return { allowed: true, dispatchId: task.checkpoint.dispatchId };
    } else if (message.type === 'ABORT_DISPATCH') {
      if (task.phase !== 'dispatching' || !message.dispatchId || task.checkpoint?.dispatchId !== message.dispatchId) return { allowed: false };
      task.checkpoint = null;
      task.phase = 'preparing';
    } else if (message.type === 'CANCEL_PREPARE') {
      if (task.phase === 'preparing') task.phase = 'ready';
    } else if (message.type === 'ADOPT_SENT') {
      if (current.status !== 'running' || !task.recoveryCheckpoint || !['ready', 'preparing'].includes(task.phase)) return { allowed: false };
      task.checkpoint = { ...task.recoveryCheckpoint, waitStartedAt: Date.now() };
      task.recoveryCheckpoint = null; task.phase = 'waiting';
      appendLog(current, `「${task.title}」已找到第 ${task.completed + 1} 轮消息，继续等待回复`, 'info', task.id);
    } else if (message.type === 'SENT') {
      if (!['dispatching', 'waiting'].includes(task.phase) || !task.checkpoint) throw new Error('发送检查点不存在。');
      if (task.phase === 'dispatching') appendLog(current, `「${task.title}」发送第 ${task.completed + 1}/${task.turns.length} 轮`, 'info', task.id);
      task.phase = 'waiting';
      task.url = sender.tab.url || message.url || '';
    } else if (message.type === 'COMPLETE') {
      if (!['dispatching', 'waiting'].includes(task.phase) || !task.checkpoint) throw new Error('此轮尚未确认发送。');
      const prompt = task.turns[task.completed];
      task.transcript.push({ turn: task.completed + 1, prompt: prompt.text, sourcePrompt: prompt.sourceText || prompt.text, jittered: Boolean(prompt.sourceText), kind: prompt.kind, response: String(message.response || '').slice(0, 100000), images: (message.images || []).filter(x => typeof x === 'string').slice(0, 20), at: Date.now(), url: sender.tab.url || '' });
      task.completed++;
      task.checkpoint = null;
      task.recoveryCheckpoint = null; task.turnRetries = 0; task.retryAt = 0; task.error = '';
      task.phase = 'ready';
      task.nextAt = Date.now() + (current.config.minDelay + Math.random() * (current.config.maxDelay - current.config.minDelay)) * 1000;
      if (task.completed === task.turns.length) {
        task.status = 'done';
        task.closePending = true;
        appendLog(current, `「${task.title}」全部完成`, 'success', task.id);
        await closeTaskTab(task);
      } else appendLog(current, `「${task.title}」第 ${task.completed} 轮回复已完成`, 'info', task.id);
      settleRun(current);
      await schedule();
    } else if (message.type === 'BLOCK' || message.type === 'RECOVER') {
      await recover(task, String(message.reason || '网页暂时不可用。').slice(0, 1000), ['wait', 'skip'].includes(message.kind) ? message.kind : 'retry');
      settleRun(current); await schedule();
    }
  } else throw new Error('未知操作。');
  await save();
  return pageCommand ? { allowed: true } : snapshot();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEVICE_INPUT') {
    if (!sender.tab || sender.id && sender.id !== chrome.runtime.id) { sendResponse({ ok: false, error: '缺少会话标签页。' }); return; }
    device.perform(sender.tab.id, message).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  serialize(() => handle(message, sender)).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) { await openWorkbench(); return; }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'OVERLAY_TOGGLE' });
    if (!response?.ok) throw new Error('悬浮菜单尚未注入。');
  }
  catch {
    try {
      const isChatGPT = /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(tab.url);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: isChatGPT ? ['content/overlay.js', 'content/adapter-chatgpt.js', 'content/runner.js'] : ['content/overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'OVERLAY_TOGGLE' });
    } catch { await openWorkbench(); }
  }
});
chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
  const task = state.run?.tasks.find(t => t.tabId === tabId && ACTIVE.has(t.status));
  if (task) { task.tabId = null; await recover(task, '会话标签页已关闭。', 'skip'); await schedule(); await save(); }
}));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'xuliao-watchdog') return;
  serialize(async () => {
    const run = state.run;
    if (!run) return;
    if (!['running', 'paused'].includes(run.status)) { await schedule(); return; }
    for (const task of run.tasks.filter(t => ACTIVE.has(t.status))) {
      const tab = task.tabId == null ? null : await chrome.tabs.get(task.tabId).catch(() => null);
      if (!tab) { task.tabId = null; await recover(task, '会话标签页不存在。', 'skip'); }
      else if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(tab.url || '')) await recover(task, '标签页离开了 ChatGPT。', 'skip');
      else if (task.status === 'opening' && Date.now() - task.openedAt > 90000 || task.status === 'running' && Date.now() - task.heartbeatAt > 90000) {
        await recover(task, '页面长时间没有响应。');
        task.heartbeatAt = Date.now(); task.openedAt = Date.now();
        if (!TERMINAL.has(task.status)) await chrome.tabs.reload(task.tabId).catch(() => {});
      }
    }
    await schedule();
    await save();
  });
});
async function ensureAlarm() { await chrome.alarms.create('xuliao-watchdog', { periodInMinutes: 0.5 }); }
chrome.runtime.onInstalled.addListener(() => serialize(async () => { await ensureAlarm(); await save(); }));
chrome.runtime.onStartup.addListener(() => serialize(async () => {
  await ensureAlarm();
  if (state.run?.status === 'running') {
    state.run.status = 'paused';
    appendLog(state.run, '浏览器已重启。检查会话标签页后，可继续任务。');
    await save();
  }
}));
// Recreate a missing alarm after worker activation without resuming a stopped run.
ensureAlarm();
chrome.debugger.onDetach.addListener((source, reason) => {
  if (device.detached(source.tabId, reason)) serialize(async () => {
    if (state.run?.status === 'running') { state.run.status = 'paused'; appendLog(state.run, '设备输入被用户取消，批次已暂停。'); await notify(); await save(); }
  });
});
