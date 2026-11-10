(() => {
  'use strict';
  if (globalThis.XuliaoOverlay) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let host, root, expanded = false, userHidden = false, pageStatus = '', pageTone = '', snapshot, polling = false, pending = false, configKey = '';
  const phase = { opening: '打开页面', ready: '准备下一轮', preparing: '正在输入', dispatching: '确认发送', waiting: '等待回复' };
  async function request(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '连接中断，请刷新网页后重试。');
    return result.data;
  }
  function ensure() {
    if (host) return;
    host = document.createElement('div'); host.id = 'xuliao-overlay';
    host.style.cssText = 'position:fixed!important;right:20px!important;top:80px!important;z-index:2147483647!important;display:block!important;width:auto!important;height:auto!important;color-scheme:light!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}.shell{font:12px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#27344b;width:min(328px,calc(100vw - 24px));background:#fff;border:1px solid #d8e2f2;border-radius:13px;box-shadow:0 10px 40px #1a315226;overflow:hidden}.header{display:flex;align-items:center;gap:9px;background:#f3f6ff;padding:12px 14px;cursor:move;touch-action:none;user-select:none}.logo{width:25px;height:24px;border-radius:7px;background:#315dce;color:white;display:grid;place-items:center;font-size:16px}.title{font-size:14px;font-weight:600;flex:1}.version{font-size:10px;font-weight:400;color:#7989a4;padding-left:6px}.icon{padding:0 5px;color:#6c7d98;font-size:18px;background:none;border:0;line-height:1.3}.body{padding:16px}.status-line{display:flex;align-items:center;justify-content:space-between;gap:10px}.state{font-size:11px;color:#5772a4}.counter{font-variant-numeric:tabular-nums;font-size:11px;color:#687992}progress{display:block;width:100%;height:5px;border:0;background:#eaf0fa;border-radius:4px;overflow:hidden;margin:10px 0 12px}progress::-webkit-progress-bar{background:#eaf0fa}progress::-webkit-progress-value{background:#668bdd;border-radius:4px}.current{font-size:12px;color:#596b87;white-space:pre-line;overflow-wrap:anywhere;max-height:90px;overflow:auto;margin:0 0 14px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fields label{font-size:10px;color:#7888a1}input,select{display:block;width:100%;border:1px solid #dce4f0;border-radius:6px;padding:7px 8px;background:#fff;color:#344864;margin-top:5px;min-width:0}input{font-variant-numeric:tabular-nums}.parallel-label{display:flex;align-items:center;justify-content:space-between;gap:12px}.parallel-label input{width:18px;height:18px;margin:0;accent-color:#315dce}.ratio{display:block;margin-top:14px;color:#7888a1;font-size:11px}.ratio output{float:right;color:#315dce}.ratio input[type=range]{padding:0;border:0;accent-color:#315dce;cursor:pointer}.random-note{color:#7888a1;font-size:10px;margin:10px 0 0}.controls{display:flex;gap:8px;margin-top:15px}.btn{padding:8px 12px;border:1px solid #d9e2ef;border-radius:7px;background:white;color:#526b93;font-size:11px;flex:1}.primary{background:#315dce;color:#fff;border-color:#315dce}.danger{color:#ab6560}.footer{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 15px;border-top:1px solid #e9edf5;color:#91a0b4;font-size:10px}.link{border:0;background:none;color:#426bc0;padding:0;font-size:11px}.message{font-size:11px;color:#a06f47;margin:10px 0 0;white-space:pre-line;max-height:94px;overflow:auto}.logs{margin-top:13px;padding-top:10px;border-top:1px solid #edf0f5;color:#8290a6;font-size:10px}.logs p{margin:3px 0;overflow-wrap:anywhere}.mini{font:12px/1.5 system-ui,sans-serif;display:flex;align-items:center;gap:8px;color:#36588f;border:1px solid #cbd9f4;background:#f6f9ff;border-radius:22px;padding:9px 13px;box-shadow:0 3px 15px #18365b18;max-width:280px;text-align:left}.mini span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dot{width:7px;height:7px;border-radius:50%;background:#668bdd;flex:none}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #aac0fa;outline-offset:2px}
      </style><button class="mini" aria-label="展开续聊悬浮菜单"><i class="dot"></i><span>续聊</span></button><section class="shell" hidden aria-label="续聊悬浮菜单"><header class="header"><span class="logo">↻</span><span class="title">续聊<span class="version">0.3.0</span></span><button class="icon" data-action="collapse" aria-label="收起续聊菜单">−</button><button class="icon" data-action="close" aria-label="关闭续聊菜单">×</button></header><div class="body"><div class="status-line"><strong class="state">准备就绪</strong><span class="counter">0 / 0 轮</span></div><progress max="1" value="0" aria-label="本批对话进度"></progress><p class="current">按保存的设置，随机开启一批连续对话。</p><div class="fields"><label>会话数量<input name="sessions" type="number" min="1" max="300" value="6"></label><label class="parallel-label">并发开 / 关<input name="parallel" type="checkbox" role="switch" aria-label="并发开关"></label></div><label class="ratio">图片创作组比例 <output>30%</output><input name="imageRatio" type="range" min="0" max="100" step="5" value="30" aria-label="图片创作组比例"></label><label class="parallel-label" style="margin-top:14px">提示词抖动<input class="jitter-toggle" name="promptJitter" type="checkbox" role="switch" checked aria-label="提示词抖动"></label><p class="random-note">文字 6–15 轮 · 图片 12–20 轮 · 并发 1–3 组</p><div class="controls"><button class="btn primary" data-action="start">开始</button><button class="btn" data-action="pause" disabled>暂停</button><button class="btn danger" data-action="stop" disabled>停止</button></div><p class="message" role="status" hidden></p><div class="logs" hidden></div></div><footer class="footer"><span class="summary">其他设置沿用控制台配置</span><button class="link" data-action="console">打开控制台 ↗</button></footer></section>`;
    document.documentElement.append(host);
    root.querySelector('.ratio input').oninput = event => { root.querySelector('.ratio output').textContent = `${event.target.value}%`; };
    root.querySelector('.mini').onclick = () => { expanded = true; userHidden = false; visibility(); refresh(); };
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-action]'); if (!button) return;
      const action = button.dataset.action;
      if (action === 'collapse') { expanded = false; visibility(); return; }
      if (action === 'close') { userHidden = true; visibility(); return; }
      if (pending) return;
      const config = Object.fromEntries([...root.querySelectorAll('.fields input,.fields select,.ratio input,.jitter-toggle')].map(input => [input.name, input.type === 'checkbox' ? input.checked : input.value]));
      if (action === 'start' && ![...root.querySelectorAll('.fields input')].every(input => input.reportValidity())) return;
      pending = true; button.disabled = true;
      const message = root.querySelector('.message'); message.hidden = true;
      try { snapshot = await request('PANEL_ACTION', { action, config }); render(); }
      catch (error) { message.textContent = error.message; message.hidden = false; }
      finally { pending = false; render(); }
    });
    const header = root.querySelector('.header'); let drag;
    header.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || event.button !== 0) return;
      const box = host.getBoundingClientRect(); drag = { x: event.clientX - box.left, y: event.clientY - box.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
      if (!drag) return;
      const box = host.getBoundingClientRect();
      host.style.setProperty('left', `${Math.max(8, Math.min(innerWidth - box.width - 8, event.clientX - drag.x))}px`, 'important');
      host.style.setProperty('top', `${Math.max(8, Math.min(innerHeight - Math.min(box.height, innerHeight - 16) - 8, event.clientY - drag.y))}px`, 'important');
      host.style.setProperty('right', 'auto', 'important');
    });
    header.addEventListener('pointerup', () => { drag = null; }); header.addEventListener('pointercancel', () => { drag = null; });
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { expanded = false; visibility(); } });
    setInterval(() => { if (expanded && !userHidden) refresh(); }, 1800);
  }
  function visibility() {
    if (!host) return;
    host.style.setProperty('display', userHidden ? 'none' : 'block', 'important');
    root.querySelector('.shell').hidden = !expanded;
    root.querySelector('.mini').hidden = expanded;
  }
  function render() {
    if (!root) return;
    const run = snapshot?.run;
    const active = run && ['running', 'paused'].includes(run.status);
    const blocked = run?.tasks.filter(task => task.status === 'blocked') || [];
    const completed = run?.tasks.reduce((sum, task) => sum + task.completed, 0) || 0;
    const total = run?.tasks.reduce((sum, task) => sum + task.total, 0) || 0;
    root.querySelector('.state').textContent = blocked.length ? `${blocked.length} 组需要检查` : ({ running: '正在运行', paused: '已暂停', completed: '本批已完成', stopped: '已停止' }[run?.status] || '准备就绪');
    root.querySelector('.counter').textContent = `${completed} / ${total} 轮`;
    const progress = root.querySelector('progress'); progress.max = total || 1; progress.value = completed;
    const running = run?.tasks.filter(task => ['running', 'opening'].includes(task.status)) || [];
    root.querySelector('.current').textContent = pageStatus || (active ? running.map(task => `${task.title}：${task.completed}/${task.total} 轮 · ${phase[task.phase] || phase[task.status] || ''}`).join('\n') || blocked[0]?.error || '等待下一组会话' : run?.status === 'completed' ? '本批对话已完成。可以打开控制台导出记录，或开始下一批。' : run?.status === 'stopped' ? '本批任务已停止，不会再发送后续提示词。' : '按保存的设置，随机开启一批连续对话。');
    const mini = root.querySelector('.mini span'); mini.textContent = `续聊${run ? ` · ${completed}/${total} 轮` : ''}${pageTone ? ` · ${pageTone}` : ''}`;
    root.querySelector('[data-action="start"]').disabled = Boolean(active) || pending;
    const pause = root.querySelector('[data-action="pause"], [data-action="resume"]'); pause.dataset.action = run?.status === 'paused' ? 'resume' : 'pause'; pause.textContent = run?.status === 'paused' ? '继续' : '暂停'; pause.disabled = !active || pending;
    root.querySelector('[data-action="stop"]').disabled = !active || pending;
    const config = active ? run.config : snapshot?.config;
    const key = JSON.stringify(config);
    if (config && key !== configKey) {
      for (const input of root.querySelectorAll('.fields input,.fields select,.ratio input,.jitter-toggle')) { if (input.type === 'checkbox') input.checked = Boolean(config[input.name]); else input.value = config[input.name]; }
      configKey = key;
    }
    for (const input of root.querySelectorAll('.fields input,.fields select,.ratio input,.jitter-toggle')) input.disabled = Boolean(active) || input.name === 'imageRatio' && !config?.includeImages;
    root.querySelector('.ratio output').textContent = config?.includeImages ? `${root.querySelector('[name="imageRatio"]').value}%` : '图片已关闭';
    root.querySelector('.summary').textContent = run ? `${run.tasks.filter(t => t.status === 'done').length}/${run.tasks.length} 组完成 · ${run.tasks.filter(t => t.status === 'skipped').length} 组跳过` : '其他设置沿用控制台配置';
    const logs = root.querySelector('.logs'); logs.hidden = !run?.logs.length;
    logs.innerHTML = (run?.logs || []).slice(-2).map(log => `<p>${escape(log.text)}</p>`).join('');
  }
  async function refresh() {
    if (polling || !host) return;
    polling = true;
    try { snapshot = await request('PANEL_STATE'); render(); }
    catch (error) { const message = root.querySelector('.message'); message.textContent = error.message; message.hidden = false; }
    finally { polling = false; }
  }
  globalThis.XuliaoOverlay = {
    toggle() { ensure(); if (expanded && !userHidden) userHidden = true; else { userHidden = false; expanded = true; } visibility(); refresh(); },
    setPageStatus(label, tone = '') { pageStatus = label; pageTone = tone; ensure(); visibility(); render(); if (!userHidden) refresh(); },
    clearPageStatus() { pageStatus = ''; pageTone = ''; if (host) render(); }
  };
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'OVERLAY_TOGGLE') { globalThis.XuliaoOverlay.toggle(); respond({ ok: true }); }
  });
})();
