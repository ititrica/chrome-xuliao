// Only this module writes to the chat webpage. DOM scripts are observers.
export function createDeviceInput(api, check, isMac = /Mac/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '')) {
  const attached = new Set();
  const attaching = new Map();
  // Native input transactions must not interleave across tabs in the same browser window.
  let chain = Promise.resolve();
  const cancelled = new Set();
  async function attach(tabId) {
    if (cancelled.has(tabId)) throw new Error('设备输入已被用户取消。');
    if (attached.has(tabId)) return;
    if (!attaching.has(tabId)) attaching.set(tabId, (async () => {
      await api.debugger.attach({ tabId }, '1.3');
      try {
        await api.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        attached.add(tabId);
      } catch (error) { await api.debugger.detach({ tabId }).catch(() => {}); throw error; }
    })().finally(() => attaching.delete(tabId)));
    await attaching.get(tabId);
  }
  async function release(tabId) {
    if (attaching.has(tabId)) await attaching.get(tabId).catch(() => {});
    if (attached.delete(tabId)) await api.debugger.detach({ tabId }).catch(() => {});
  }
  async function perform(tabId, message) {
    await check(tabId, message);
    if (api.tabs) {
      const tab = await api.tabs.get(tabId);
      if (!tab.active) await api.tabs.update(tabId, { active: true });
      // CDP targets this tab directly. Focus emulation below is sufficient for
      // native input; focusing its OS window here steals the user's other apps.
      await check(tabId, message);
    }
    await attach(tabId);
    const command = (method, params) => api.debugger.sendCommand({ tabId }, method, params);
    const key = async (keyName, code, modifiers = 0, commands) => {
      await check(tabId, message);
      try { await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, windowsVirtualKeyCode: code, modifiers, ...(commands ? { commands } : {}) }); }
      finally { await command('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, windowsVirtualKeyCode: code, modifiers: 0 }); }
    };
    const click = async () => {
      const { x, y } = message.point || {};
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('设备点击目标不可见。');
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await check(tabId, message);
      try { await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); }
      finally { await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
    };
    if (message.action === 'clear') {
      await click();
      await key('a', 65, isMac ? 4 : 2, ['selectAll']);
      await key('Backspace', 8);
    } else if (message.action === 'type') {
      if (typeof message.text !== 'string' || message.text.length > 256) throw new Error('设备输入片段无效。');
      const lines = message.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i) await key('Enter', 13, 8);
        for (const character of lines[i]) {
          await check(tabId, message);
          // Chromium char events accept one UTF-16 character, not a typing chunk.
          // Supplementary Unicode uses the browser's native IME insertion path.
          if (character.length > 1) await command('Input.insertText', { text: character });
          else await command('Input.dispatchKeyEvent', { type: 'char', text: character, unmodifiedText: character });
        }
      }
    } else if (['send', 'stop', 'retry', 'bottom'].includes(message.action)) await click();
    else if (message.action === 'enter') await key('Enter', 13);
    else throw new Error('未知设备输入动作。');
    return { performed: true };
  }
  return {
    async perform(tabId, message) {
      const work = chain.catch(() => {}).then(() => perform(tabId, message));
      chain = work;
      return work;
    },
    release,
    resume() { cancelled.clear(); },
    async releaseAll() { await Promise.allSettled([...new Set([...attached, ...attaching.keys()])].map(release)); },
    detached(tabId, reason) {
      const wasActive = attached.delete(tabId);
      if (wasActive && reason === 'canceled_by_user') cancelled.add(tabId);
      return wasActive && reason === 'canceled_by_user';
    }
  };
}
