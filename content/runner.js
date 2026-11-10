(() => {
  'use strict';
  if (globalThis.__xuliaoRunner) return;
  globalThis.__xuliaoRunner = true;
  let busy = false, cancelled = false, adapter;
  let stability = { key: '', fingerprint: '', since: 0 };
  let idleWait = { key: '', since: 0 };
  let readyWait = { key: '', since: 0 }, lastBottomAt = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function send(type, payload = {}, job) {
    const identity = job ? { runId: job.runId, taskId: job.task.id, turn: job.task.completed, revision: job.task.revision } : {};
    const result = await chrome.runtime.sendMessage({ type, ...identity, ...payload });
    if (!result?.ok) throw new Error(result?.error || '插件连接中断');
    return result.data;
  }
  const badge = (label, tone = '') => globalThis.XuliaoOverlay?.setPageStatus(label, tone);
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'CONTROL') { cancelled = message.status !== 'running'; respond({ ok: true }); }
  });
  async function guard(job) {
    if (cancelled) throw new Error('XULIAO_CANCELLED');
    const state = await send('HEARTBEAT', {}, job);
    if (state.status !== 'running' || state.taskStatus !== 'running' || state.revision !== job.task.revision || cancelled) throw new Error('XULIAO_CANCELLED');
  }
  async function input(job, action, node, text) {
    await guard(job);
    return send('DEVICE_INPUT', { action, ...(node ? { point: adapter.point(node) } : {}), ...(text != null ? { text } : {}) }, job);
  }
  async function prepare(job) {
    const { task } = job, prompt = task.turns[task.completed];
    // An acknowledgment may arrive after a failed click response or after a reload.
    if (task.recoveryCheckpoint && adapter.sentUser(task.recoveryCheckpoint, prompt.text)) {
      await send('ADOPT_SENT', {}, job); return;
    }
    if (adapter.isBusy()) {
      const key = `${job.runId}/${task.id}/${task.completed}`;
      if (idleWait.key !== key) idleWait = { key, since: Date.now() };
      if (Date.now() - idleWait.since < 45000) { await guard(job); return; }
      const stop = adapter.stopButton();
      if (stop) await input(job, 'stop', stop);
      throw new Error('已有回复长时间未结束，已尝试停止并重新准备。');
    }
    idleWait.key = '';
    const editor = adapter.editor();
    if (!editor) throw new Error('未找到输入框，将重新加载网页后重试。');
    const claim = await send('CLAIM', {}, job);
    if (!claim.allowed) return;
    await input(job, 'clear', editor);
    const pieces = Array.from(prompt.text);
    const size = job.config.typing ? 1 : 64;
    for (let i = 0; i < pieces.length; i += size) {
      if (!editor.contains(document.activeElement) && document.activeElement !== editor) throw new Error('输入焦点发生变化，将自动重新定位并输入。');
      await input(job, 'type', null, pieces.slice(i, i + size).join(''));
      if (job.config.typing) {
        const character = pieces[i];
        await sleep(140 + Math.random() * 220 + (/[，。！？；,.!?;\n]/.test(character) ? 280 + Math.random() * 450 : Math.random() < 0.035 ? 350 + Math.random() * 600 : 0));
      }
    }
    let button;
    for (let i = 0; i < 75; i++) {
      await guard(job);
      if (XuliaoNormalize(adapter.editorText()) !== XuliaoNormalize(prompt.text)) throw new Error('输入受到其他内容干扰，将自动清空并重输。');
      const fault = adapter.pageFault(); if (fault) throw new Error(fault);
      button = adapter.sendButton();
      if (button && !adapter.isBusy()) break;
      badge(`${task.title}\n第 ${task.completed + 1}/${task.turns.length} 轮 · 等待发送按钮`);
      await sleep(200);
    }
    await guard(job);
    if (adapter.isBusy()) throw new Error('网页正在生成其他回复，稍后自动重试。');
    // No button may be a transient UI change. Try the native Enter shortcut once.
    const point = button ? adapter.point(button) : null;
    const checkpoint = adapter.checkpoint();
    const commit = await send('COMMIT', { checkpoint }, job);
    if (!commit.allowed) throw new Error('XULIAO_CANCELLED');
    try { await input(job, point ? 'send' : 'enter', point ? button : null); }
    catch (error) {
      if (error.message === 'XULIAO_PAGE_LOADING') await send('ABORT_DISPATCH', { dispatchId: commit.dispatchId }, job);
      throw error;
    }
    // Monitoring is tick-based; no long dispatch loop can trap pause/stop or recovery.
    if (adapter.sentUser(checkpoint, prompt.text)) await send('SENT', { url: location.href }, job);
  }
  async function monitor(job) {
    const { task } = job, prompt = task.turns[task.completed];
    if (!task.checkpoint) throw new Error('发送状态缺失，将重新准备本轮。');
    const sample = adapter.sample(task.checkpoint, prompt.text);
    const elapsed = Date.now() - (task.checkpoint.waitStartedAt || task.checkpoint.sentAt);
    const timeout = (prompt.kind === 'image' ? job.config.imageTimeout : job.config.responseTimeout) * 1000;
    const report = async stage => {
      const detail = `${stage} · 已等待 ${Math.max(0, Math.floor(elapsed / 1000))} 秒 / 上限 ${timeout / 1000} 秒${sample.response?.length ? ` · 已收到 ${sample.response.length} 字` : ''}`;
      badge(`${task.title}\n第 ${task.completed + 1}/${task.turns.length} 轮 · ${detail}`, stage);
      await send('HEARTBEAT', { waitStatus: detail }, job);
    };
    if (!sample.sent) {
      await report('正在确认消息发送');
      if (elapsed > 15000 && !sample.busy) throw new Error('尚未确认消息发出，自动核对并重试发送。');
      if (elapsed > timeout) throw new Error('未确认的消息长时间未恢复，自动重试。');
      return;
    }
    if (task.phase === 'dispatching') await send('SENT', { url: location.href }, job);
    const key = `${job.runId}/${task.id}/${task.completed}/${task.revision}`;
    const canStabilize = sample.complete && !sample.busy || sample.idleReady;
    if (stability.key !== key || stability.fingerprint !== sample.fingerprint || !canStabilize) stability = { key, fingerprint: sample.fingerprint, since: Date.now() };
    const stableFor = Date.now() - stability.since;
    const finished = sample.complete && !sample.busy && stableFor >= 3500 || sample.idleReady && stableFor >= 10000;
    const stage = sample.pendingImages ? '正在加载图片'
      : sample.busy && !sample.idleReady ? (prompt.kind === 'image' ? 'AI 正在创作图片' : sample.response ? '正在生成回复' : 'AI 正在思考')
      : prompt.kind === 'image' && !sample.images?.length ? '等待生成图片'
      : canStabilize && sample.fingerprint ? `正在确认完成（${Math.max(0, Math.ceil(((sample.complete && !sample.busy ? 3500 : 10000) - stableFor) / 1000))} 秒）`
      : '等待回复内容';
    await report(stage);
    if (finished && sample.fingerprint) {
      if (prompt.kind === 'image' && !sample.images?.length) {
        if ((sample.pendingImages || !sample.complete) && elapsed < timeout) return;
        const error = new Error('本轮没有生成可用图片，自动重试或跳过。'); error.kind = 'wait'; throw error;
      }
      if (job.status === 'running') {
        const bottom = adapter.bottomButton();
        if (bottom) { try { await input(job, 'bottom', bottom); } catch (error) { if (error.message === 'XULIAO_CANCELLED') throw error; } }
      }
      await send('COMPLETE', { response: sample.response, images: sample.images }, job); return;
    }
    // Following the latest turn also reveals content hidden by the page's virtual scroller.
    if (job.status === 'running' && Date.now() - lastBottomAt > 5000) {
      const bottom = adapter.bottomButton();
      if (bottom) { try { await input(job, 'bottom', bottom); lastBottomAt = Date.now(); } catch (error) { if (error.message === 'XULIAO_CANCELLED') throw error; } }
    }
    if (elapsed > timeout) {
      const retry = adapter.retryButton();
      if (retry && job.status === 'running') await input(job, 'retry', retry);
      const error = new Error('回复等待超时，自动继续等待或重试；持续失败会跳过。'); error.kind = 'wait'; throw error;
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    let job;
    try {
      job = await send('PULL');
      if (!job) { globalThis.XuliaoOverlay?.clearPageStatus(); return; }
      const { task } = job;
      adapter = new XuliaoChatGPTAdapter(job.config.selectors);
      const waiting = ['dispatching', 'waiting'].includes(task.phase);
      cancelled = job.status !== 'running';
      if (cancelled && !waiting) { badge(task.title, '已暂停'); return; }
      if (Date.now() < (task.retryAt || 0)) {
        badge(`${task.title}\n${Math.ceil((task.retryAt - Date.now()) / 1000)} 秒后自动重试 · ${task.turnRetries}/3`, '自动恢复');
        await send('HEARTBEAT', {}, job); return;
      }
      const fault = adapter.pageFault();
      if (fault) {
        if (job.status !== 'running') return;
        const retry = adapter.retryButton();
        if (retry) await input(job, 'retry', retry);
        const error = new Error(fault); error.kind = waiting ? 'wait' : 'retry'; throw error;
      }
      if (task.status === 'opening') {
        const key = `${job.runId}/${task.id}/${task.revision}`;
        if (readyWait.key !== key || !adapter.ready()) readyWait = { key, since: Date.now() };
        if (adapter.ready() && Date.now() - readyWait.since >= 2000) { await send('PAGE_READY', {}, job); return; }
        badge(`${task.title}\n页面加载中，等待输入框稳定`); await send('HEARTBEAT', {}, job);
        if (Date.now() - task.openedAt > 90000) throw new Error('页面未能完成加载，正在自动重试。');
        return;
      }
      if (!adapter.editor() && !waiting && Date.now() - task.openedAt < 45000) {
        badge(`${task.title}\n正在等待输入框（最多 45 秒）`); await send('HEARTBEAT', {}, job); return;
      }
      await send('HEARTBEAT', {}, job);
      if (waiting) await monitor(job);
      else if (Date.now() < task.nextAt) badge(`${task.title}\n${Math.ceil((task.nextAt - Date.now()) / 1000)} 秒后继续`);
      else { badge(`${task.title}\n第 ${task.completed + 1}/${task.turns.length} 轮 · 设备输入`); await prepare(job); }
    } catch (error) {
      if (error.message === 'XULIAO_PAGE_LOADING') badge('等待新会话完成加载，再继续输入。');
      else if (/Extension context invalidated|插件连接中断/.test(error.message)) badge('插件已更新，请刷新此网页。', '需要刷新');
      else if (error.message !== 'XULIAO_CANCELLED' && !cancelled && job && job.status === 'running') {
        badge(error.message, '自动恢复');
        await send('RECOVER', { reason: /detached|debugger|Invalid 'text'|No target/i.test(error.message) ? '设备输入连接暂时不可用，正在自动恢复。' : error.message, kind: error.kind || 'retry' }, job).catch(() => {});
      }
    } finally { busy = false; }
  }
  setInterval(tick, 1200);
  tick();
})();
