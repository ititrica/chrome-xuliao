(() => {
  'use strict';
  const DEFAULTS = {
    editor: '#prompt-textarea, textarea[data-testid="prompt-textarea"], [contenteditable="true"][data-testid="prompt-textarea"], [contenteditable="true"][data-composer-markdown], form [contenteditable="true"][role="textbox"]',
    send: '[data-testid="send-button"], [data-testid="composer-send-button"], button[aria-label="Send"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="发送提示"], button[aria-label="发送消息"], button[aria-label="发送"], button[aria-label="送信"], button[aria-label="送信する"], button[aria-label="メッセージを送信"], button[aria-label="メッセージを送信する"], button[aria-label="プロンプトを送信"], button[aria-label="プロンプトを送信する"]',
    stop: '[data-testid="stop-button"], [data-testid="stop-generation-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop"], button[aria-label="停止"], button[aria-label="停止生成"], button[aria-label="停止流式传输"], button[aria-label="生成を停止"], button[aria-label="生成を停止する"], button[aria-label="ストリーミングを停止"], button[aria-label="ストリーミングを停止する"]',
    user: '[data-message-author-role="user"], [data-user-message-bubble="true"]',
    assistant: '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]',
    complete: '[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], button[aria-label="Copy"], button[aria-label="Copy response"], button[aria-label="复制"], button[aria-label="复制回复"], button[aria-label="コピー"], button[aria-label="回答をコピー"], button[aria-label="回答をコピーする"]',
    bottom: '[data-testid="scroll-to-bottom-button"], [data-testid="scroll-to-bottom"], button[aria-label="Scroll to bottom"], button[aria-label="Scroll to latest"], button[aria-label="Jump to bottom"], button[aria-label="滚动到底部"], button[aria-label="滚动至底部"], button[aria-label="回到底部"], button[aria-label="最新のメッセージに移動"], button[aria-label="一番下までスクロール"], button[aria-label="最下部に移動"]'
  };
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = node => Boolean(node && !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length);
  const enabled = node => !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true';
  const text = node => node ? (node.innerText ?? node.textContent ?? '') : '';

  class ChatGPTAdapter {
    constructor(selectors = {}, root = document) { this.root = root; this.customAssistant = Boolean(selectors.assistant); this.customComplete = Boolean(selectors.complete); this.customSend = Boolean(selectors.send); this.selectors = { ...DEFAULTS }; for (const [key, value] of Object.entries(selectors)) if (value) this.selectors[key] = value; }
    all(key, root = this.root) {
      try { return [...root.querySelectorAll(this.selectors[key])]; }
      catch { throw new Error(`「${key}」的 CSS 选择器无效，请到设置中修正。`); }
    }
    editor() { return this.all('editor').find(shown) || null; }
    sendCandidates() {
      const form = this.editor()?.closest('form');
      const candidates = this.all('send').filter(node => shown(node) && (!form || form.contains(node)));
      if (candidates.length || this.customSend || !form) return candidates;
      // Current ChatGPT uses a submit button; this fallback is independent of UI language.
      const submit = [...form.querySelectorAll('button[type="submit"]')].filter(shown);
      return submit.length === 1 ? submit : [];
    }
    sendButton() { return this.sendCandidates().find(enabled) || null; }
    sendUnavailableReason() {
      if (this.isBusy()) return '网页仍在生成回复，尚不能发送下一轮。正在自动等待或重试。';
      if (this.sendCandidates().length) return '输入已填入，但发送按钮持续处于禁用状态。将自动清空重试。';
      return '输入已填入，但未找到发送按钮。将自动重试，持续失败会跳过本组。';
    }
    isBusy() { return Boolean(this.stopButton()) || [...this.root.querySelectorAll('[data-is-streaming="true"], .result-streaming')].some(shown); }
    ready() { return this.root.readyState !== 'loading' && Boolean(this.editor()) && !this.root.querySelector('[role="status"][aria-label*="加载"], [data-testid="conversation-loading"]'); }
    messages(key) { const nodes = this.all(key); return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node))); }
    users() { return this.messages('user'); }
    assistants() {
      const primary = this.messages('assistant');
      if (this.customAssistant) return primary;
      // Image-only ChatGPT turns can omit both assistant message attributes.
      const fallback = [...this.root.querySelectorAll('[data-conversation-role="assistant"]')].map(node => node.parentElement).filter(node => node && !primary.some(other => node.contains(other) || other.contains(node)));
      return [...new Set([...primary, ...fallback])].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    }
    editorText(editor = this.editor()) { return editor ? ('value' in editor ? editor.value : text(editor)) : ''; }
    pageFault() {
      const notices = [...this.root.querySelectorAll('[role="alert"], [data-testid="conversation-error"], [data-testid="error-message"]')];
      for (const notice of notices) {
        if (!shown(notice) || notice.closest('[data-message-author-role], [data-content-search-unit-key]')) continue;
        const message = normalize(text(notice));
        if (/something went wrong|too many requests|limit|try again|出错|出了点问题|达到.*(?:上限|限制)|请求过多|稍后再试|异常|网络错误|エラー|問題が発生|上限|制限に達|しばらく.*(?:試|待)|再試行/i.test(message)) return message.slice(0, 300);
      }
      if (!this.editor()) {
        const buttons = [...this.root.querySelectorAll('button, a')].filter(shown);
        if (buttons.some(n => /^(log in|sign in|登录|ログイン)$/i.test(normalize(text(n))))) return '请先在 ChatGPT 标签页登录，再回到工作台重新检查。';
        if (this.root.querySelector('iframe[src*="challenge"], #challenge-running, #challenge-stage')) return '网页正在进行验证，请手动完成后重新检查。';
      }
      return '';
    }
    checkpoint() { return { userCount: this.users().length, assistantCount: this.assistants().length }; }
    point(node) {
      if (!node || !shown(node)) throw new Error('设备输入目标尚未就绪。');
      const box = node.getBoundingClientRect();
      const left = Math.max(0, box.left), top = Math.max(0, box.top);
      const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
      if (right <= left || bottom <= top) throw new Error('设备输入目标不在可见区域。');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      const hit = this.root.elementFromPoint?.(x, y);
      if (hit && hit !== node && !node.contains(hit)) throw new Error('设备输入目标被其他浮层遮挡。');
      return { x, y };
    }
    stopButton() { return this.all('stop').find(node => shown(node) && enabled(node)) || null; }
    bottomButton() {
      return this.all('bottom').find(node => shown(node) && enabled(node)) || null;
    }
    retryButton() {
      return [...this.root.querySelectorAll('button')].find(node => shown(node) && enabled(node) &&
        /^(try again|retry|regenerate|重新生成|重试|再试一次|再試行|もう一度試す|再生成)$/i.test(normalize(node.getAttribute('aria-label') || text(node)))) || null;
    }
    sentUser(checkpoint, prompt) {
      const users = this.users();
      const start = users.length < checkpoint.userCount ? 0 : checkpoint.userCount;
      return users.slice(start).find(user => normalize(text(user)) === normalize(prompt)) || null;
    }
    sample(checkpoint, prompt) {
      const user = this.sentUser(checkpoint, prompt);
      if (!user) return { sent: false, busy: this.isBusy(), complete: false, fingerprint: '' };
      const users = this.users();
      const nextUser = users[users.indexOf(user) + 1];
      const assistant = this.assistants().filter(node =>
        Boolean(user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (!nextUser || Boolean(node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING))
      ).at(-1);
      if (!assistant) return { sent: true, busy: this.isBusy(), complete: false, fingerprint: '' };
      const modernTurn = assistant.closest('[data-talvt-turn-state]');
      const container = modernTurn || assistant.closest('article, [data-testid^="conversation-turn-"]') || assistant;
      const assistantBlock = modernTurn && [...modernTurn.querySelectorAll('[data-conversation-role="assistant"]')].map(node => node.parentElement).find(node => node.contains(assistant) && !this.all('user', node).length);
      const output = assistantBlock || (modernTurn ? assistant : container);
      const images = [...output.querySelectorAll('img')].filter(img =>
        img.complete && img.naturalWidth > 0 &&
        !/avatar|profile/i.test(`${img.alt} ${img.src}`) &&
        (img.naturalWidth >= 128 || /generated|生成|image created|创建的图片/i.test(img.alt))
      ).map(img => img.currentSrc || img.src);
      const body = assistant.querySelector('[data-markdown-text-style="assistant-message"]') || assistant.querySelector('[data-chatgpt-search-message-ids]') || assistant;
      const response = images.length && body.querySelector('[data-testid="generated-image-gallery"]') && !body.querySelector('p, pre, [data-markdown-text-style="assistant-message"]') ? '' : text(body).trim();
      const liveSelector = '[data-is-streaming="true"], .result-streaming';
      const live = container.matches(liveSelector) || [...container.querySelectorAll(liveSelector)].some(shown);
      const activeStop = !nextUser && Boolean(this.stopButton());
      const complete = !live && !activeStop && ((modernTurn?.getAttribute('data-talvt-turn-state') === 'complete') || this.all('complete', container).some(node => shown(node) && (
        this.customComplete ||
        ['copy-turn-action-button', 'good-response-turn-action-button'].includes(node.dataset.testid) ||
        !assistant.contains(node)
      )));
      const pendingImages = [...output.querySelectorAll('img')].some(img => !img.complete);
      // A manual generation elsewhere must not hold an already finished plugin answer.
      const busy = !complete && (live || activeStop || modernTurn?.getAttribute('data-talvt-turn-state') === 'in_progress');
      const idleReady = !this.customComplete && !live && !activeStop && !pendingImages && Boolean(this.editor());
      return { sent: true, busy, idleReady, complete, response, images, pendingImages, fingerprint: response || images.length ? JSON.stringify([response, images]) : '' };
    }
  }
  globalThis.XuliaoChatGPTAdapter = ChatGPTAdapter;
  globalThis.XuliaoNormalize = normalize;
})();
