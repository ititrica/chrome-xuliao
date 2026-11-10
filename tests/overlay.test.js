import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { harness } from './background-harness.js';

const source = await readFile(new URL('../content/overlay.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('floating menu starts, pauses, resumes and stops the real scheduler without replacing webpage drafts', async t => {
  const h = await harness(t);
  const dom = new JSDOM('<textarea id="user-draft">用户自己的草稿</textarea>', { runScripts: 'outside-only', url: 'https://chatgpt.com/' });
  t.after(() => dom.window.close());
  const w = dom.window; let shadow;
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  w.chrome = { runtime: { onMessage: { addListener() {} }, async sendMessage({ type, ...payload }) { try { return { ok: true, data: await h.message(type, payload, 99) }; } catch (error) { return { ok: false, error: error.message }; } } } };
  w.eval(source); w.XuliaoOverlay.toggle();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(w.document.querySelector('#xuliao-overlay').shadowRoot, null);
  shadow.querySelector('[name="sessions"]').value = 1;
  shadow.querySelector('[name="parallel"]').checked = true;
  async function click(action) { shadow.querySelector(`[data-action="${action}"]`).click(); for (let i = 0; i < 20; i++) await settle(); }
  await click('start'); assert.equal(h.storage.run.tasks.length, 1); assert.ok(h.storage.run.tasks[0].turns.length >= 6 && h.storage.run.tasks[0].turns.length <= 15); assert.equal(h.storage.run.config.parallel, true);
  await click('pause'); assert.equal(h.storage.run.status, 'paused');
  await click('resume'); assert.equal(h.storage.run.status, 'running');
  await click('stop'); assert.equal(h.storage.run.status, 'stopped');
  assert.equal(w.document.querySelector('#user-draft').value, '用户自己的草稿');
  await click('close'); assert.equal(w.document.querySelector('#xuliao-overlay').style.display, 'none');
  w.XuliaoOverlay.toggle(); assert.equal(w.document.querySelector('#xuliao-overlay').style.display, 'block');
});
test('toolbar toggles the webpage menu and injects content scripts when a page predates installation', async t => {
  const h = await harness(t); const sent = [], injected = [];
  let hasContent = false;
  h.chrome.tabs.sendMessage = async (id, message) => { sent.push([id, message.type]); if (!hasContent) throw new Error('No receiver'); return { ok: true }; };
  h.chrome.scripting = { async executeScript(details) { injected.push(details); hasContent = true; } };
  const click = h.chrome.action.onClicked.listeners[0];
  await click({ id: 88, url: 'https://chatgpt.com/' });
  assert.equal(injected.length, 1); assert.deepEqual(injected[0].files, ['content/overlay.js', 'content/adapter-chatgpt.js', 'content/runner.js']);
  assert.deepEqual(sent, [[88, 'OVERLAY_TOGGLE'], [88, 'OVERLAY_TOGGLE']]);
  await click({ id: 88, url: 'https://chatgpt.com/' }); assert.equal(injected.length, 1); assert.equal(h.tabs.size, 0);
});
test('restricted browser pages open the workbench instead of attempting page injection', async t => {
  const h = await harness(t);
  await h.chrome.action.onClicked.listeners[0]({ id: 88, url: 'chrome://extensions/' });
  assert.equal(h.tabs.size, 1); assert.equal([...h.tabs.values()][0].url, 'chrome-extension://test/ui/index.html');
});
