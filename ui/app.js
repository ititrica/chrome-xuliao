import { request, preview } from './bridge.js';
import { eligibleLibrary, imageAllocation, normalizeConfig, validateLibrary, progress } from '../lib/core.js';
import { lexicon, jitterConversation } from '../lib/prompt-jitter.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let state;
let selectedId;
let editingId;
let toastTimer;
let latestRun = '';
let pending = false;
let vocabularyLimit = 120;
const phaseLabels = { ready: '准备下一轮', preparing: '正在输入', dispatching: '确认发送', waiting: '等待回复' };
const statusLabels = { queued: '排队中', opening: '打开页面', running: '进行中', blocked: '自动恢复', done: '已完成', skipped: '已跳过', stopped: '已停止' };

function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `toast${error ? ' error' : ''}`; $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8000 : 4000);
}
async function action(type, payload = {}) {
  if (pending) return null;
  pending = true;
  try { state = { ...state, ...await request(type, payload) }; renderRun(true); return state; }
  catch (error) { toast(error.message, true); return null; }
  finally { pending = false; }
}
function showView(view) {
  if (!['workspace', 'library', 'vocabulary', 'settings'].includes(view)) view = 'workspace';
  const titles = { workspace: ['运行任务', '安排一组连续对话', '选好话题和节奏，让每一轮自然接续。'], library: ['聊天库', '每一个话题，都有后续', '从开场到收尾，浏览和编辑完整的对话脚本。'], vocabulary: ['抖动词库', '让熟悉的话题，有新的变化', '按语义分类抽取，把变化连贯地带入每一轮。'], settings: ['适配设置', '让续聊适应你的网页', '调整等待时间与页面定位，保持对话顺利衔接。'] };
  $$('.view').forEach(element => element.hidden = element.id !== `${view}-view`);
  $$('.nav-item').forEach(button => { button.classList.toggle('active', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  [$('#page-location').textContent, $('#page-title').textContent, $('#page-subtitle').textContent] = titles[view];
  history.replaceState(null, '', `#${view}`);
}
function planConfig() {
  const form = $('#plan-form'); const raw = Object.fromEntries(new FormData(form));
  return normalizeConfig({ ...state.config, ...raw, jitterKinds: $$('#jitter-options input:checked').map(input => input.value), imageRatio: form.elements.imageRatio.value, promptJitter: form.elements.promptJitter.checked, parallel: form.elements.parallel.checked, typing: form.elements.typing.checked, includeImages: form.elements.includeImages.checked, categories: $$('#category-checks input:checked').map(input => input.value) });
}
function fillConfig() {
  const form = $('#plan-form');
  for (const [key, value] of Object.entries(state.config)) {
    if (typeof value === 'boolean' && form.elements[key]) form.elements[key].checked = value;
    else if (form.elements[key] && !Array.isArray(value) && typeof value !== 'object') form.elements[key].value = value;
  }
  const settings = $('#settings-form');
  $$('#jitter-options input').forEach(input => input.checked = state.config.jitterKinds.includes(input.value));
  settings.elements.responseTimeout.value = state.config.responseTimeout;
  settings.elements.imageTimeout.value = state.config.imageTimeout;
  $('#selector-fields').innerHTML = Object.entries({ editor: '输入框', send: '发送按钮', stop: '停止生成按钮', user: '用户消息', assistant: 'AI 回复内容', complete: '回复完成标记（回复所在区块内）', bottom: '回到底部按钮' }).map(([key, title]) => `<label>${title}<input name="selector-${key}" value="${escape(state.config.selectors[key])}" placeholder="留空使用内置规则" spellcheck="false"></label>`).join('');
  renderCategories(); updatePlan();
}
function renderCategories() {
  const categories = [...new Set(state.library.map(item => item.category))];
  const checked = state.config.categories;
  $('#bank-count').textContent = state.library.length;
  $('#category-checks').innerHTML = categories.map(category => `<label><input type="checkbox" value="${escape(category)}"${checked.includes(category) ? ' checked' : ''}>${escape(category)}</label>`).join('');
  const previous = $('#library-category').value;
  $('#library-category').innerHTML = '<option value="">全部主题</option>' + categories.map(category => `<option value="${escape(category)}">${escape(category)}</option>`).join('');
  $('#library-category').value = categories.includes(previous) ? previous : '';
  $('#category-suggestions').innerHTML = categories.map(category => `<option value="${escape(category)}"></option>`).join('');
}
function updatePlan() {
  const config = planConfig();
  $('#jitter-options').classList.toggle('muted', !config.promptJitter);
  $('#mode-description').textContent = config.parallel ? '并发已开启，每批随机同时运行 1–3 组。' : '并发已关闭，一组结束后再开启下一组。';
  const allocation = imageAllocation(state.library, config);
  $('#imageRatio').disabled = !config.includeImages;
  $('#image-ratio-value').textContent = `${config.includeImages ? config.imageRatio : 0}%`;
  $('#image-allocation').textContent = config.includeImages ? `本批预计图片 ${allocation.images} 组、文字 ${allocation.text} 组；按组数取整，库存不足自动补足。` : '图片创作已关闭，本批只抽取文字会话。';
  $('#eligible-count').textContent = eligibleLibrary(state.library, config).length;
  $('#topic-summary').textContent = config.categories.length ? `${config.categories.length} 个主题` : '全部主题';
}
function renderRun(force = false) {
  const { run } = state;
  const signature = JSON.stringify(run);
  if (!force && latestRun === signature) return;
  latestRun = signature;
  const active = run && ['running', 'paused'].includes(run.status);
  const blocked = run?.tasks.some(t => t.status === 'blocked');
  $('#global-status').className = `status-pill${blocked ? ' blocked' : run?.status === 'running' ? ' running' : ''}`;
  $('#global-status').innerHTML = `<i></i>${blocked ? '正在自动恢复' : ({ running: '正在运行', paused: '任务已暂停', completed: run?.tasks.some(t => t.status === 'skipped') ? '本批已结束（含跳过）' : '本批已完成', stopped: '任务已停止' }[run?.status] || '准备就绪')}`;
  $('#start-button').disabled = Boolean(active);
  $('#pause-button').disabled = !active;
  $('#pause-button').textContent = run?.status === 'paused' ? '继续' : '暂停';
  $('#stop-button').disabled = !active;
  $('#export-run').disabled = !run;
  $('#queue-count').textContent = run?.tasks.length || 0;
  $('#run-summary').hidden = !run;
  if (!run) return;
  const p = progress(run);
  $('#run-progress-label').textContent = `已完成 ${p.sessions} / ${run.tasks.length} 组会话`;
  $('#run-progress-count').textContent = `${p.completed} / ${p.total} 轮`;
  $('#run-progress').max = p.total; $('#run-progress').value = p.completed;
  $('#run-settings').textContent = `${run.config.parallel ? `并发开启 · 本批同时 ${run.concurrencyLimit} 组` : '并发关闭 · 依次进行'}　·　文字 6–15 轮 / 图片 12–20 轮　·　间隔 ${run.config.minDelay}–${run.config.maxDelay} 秒`;
  $('#queue-list').innerHTML = run.tasks.map((task, i) => `<div class="task-item"><span class="task-number">${String(i + 1).padStart(2, '0')}</span><div class="task-main"><div class="task-top"><strong>${escape(task.title)}</strong><span class="task-state ${task.status}">${escape(statusLabels[task.status])}</span></div><div class="task-meta"><span>${escape(task.category)}</span><span>${task.completed} / ${task.turns.length} 轮</span>${task.status === 'running' ? `<span>${run.status === 'paused' && !['waiting', 'dispatching'].includes(task.phase) ? '已暂停' : escape((['waiting', 'dispatching'].includes(task.phase) && task.waitStatus) || phaseLabels[task.phase] || '')}</span>` : ''}${task.tabId == null && task.url ? `<button class="text-button" data-url="${escape(task.url)}">打开已保存会话</button>` : ''}${task.tabId != null ? `<button class="text-button" data-open="${task.tabId}">查看页面</button>` : ''}</div><div class="task-rounds" aria-label="已完成 ${task.completed} 轮">${task.turns.map((_, j) => `<span class="${j < task.completed ? 'done' : j === task.completed && task.status === 'running' ? 'current' : ''}"></span>`).join('')}</div>${task.error && task.status !== 'done' ? `<p class="task-error">${escape(task.error)}${task.retryAt > Date.now() ? ' · 等待自动重试' : ''}</p>` : ''}</div></div>`).join('');
  $('#log-list').innerHTML = [...run.logs].reverse().slice(0, 50).map(log => `<div class="log-entry ${escape(log.level)}"><time>${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>${escape(log.text)}</span></div>`).join('') || '<p class="empty-log">等待任务开始。</p>';
}
function renderLibrary() {
  const query = $('#library-search').value.trim().toLowerCase(); const category = $('#library-category').value;
  const items = state.library.filter(item => (!category || item.category === category) && (!query || `${item.title} ${item.category} ${item.turns.map(t => t.text).join(' ')}`.toLowerCase().includes(query)));
  if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id;
  $('#filtered-count').textContent = `${items.length} 组会话`;
  $('#library-list').innerHTML = items.length ? items.map(item => `<button class="library-item${item.id === selectedId ? ' selected' : ''}" data-select="${escape(item.id)}" role="listitem"><strong>${escape(item.title)}</strong><small><span>${escape(item.category)}</span><span>${item.turns.length} 轮</span>${item.turns.some(t => t.kind === 'image') ? '<span class="image-tag">含生图</span>' : ''}</small></button>`).join('') : '<p class="list-empty">没有找到会话，试试其他关键词。</p>';
  const item = state.library.find(item => item.id === selectedId);
  $('#conversation-preview').innerHTML = item ? `<div class="preview-header"><div><h2>${escape(item.title)}</h2><p>${escape(item.category)}　·　${item.turns.length} 轮连续对话</p></div><div class="preview-actions"><button id="preview-jitter" class="button">预览抖动</button><button id="edit-selected" class="button">编辑会话</button></div></div>${item.turns.map((turn, i) => `<section class="turn-preview"><span class="turn-label">${String(i + 1).padStart(2, '0')}</span><div class="turn-copy"><p>${escape(turn.text)}</p>${turn.kind === 'image' ? '<span class="turn-kind">此轮请求生成图片</span>' : ''}</div></section>`).join('')}` : '<p class="list-empty">选择或新建一组会话。</p>';
}
function renderVocabulary() {
  const query = $('#vocabulary-search').value.trim().toLowerCase(), id = $('#vocabulary-category').value;
  const groups = lexicon.categories.filter(group => !id || group.id === id).map(group => ({ ...group, words: group.words.filter(word => !query || `${group.label} ${word}`.toLowerCase().includes(query)) })).filter(group => group.words.length);
  const total = groups.reduce((sum, group) => sum + group.words.length, 0); let remaining = vocabularyLimit;
  $('#vocabulary-filtered').textContent = `${total.toLocaleString()} 条 · ${groups.length} 类`;
  $('#vocabulary-list').innerHTML = groups.map(group => {
    const words = group.words.slice(0, remaining); remaining -= words.length;
    return words.length ? `<section class="panel vocabulary-card"><div class="panel-heading"><h2>${escape(group.label)}</h2><span class="subtle">${group.words.length} 条</span></div><div class="word-chips">${words.map(word => `<span>${escape(word)}</span>`).join('')}</div></section>` : '';
  }).join('') || '<p class="list-empty">没有找到词语，试试其他关键词。</p>';
  $('#more-vocabulary').hidden = total <= vocabularyLimit;
}
function previewJitter() {
  const item = state.library.find(entry => entry.id === selectedId); if (!item) return;
  const config = planConfig();
  const result = config.promptJitter ? jitterConversation(item.turns, item.category, Math.random, config.jitterKinds) : { turns: item.turns, jitter: { theme: '', replacements: [] } };
  $('#jitter-preview').innerHTML = `<p class="field-help">${escape(item.title)} · ${config.promptJitter ? '每轮语气也会随机变化' : '抖动已关闭，使用原文'}</p><div class="jitter-changes">${result.jitter.theme ? `<span>主题侧重：${escape(result.jitter.theme)}</span>` : ''}${result.jitter.replacements.map(row => `<span>${escape(row.from)} → ${escape(row.to)}<small>${escape(row.category)}</small></span>`).join('')}</div>${result.turns.map((turn, index) => `<section class="turn-preview"><span class="turn-label">${String(index + 1).padStart(2, '0')}</span><div class="turn-copy"><p>${escape(turn.text)}</p></div></section>`).join('')}`;
  if (!$('#jitter-dialog').open) $('#jitter-dialog').showModal();
  $('#jitter-dialog').scrollTop = 0;
}
async function confirmAction(title, description, label = '确认') {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-accept').textContent = label;
  const dialog = $('#confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true }));
}
function editorTurns() {
  return $$('.turn-editor').map(element => ({ text: element.querySelector('textarea').value, kind: element.querySelector('select').value }));
}
function renderTurnEditors(turns) {
  $('#turn-editors').innerHTML = turns.map((turn, i) => `<div class="turn-editor"><div class="turn-editor-header"><strong>第 ${i + 1} 轮</strong><select aria-label="第 ${i + 1} 轮类型"><option value="text">文字对话</option><option value="image"${turn.kind === 'image' ? ' selected' : ''}>请求生图</option></select><button class="text-button" type="button" data-remove-turn="${i}">移除</button></div><label class="sr-only" for="turn-${i}">第 ${i + 1} 轮提示词</label><textarea id="turn-${i}" required maxlength="12000">${escape(turn.text)}</textarea></div>`).join('');
  $('#add-turn').disabled = turns.length >= 20;
}
function openEditor(item) {
  editingId = item?.id || null; const form = $('#edit-form');
  $('#edit-title').textContent = item ? '编辑会话' : '新建会话'; form.elements.title.value = item?.title || ''; form.elements.category.value = item?.category || '自定义';
  renderTurnEditors(item?.turns || Array.from({ length: 6 }, () => ({ text: '', kind: 'text' })));
  $('#delete-conversation').hidden = !item; $('#edit-error').textContent = ''; $('#edit-dialog').showModal();
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function dateStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

$$('.nav-item').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('.brand').addEventListener('click', () => showView('workspace'));
$('#browse-library').addEventListener('click', () => showView('library'));
$('#browse-vocabulary').addEventListener('click', () => showView('vocabulary'));
$('#export-vocabulary').addEventListener('click', () => download(`续聊-分类抖动词库.json`, lexicon));
['#vocabulary-search', '#vocabulary-category'].forEach(selector => $(selector).addEventListener(selector.includes('search') ? 'input' : 'change', () => { vocabularyLimit = 120; renderVocabulary(); }));
$('#more-vocabulary').addEventListener('click', () => { vocabularyLimit += 120; renderVocabulary(); });
$('#close-jitter').addEventListener('click', () => $('#jitter-dialog').close());
$('#resample-jitter').addEventListener('click', previewJitter);
$('#plan-form').addEventListener('input', updatePlan);
$('#plan-form').addEventListener('change', updatePlan);
$('#plan-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (Number($('#maxDelay').value) < Number($('#minDelay').value)) return toast('最长间隔不能短于最短间隔。', true);
  const config = planConfig();
  if (eligibleLibrary(state.library, config).length < config.sessions) return toast('符合条件的会话不足，请减少数量或扩大主题范围。', true);
  if (await action('RUN_START', { config })) toast(preview ? '已生成预览队列。浏览器插件中会实际执行。' : '任务已启动，正在打开 ChatGPT 会话。');
});
$('#pause-button').addEventListener('click', () => action(state.run?.status === 'paused' ? 'RUN_RESUME' : 'RUN_PAUSE'));
$('#stop-button').addEventListener('click', () => action('RUN_STOP'));
$('#queue-list').addEventListener('click', async event => {
  const saved = event.target.closest('[data-url]');
  if (saved && !preview && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(saved.dataset.url)) await chrome.tabs.create({ url: saved.dataset.url, active: true });
  const open = event.target.closest('[data-open]');
  if (open && !preview) { try { const tab = await chrome.tabs.update(Number(open.dataset.open), { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch { toast('标签页已关闭，请新开并重来。', true); } }
  const button = event.target.closest('[data-task-action]'); if (!button) return;
  if (button.dataset.taskAction === 'TASK_RESTART' && !await confirmAction('新开并重新开始这组会话', '会在新标签页从第 1 轮开始。原任务标签页会关闭，本组当前的记录会被替换。', '新开并重来')) return;
  await action(button.dataset.taskAction, { taskId: button.dataset.id });
});
$('#export-run').addEventListener('click', async () => { try { const run = await request('RUN_EXPORT'); download(`续聊-对话记录-${dateStamp()}.json`, { exportedAt: new Date().toISOString(), run }); } catch (error) { toast(error.message, true); } });
$('#library-search').addEventListener('input', renderLibrary); $('#library-category').addEventListener('change', renderLibrary);
$('#library-list').addEventListener('click', event => { const button = event.target.closest('[data-select]'); if (button) { selectedId = button.dataset.select; renderLibrary(); } });
$('#conversation-preview').addEventListener('click', event => { if (event.target.closest('#edit-selected')) openEditor(state.library.find(item => item.id === selectedId)); if (event.target.closest('#preview-jitter')) previewJitter(); });
$('#new-conversation').addEventListener('click', () => openEditor(null));
['#close-editor', '#cancel-editor'].forEach(selector => $(selector).addEventListener('click', () => $('#edit-dialog').close()));
$('#add-turn').addEventListener('click', () => { const turns = editorTurns(); if (turns.length < 20) renderTurnEditors([...turns, { text: '', kind: 'text' }]); });
$('#turn-editors').addEventListener('click', event => { const button = event.target.closest('[data-remove-turn]'); if (button) { const turns = editorTurns(); if (turns.length <= 1) return toast('每组会话至少需要一轮。', true); turns.splice(Number(button.dataset.removeTurn), 1); renderTurnEditors(turns); } });
$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target;
  try {
    const id = editingId || `custom-${crypto.randomUUID()}`;
    const item = { id, title: form.elements.title.value, category: form.elements.category.value, turns: editorTurns() };
    const library = validateLibrary(editingId ? state.library.map(entry => entry.id === editingId ? item : entry) : [...state.library, item]);
    if (await action('LIBRARY_SAVE', { library })) { selectedId = id; $('#edit-dialog').close(); renderCategories(); renderLibrary(); updatePlan(); toast('会话已保存。'); }
  } catch (error) { $('#edit-error').textContent = error.message; }
});
$('#delete-conversation').addEventListener('click', async () => {
  if (state.library.length <= 1) return toast('聊天库至少需要保留一组会话。', true);
  if (!await confirmAction('删除这组会话', '删除仅影响聊天库，已经启动的任务会使用原来的提示词。', '删除')) return;
  if (await action('LIBRARY_SAVE', { library: state.library.filter(item => item.id !== editingId) })) { $('#edit-dialog').close(); renderCategories(); renderLibrary(); updatePlan(); toast('会话已删除。'); }
});
$('#export-library').addEventListener('click', () => download(`续聊-聊天库-${dateStamp()}.json`, { version: 3, conversations: state.library }));
$('#import-library').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('请选择小于 8 MB 的聊天库文件。');
    const library = validateLibrary(JSON.parse(await file.text()));
    if (!await confirmAction('替换当前聊天库', `将导入 ${library.length} 组会话并替换当前聊天库。可以先取消并导出备份。已启动的任务不受影响。`, '导入并替换')) return;
    if (await action('LIBRARY_SAVE', { library })) { renderCategories(); renderLibrary(); updatePlan(); toast(`已导入 ${library.length} 组会话。`); }
  } catch (error) { toast(`导入失败：${error.message}`, true); }
  finally { event.target.value = ''; }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  const selectors = Object.fromEntries(Object.keys(state.config.selectors).map(key => [key, data[`selector-${key}`].trim()]));
  try { for (const [key, selector] of Object.entries(selectors)) if (selector) { try { document.querySelector(selector); } catch { throw new Error(`「${key}」的 CSS 选择器无效。`); } } }
  catch (error) { return toast(error.message, true); }
  if (await action('SAVE_CONFIG', { config: { ...planConfig(), responseTimeout: data.responseTimeout, imageTimeout: data.imageTimeout, selectors } })) toast('设置已保存，下批任务使用新设置。');
});
$('#reset-library').addEventListener('click', async () => {
  if (!await confirmAction('恢复内置聊天库', '当前聊天库将被替换为内置的 380 组会话。请先导出需要保留的自定义内容。', '恢复')) return;
  if (await action('LIBRARY_RESET')) { renderCategories(); renderLibrary(); updatePlan(); toast('已恢复 380 组内置会话。'); }
});
async function initialize() {
  state = await request('GET_STATE'); $('#preview-banner').hidden = !preview;
  $('#vocabulary-nav-count').textContent = lexicon.uniqueCount.toLocaleString();
  $('#vocabulary-summary').textContent = `${lexicon.uniqueCount.toLocaleString()} 个不同词语与短语 · ${lexicon.categories.length} 类`;
  $('#vocabulary-category').innerHTML += lexicon.categories.map(group => `<option value="${escape(group.id)}">${escape(group.label)}</option>`).join('');
  renderVocabulary();
  fillConfig(); renderRun(true); renderLibrary(); showView(location.hash.slice(1) || 'workspace');
  setInterval(async () => { if (pending) return; try { state = { ...state, ...await request('GET_RUNTIME') }; renderRun(); } catch { /* A transient worker restart is retried on the next tick. */ } }, 2000);
}
initialize().catch(error => toast(error.message, true));
