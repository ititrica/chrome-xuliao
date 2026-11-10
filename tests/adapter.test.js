import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../content/adapter-chatgpt.js', import.meta.url), 'utf8');
function page(html = '') {
  const dom = new JSDOM(`<main>${html}</main><textarea id="prompt-textarea"></textarea><button data-testid="send-button">发送</button>`, { runScripts: 'outside-only', url: 'https://chatgpt.com/c/test' });
  dom.window.HTMLElement.prototype.getClientRects = function() { return this.style.display === 'none' ? [] : [{ width: 100, height: 20 }]; };
  dom.window.eval(source);
  return { dom, window: dom.window, document: dom.window.document, adapter: new dom.window.XuliaoChatGPTAdapter() };
}
const user = message => `<article><div data-message-author-role="user">${message}</div></article>`;
const answer = (message, complete = true) => `<article><div data-message-author-role="assistant">${message}</div>${complete ? '<button data-testid="copy-turn-action-button">复制</button>' : ''}</article>`;

test('streaming output and final action markers are distinguished', () => {
  const p = page(user('你好') + answer('还没写完', false) + '<button data-testid="stop-button">停止</button>');
  const sample = p.adapter.sample({ userCount: 0 }, '你好');
  assert.equal(sample.busy, true); assert.equal(sample.complete, false);
  p.document.querySelector('[data-testid="stop-button"]').remove();
  assert.equal(p.adapter.sample({ userCount: 0 }, '你好').complete, false);
  p.document.querySelector('article:last-of-type').insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">复制</button>');
  assert.equal(p.adapter.sample({ userCount: 0 }, '你好').complete, true); p.dom.window.close();
});
test('the previous assistant response cannot be mistaken for the current one', () => {
  const p = page(user('第一轮') + answer('旧回复') + user('第二轮'));
  const sample = p.adapter.sample({ userCount: 1, assistantCount: 1 }, '第二轮');
  assert.equal(sample.sent, true); assert.equal(sample.complete, false); assert.equal(sample.fingerprint, ''); p.dom.window.close();
});
test('manual messages are ignored while locating the matching plugin prompt', () => {
  const p = page(user('自动提示') + answer('插件回复') + user('用户手动插入') + answer('手动回复'));
  assert.equal(p.adapter.sample({ userCount: 0 }, '自动提示').response, '插件回复');
  assert.equal(p.adapter.sample({ userCount: 1 }, '另外的提示').sent, false); p.dom.window.close();
});
test('a missing user bubble does not count as a successful send', () => {
  const p = page(answer('旧回复')); assert.equal(p.adapter.sample({ userCount: 0 }, '提示词').sent, false); p.dom.window.close();
});
test('a copy button inside unfinished code is not a reply completion marker', () => {
  const p = page(user('请写代码') + answer('<pre><button aria-label="Copy">复制代码</button>const x = 1;</pre>', false));
  assert.equal(p.adapter.sample({ userCount: 0 }, '请写代码').complete, false); p.dom.window.close();
});
test('current ChatGPT composer is found without a prompt-textarea id', () => {
  const p = page(); p.document.querySelector('textarea').remove();
  p.document.querySelector('main').insertAdjacentHTML('beforeend', '<form><div contenteditable="true" role="textbox" data-composer-markdown class="ProseMirror"><p><br></p></div></form>');
  assert.equal(p.adapter.editor()?.className, 'ProseMirror'); p.dom.window.close();
});
test('unrelated editable elements are not mistaken for the composer', () => {
  const p = page(); p.document.querySelector('textarea').remove();
  p.document.querySelector('main').insertAdjacentHTML('beforeend', '<div contenteditable="true" role="textbox">文档编辑器</div>');
  assert.equal(p.adapter.editor(), null); p.dom.window.close();
});
test('current ChatGPT turn structure supports user confirmation, streaming and final response', () => {
  const p = page('<div data-talvt-turn-state="in_progress"><div data-user-message-bubble="true">本轮问题</div><div data-content-search-unit-key="turn-0:2:assistant"><h4 data-conversation-role="assistant">ChatGPT 说：</h4><div data-markdown-text-style="assistant-message">本轮答案</div></div></div><button aria-label="停止"></button>');
  const cp = { userCount: 0, assistantCount: 0 };
  assert.equal(p.adapter.users().length, 1); assert.equal(p.adapter.assistants().length, 1);
  const streaming = p.adapter.sample(cp, '本轮问题');
  assert.equal(streaming.sent, true); assert.equal(streaming.busy, true); assert.equal(streaming.complete, false); assert.equal(streaming.response, '本轮答案');
  p.document.querySelector('[aria-label="停止"]').remove();
  assert.equal(p.adapter.sample(cp, '本轮问题').busy, true);
  p.document.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete');
  const final = p.adapter.sample(cp, '本轮问题'); assert.equal(final.busy, false); assert.equal(final.complete, true); p.dom.window.close();
});
test('nested legacy and modern message markers are counted once', () => {
  const p = page('<div data-message-author-role="user"><div data-user-message-bubble="true">问题</div></div><div data-content-search-unit-key="t:assistant"><div data-message-author-role="assistant">答案</div></div>');
  assert.equal(p.adapter.users().length, 1); assert.equal(p.adapter.assistants().length, 1); p.dom.window.close();
});
test('page errors are detected in alerts without matching ordinary assistant prose', () => {
  const p = page(answer('文中提到 something went wrong 是一句例句'));
  assert.equal(p.adapter.pageFault(), '');
  p.document.querySelector('main').insertAdjacentHTML('beforeend', '<div role="alert">Too many requests. Try again later.</div>');
  assert.match(p.adapter.pageFault(), /Too many/); p.dom.window.close();
});
test('images must be loaded and avatars do not count as generated output', () => {
  const p = page(user('请生图') + answer('<img alt="avatar" src="https://example.org/avatar.png"><img alt="生成的图片" src="https://example.org/image.png">'));
  const img = p.document.querySelector('img[alt="生成的图片"]');
  Object.defineProperty(img, 'complete', { value: true }); Object.defineProperty(img, 'naturalWidth', { value: 1024 });
  assert.deepEqual([...p.adapter.sample({ userCount: 0 }, '请生图').images], ['https://example.org/image.png']); p.dom.window.close();
});
test('invalid custom selectors fail explicitly', () => {
  const p = page(); const adapter = new p.window.XuliaoChatGPTAdapter({ editor: '[' });
  assert.throws(() => adapter.editor(), /选择器无效/); p.dom.window.close();
});
test('English and Japanese send, stop and completion labels work without test ids', () => {
  for (const locale of [
    { send: 'Send', stop: 'Stop', copy: 'Copy' },
    { send: 'Send message', stop: 'Stop generating', copy: 'Copy response' },
    { send: '送信する', stop: '生成を停止する', copy: 'コピー' },
    { send: 'プロンプトを送信する', stop: 'ストリーミングを停止する', copy: '回答をコピーする' }
  ]) {
    const p = page(user('質問') + answer('回答', false));
    const button = p.document.querySelector('[data-testid="send-button"]');
    button.removeAttribute('data-testid'); button.setAttribute('aria-label', locale.send);
    assert.equal(p.adapter.sendButton(), button);
    p.document.querySelector('main').insertAdjacentHTML('beforeend', `<button aria-label="${locale.stop}"></button>`);
    assert.equal(p.adapter.isBusy(), true);
    p.document.querySelector(`button[aria-label="${locale.stop}"]`).remove();
    p.document.querySelector('article:last-of-type').insertAdjacentHTML('beforeend', `<button aria-label="${locale.copy}"></button>`);
    assert.equal(p.adapter.sample({ userCount: 0 }, '質問').complete, true);
    p.dom.window.close();
  }
});
test('the enabled send button in the composer wins over disabled and unrelated candidates', () => {
  const p = page();
  const editor = p.document.querySelector('textarea');
  const form = p.document.createElement('form'); p.document.body.append(form); form.append(editor);
  form.insertAdjacentHTML('beforeend', '<button data-testid="send-button" disabled></button><button aria-label="Send" aria-disabled="true"></button><button aria-label="送信"></button>');
  assert.equal(p.adapter.sendButton()?.getAttribute('aria-label'), '送信');
  form.querySelector('[aria-label="送信"]').disabled = true;
  assert.equal(p.adapter.sendButton(), null);
  assert.match(p.adapter.sendUnavailableReason(), /禁用/);
  p.dom.window.close();
});
test('a unique composer submit button supports any language, while custom selectors stay explicit', () => {
  const p = page(); p.document.querySelector('[data-testid="send-button"]').remove();
  const form = p.document.createElement('form'); p.document.body.append(form); form.append(p.document.querySelector('textarea'));
  form.insertAdjacentHTML('beforeend', '<button type="button" aria-label="添付"></button><button type="submit" aria-label="質問を送る"></button>');
  assert.equal(p.adapter.sendButton()?.type, 'submit');
  assert.equal(new p.window.XuliaoChatGPTAdapter({ send: '#missing' }).sendButton(), null);
  form.insertAdjacentHTML('beforeend', '<button type="submit"></button>');
  assert.equal(p.adapter.sendButton(), null); p.dom.window.close();
});
test('Japanese login and error notices are detected', () => {
  const p = page(); p.document.querySelector('textarea').remove();
  p.document.body.insertAdjacentHTML('beforeend', '<button>ログイン</button>');
  assert.match(p.adapter.pageFault(), /登录/);
  p.document.body.insertAdjacentHTML('beforeend', '<div role="alert">メッセージの上限に達しました。後でもう一度お試しください。</div>');
  assert.match(p.adapter.pageFault(), /上限/); p.dom.window.close();
});
test('missing final markers expose an idle fallback while real streaming still prevents it',()=>{
  const p=page(user('提示')+answer('完整内容',false));let s=p.adapter.sample({userCount:0},'提示');assert.equal(s.complete,false);assert.equal(s.idleReady,true);
  p.document.querySelector('article:last-of-type').dataset.isStreaming='true';s=p.adapter.sample({userCount:0},'提示');assert.equal(s.busy,true);assert.equal(s.idleReady,false);
  delete p.document.querySelector('article:last-of-type').dataset.isStreaming;p.document.querySelector('main').insertAdjacentHTML('beforeend','<button aria-label="停止" disabled></button>');assert.equal(p.adapter.sample({userCount:0},'提示').idleReady,true);p.dom.window.close();
});
test('completed plugin answer is not held by a subsequent manual generation',()=>{
  const p=page(user('插件问题')+answer('插件答案')+user('手动问题')+answer('手动回答',false)+'<button aria-label="停止"></button>');
  const s=p.adapter.sample({userCount:0},'插件问题');assert.equal(s.busy,false);assert.equal(s.complete,true);assert.equal(s.response,'插件答案');p.dom.window.close();
});
test('active generation overrides old copy controls and multilingual bottom buttons are recognized',()=>{
  const p=page(user('提示')+answer('还在增长')+'<button aria-label="停止"></button>');assert.equal(p.adapter.sample({userCount:0},'提示').complete,false);
  for(const label of ['滚动到底部','Scroll to bottom','最新のメッセージに移動']){p.document.querySelector('main').insertAdjacentHTML('beforeend',`<button aria-label="${label}"></button>`);const node=p.adapter.bottomButton();assert.equal(node.getAttribute('aria-label'),label);node.setAttribute('aria-hidden','true');assert.equal(p.adapter.bottomButton(),null);node.remove();}p.dom.window.close();
});
test('current image-only turns without assistant message attributes are recognized without counting user uploads',()=>{
  const p=page('<div data-talvt-turn-state="complete"><div><div data-user-message-bubble="true">请生图<img alt="upload" src="https://example.org/upload.png"></div></div><div><h4 data-conversation-role="assistant">ChatGPT 说：</h4><div data-chatgpt-search-message-ids="image-result"><div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img alt="已生成图像 1" src="https://example.org/output.png"></button></div></div></div></div>');
  const img=p.document.querySelector('[data-testid="generated-image-preview"] img');Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:1254});
  assert.equal(p.adapter.assistants().length,1);const sample=p.adapter.sample({userCount:0},'请生图');assert.equal(sample.sent,true);assert.equal(sample.complete,true);assert.equal(sample.busy,false);assert.deepEqual([...sample.images],['https://example.org/output.png']);assert.ok(sample.fingerprint);assert.equal(new p.window.XuliaoChatGPTAdapter({assistant:'#missing'}).assistants().length,0);p.dom.window.close();
});
test('mixed modern text and gallery siblings use the assistant block and exclude uploaded images',()=>{
  const p=page('<div data-talvt-turn-state="complete"><div data-user-message-bubble="true">编辑图片<img src="https://example.org/upload.png"></div><div><h4 data-conversation-role="assistant">ChatGPT 说：</h4><div data-content-search-unit-key="t:assistant"><p>已完成修改</p></div><div data-testid="generated-image-gallery"><img alt="已生成图像 1" src="https://example.org/edited.png"></div></div></div>');
  for(const img of p.document.querySelectorAll('img')){Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:1024});}
  const sample=p.adapter.sample({userCount:0},'编辑图片');assert.equal(sample.response,'已完成修改');assert.equal(sample.complete,true);assert.deepEqual([...sample.images],['https://example.org/edited.png']);p.dom.window.close();
});
test('virtualized messages with unchanged visible counts confirm a new send by message identity',()=>{
  const p=page(user('旧问题一')+answer('旧回答一')+user('旧问题二')+answer('旧回答二'));
  const users=p.adapter.users();users[0].setAttribute('data-message-id','u1');users[1].setAttribute('data-message-id','u2');const cp=p.adapter.checkpoint();
  p.document.querySelectorAll('main article')[0].remove();p.document.querySelectorAll('main article')[0].remove();
  p.document.querySelector('main').insertAdjacentHTML('beforeend',user('新问题')+answer('新回答'));p.adapter.users().at(-1).setAttribute('data-message-id','u3');
  assert.equal(p.adapter.users().length,cp.userCount);assert.equal(p.adapter.sample(cp,'新问题').complete,true);assert.equal(p.adapter.sample(cp,'新问题').response,'新回答');
  assert.equal(p.adapter.sentUser(cp,'旧问题二'),null);p.dom.window.close();
});
test('virtualized checkpoints distinguish a repeated prompt from an old identical bubble',()=>{
  const p=page(user('重复问题')+answer('旧回答'));p.adapter.users()[0].setAttribute('data-message-id','old');const cp=p.adapter.checkpoint();
  assert.equal(p.adapter.sentUser(cp,'重复问题'),null);p.document.querySelector('main').innerHTML=user('重复问题')+answer('新回答');p.adapter.users()[0].setAttribute('data-message-id','new');
  assert.equal(p.adapter.sample(cp,'重复问题').response,'新回答');p.dom.window.close();
});
test('legacy count checkpoints and keyless adapters recover when virtualization keeps the count unchanged',()=>{
  const p=page(user('旧一')+answer('回答一')+user('旧二')+answer('回答二'));const cp=p.adapter.checkpoint();
  p.document.querySelector('main').innerHTML=user('旧二')+answer('回答二')+user('新问题')+answer('新回答');
  assert.ok(p.adapter.sentUser(cp,'新问题'));assert.ok(p.adapter.sentUser({userCount:2,assistantCount:2},'新问题'));p.dom.window.close();
});
