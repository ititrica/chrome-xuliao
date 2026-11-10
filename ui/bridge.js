import { normalizeConfig, migrateConfig, mergeBuiltins, validateLibrary, buildRun, appendLog } from '../lib/core.js';
export const preview = location.protocol !== 'chrome-extension:';
let demo;
async function demoState() {
  if (!demo) {
    const builtin = validateLibrary(await (await fetch('../data/conversations.json')).json());
    const saved = JSON.parse(localStorage.getItem('xuliao-preview-library') || 'null');
    let library = saved ? validateLibrary(saved) : builtin;
    if (saved && localStorage.getItem('xuliao-preview-version') !== '3') library = await mergeBuiltins(library, builtin, await (await fetch('../data/builtin-history.json')).json());
    demo = { config: migrateConfig(JSON.parse(localStorage.getItem('xuliao-preview-config') || 'null'), Number(localStorage.getItem('xuliao-preview-version'))), library, run: null };
    localStorage.setItem('xuliao-preview-config', JSON.stringify(demo.config));
    localStorage.setItem('xuliao-preview-library', JSON.stringify(demo.library));
    localStorage.setItem('xuliao-preview-version', '3');
  }
  return demo;
}
export async function request(type, payload = {}) {
  if (!preview) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '工作台连接中断，请重新打开插件。');
    return result.data;
  }
  const state = await demoState();
  if (type === 'GET_RUNTIME' || type === 'GET_STATE') return structuredClone(state);
  if (type === 'SAVE_CONFIG') state.config = normalizeConfig(payload.config);
  if (type === 'LIBRARY_SAVE') state.library = validateLibrary(payload.library);
  if (type === 'LIBRARY_RESET') state.library = validateLibrary(await (await fetch('../data/conversations.json')).json());
  if (type === 'RUN_START') {
    if (state.run && ['running', 'paused'].includes(state.run.status)) throw new Error('请先停止当前预览任务。');
    state.config = normalizeConfig(payload.config);
    state.run = buildRun(state.library, state.config);
    appendLog(state.run, '预览：已生成随机队列。加载插件后才会执行网页对话。');
  }
  if (type === 'RUN_PAUSE') state.run.status = 'paused';
  if (type === 'RUN_RESUME') state.run.status = 'running';
  if (type === 'RUN_STOP') { state.run.status = 'stopped'; state.run.tasks.forEach(t => t.status = 'stopped'); appendLog(state.run, '预览任务已停止。'); }
  if (type === 'RUN_EXPORT') return structuredClone(state.run);
  localStorage.setItem('xuliao-preview-config', JSON.stringify(state.config));
  localStorage.setItem('xuliao-preview-library', JSON.stringify(state.library));
  return structuredClone(state);
}
