import { readFile } from 'node:fs/promises';
let sequence = 0;
const libraryJSON = await readFile(new URL('../data/conversations.json', import.meta.url), 'utf8');
const historyJSON = await readFile(new URL('../data/builtin-history.json', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

export async function harness(t, saved = {}, initialTabs = []) {
  let clock = 1_800_000_000_000;
  const oldNow = Date.now;
  const oldFetch = globalThis.fetch;
  const oldChrome = globalThis.chrome;
  Date.now = () => clock;
  globalThis.fetch = async url => new Response(String(url).includes('builtin-history') ? historyJSON : libraryJSON, { headers: { 'content-type': 'application/json' } });
  const storage = structuredClone(saved);
  const tabs = new Map(initialTabs.map(tab => [tab.id, structuredClone(tab)]));
  let nextId = Math.max(0, ...tabs.keys()) + 1;
  const inputHandlers = new Map();
  const operations = [], removedTabs = new Map();
  const deviceEvents = [];
  const attached = new Set();
  const chrome = {
    debugger: {
      onDetach: event(),
      async attach({ tabId }) { attached.add(tabId); },
      async detach({ tabId }) { attached.delete(tabId); },
      async sendCommand({ tabId }, method, params) { deviceEvents.push({ tabId, method, params }); return inputHandlers.get(tabId)?.(method, params); }
    },
    runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onInstalled: event(), onStartup: event() },
    action: { onClicked: event() },
    storage: { local: { async get() { return structuredClone(storage); }, async set(data) { Object.assign(storage, structuredClone(data)); } } },
    tabs: {
      onRemoved: event(), async remove(id) { if (!tabs.has(id)) throw new Error('missing tab'); operations.push({action:'remove',id}); removedTabs.set(id,tabs.get(id)); tabs.delete(id); }, async reload(id) { if (!tabs.has(id)) throw new Error('missing tab'); tabs.get(id).reloads = (tabs.get(id).reloads || 0) + 1; }, async create(data) { operations.push({action:'create',data}); if(data.active) for(const tab of tabs.values()) tab.active=false; const tab = { ...data, id: nextId++, windowId: 1, status: 'complete' }; tabs.set(tab.id, tab); return { ...tab }; },
      async get(id) { if (!tabs.has(id)) throw new Error('missing tab'); return { ...tabs.get(id) }; },
      async query() { return [...tabs.values()]; }, async sendMessage() { return { ok: true }; },
      async update(id, data) { if(data.active) for(const tab of tabs.values()) tab.active=false; operations.push({action:'update',id,data}); Object.assign(tabs.get(id), data); return tabs.get(id); }
    },
    windows: { async update() {} },
    alarms: { onAlarm: event(), async create() {} }
  };
  globalThis.chrome = chrome;
  await import(`../background.js?test=${++sequence}`);
  t.after(() => { Date.now = oldNow; globalThis.fetch = oldFetch; globalThis.chrome = oldChrome; });
  const message = async (type, payload = {}, tabId = null) => {
    const sender = tabId == null ? { url: chrome.runtime.getURL('ui/index.html') } : { tab: { id: tabId, url: 'https://chatgpt.com/c/test' }, url: 'https://chatgpt.com/c/test' };
    const result = await new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ type, ...payload }, sender, resolve));
    if (!result.ok) throw new Error(result.error);
    return structuredClone(result.data);
  };
  const readyAll = async () => { for(let n=0;n<4;n++){const task=storage.run.tasks.find(t=>t.status==='opening');if(!task)break;await message('PAGE_READY',{taskId:task.id,turn:task.completed},task.tabId);} };
  const start = async config => { await message('RUN_START', { config: { sessions: 3, includeImages:false, minDelay: 2, maxDelay: 2, ...config } }); await readyAll(); return message('GET_STATE'); };
  const complete = async task => {
    const payload = { taskId: task.id, turn: task.completed };
    await message('PULL', {}, task.tabId);
    await message('CLAIM', payload, task.tabId);
    await message('COMMIT', { ...payload, checkpoint: { userCount: task.completed, assistantCount: task.completed } }, task.tabId);
    await message('SENT', payload, task.tabId);
    await message('COMPLETE', { ...payload, response: '本轮的完整回复', images: [] }, task.tabId);
    clock += 3000;
  };
  return {
    message, start, readyAll, complete, storage, tabs, removedTabs, operations, chrome, inputHandlers, deviceEvents, attached,
    async completeTask(id) { await readyAll(); while (!(['done', 'skipped', 'stopped'].includes(storage.run.tasks.find(t => t.id === id).status))) await complete(storage.run.tasks.find(t => t.id === id)); }, advance(ms) { clock += ms; },
    async reloadWorker() {
      chrome.debugger.onDetach.listeners = [];
      chrome.runtime.onMessage.listeners = [];
      chrome.runtime.onInstalled.listeners = [];
      chrome.runtime.onStartup.listeners = [];
      chrome.alarms.onAlarm.listeners = [];
      chrome.tabs.onRemoved.listeners = [];
      chrome.action.onClicked.listeners = [];
      await import(`../background.js?test=${++sequence}`);
    }
  };
}
