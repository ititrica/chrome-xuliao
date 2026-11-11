import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { harness } from './background-harness.js';
const adapterSource=await readFile(new URL('../content/adapter-chatgpt.js',import.meta.url),'utf8');
const runnerSource=await readFile(new URL('../content/runner.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
async function bank(h,count=2) {await h.message('LIBRARY_SAVE',{library:Array.from({length:count},(_,n)=>({id:`s-${n}`,title:`连续主题 ${n}`,category:'test',turns:Array.from({length:6},(_,i)=>({text:`沿用同一项目，请详细讨论第 ${i+1} 个阶段的计划。`,kind:'text'}))}))});}
async function connect(h,t,tabId,{draft='',locale='zh',dropSend=false,disableSend=false,intercept}={}) {
  const dom=new JSDOM('<main></main><form><textarea id="prompt-textarea"></textarea><button type="button"></button></form>',{runScripts:'outside-only',url:'https://chatgpt.com/c/test'});
  t.after(()=>dom.window.close());const w=dom.window,doc=w.document,editor=doc.querySelector('textarea'),button=doc.querySelector('button');
  const labels=locale==='ja'?['送信','停止','コピー']:locale==='en'?['Send','Stop','Copy']:['发送','停止','复制'];
  button.setAttribute('aria-label',labels[0]);button.disabled=disableSend;editor.value=draft;
  w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[this.getBoundingClientRect()];};
  w.HTMLElement.prototype.getBoundingClientRect=function(){return this===button?{left:450,top:20,right:490,bottom:60,width:40,height:40}:{left:20,top:20,right:420,bottom:80,width:400,height:60};};
  doc.elementFromPoint=(x)=>x>440?button:editor;
  w.Date.now=()=>Date.now();let periodic,pending=0,calls=0,sends=0,selected=false;const listeners=[];
  w.setInterval=fn=>{periodic=fn;return 1;};
  w.setTimeout=fn=>{pending++;setImmediate(()=>{pending--;fn();});return 1;};
  w.chrome={runtime:{onMessage:{addListener(fn){listeners.push(fn);}},async sendMessage(message){calls++;try{if(intercept)await intercept(message,w);const {type,...payload}=message;try{return {ok:true,data:await h.message(type,payload,tabId)};}catch(error){return {ok:false,error:error.message};}}finally{calls--;}}}};
  const previous=h.chrome.tabs.sendMessage;h.chrome.tabs.sendMessage=async(id,message)=>{if(id===tabId)for(const fn of listeners)fn(message,{},()=>{});return previous(id,message);};
  button.onclick=()=>{sends++;if(dropSend)return;const user=doc.createElement('article');const body=doc.createElement('div');body.dataset.messageAuthorRole='user';body.textContent=editor.value;user.append(body);const reply=doc.createElement('article');reply.innerHTML='<div data-message-author-role="assistant">正在生成</div>';doc.querySelector('main').append(user,reply);editor.value='';const stop=doc.createElement('button');stop.setAttribute('aria-label',labels[1]);stop.dataset.testStop='true';doc.body.append(stop);};
  h.inputHandlers.set(tabId,async(method,p)=>{
    if(method==='Input.dispatchMouseEvent'&&p.type==='mouseReleased') {if(p.x>440)button.click();else editor.focus();}
    if(method==='Input.dispatchKeyEvent') {
      if(p.type==='rawKeyDown'&&p.commands?.includes('selectAll'))selected=true;
      if(p.type==='rawKeyDown'&&p.key==='Backspace'){editor.value=selected?'':editor.value.slice(0,-1);selected=false;}
      if(p.type==='char'){editor.value=selected?p.text:editor.value+p.text;selected=false;editor.dispatchEvent(new w.Event('input',{bubbles:true}));}
      if(p.type==='rawKeyDown'&&p.key==='Enter'){if(p.modifiers===8)editor.value+='\n';else button.click();}
    }
  });
  const drain=async()=>{for(let i=0;i<3000;i++){await flush();if(!pending&&!calls){await flush();if(!pending&&!calls)return;}}throw Error('runner did not settle');};
  w.eval(adapterSource);w.eval(runnerSource);await drain();
  return {w,doc,editor,button,sends:()=>sends,async tick(){await periodic();await drain();},
    async finish(){doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());const reply=doc.querySelector('main article:last-child');reply.querySelector('[data-message-author-role="assistant"]').textContent='本轮完整回复';reply.insertAdjacentHTML('beforeend',`<button aria-label="${labels[2]}"></button>`);await this.tick();h.advance(4000);await this.tick();},
    async recover(){h.advance(12000);await this.tick();}
  };
}
test('device-driven runner finishes two six-round serial conversations without sending during streaming',async t=>{
  const h=await harness(t);await bank(h);const s=await h.start({sessions:2,typing:false});const first=await connect(h,t,s.run.tasks[0].tabId);
  assert.equal(first.sends(),1);await first.tick();assert.equal(first.sends(),1);
  for(let i=0;i<6;i++){await first.finish();if(i<5){h.advance(3000);await first.tick();}}
  assert.equal(h.tabs.size,1);await h.readyAll();const second=await connect(h,t,h.storage.run.tasks[1].tabId);
  for(let i=0;i<6;i++){await second.finish();if(i<5){h.advance(3000);await second.tick();}}
  assert.equal(h.storage.run.status,'completed');assert.equal(first.sends()+second.sends(),12);assert.ok(h.deviceEvents.every(x=>x.method.startsWith('Input.') || x.method === 'Emulation.setFocusEmulationEnabled'));
});
test('preexisting drafts are cleared with select-all/backspace and replaced by plugin text',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId,{draft:'我的草稿'});
  assert.equal(p.sends(),1);assert.notEqual(p.doc.querySelector('[data-message-author-role="user"]').textContent,'我的草稿');assert.equal(h.storage.run.tasks[0].phase,'waiting');
  assert.ok(h.deviceEvents.some(x=>x.params.commands?.includes('selectAll')));assert.ok(h.deviceEvents.some(x=>x.params.key==='Backspace'));
});
test('virtualizing old turns during send does not strand the runner or duplicate prompts',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});let removed=0;
  const p=await connect(h,t,s.run.tasks[0].tabId,{intercept:async(message,w)=>{
    if(message.type==='DEVICE_INPUT'&&message.action==='send'&&w.document.querySelectorAll('main article').length>=4){
      w.document.querySelector('main article').remove();w.document.querySelector('main article').remove();removed++;
    }
  }});
  for(let i=0;i<6;i++){await p.finish();if(i<5){h.advance(3000);await p.tick();}}
  assert.equal(removed,4);assert.equal(p.sends(),6);assert.equal(h.storage.run.tasks[0].recoveries,0);assert.equal(h.storage.run.status,'completed');
});
test('extra manual messages do not block or replace the matching plugin response',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId);
  p.doc.querySelector('main').insertAdjacentHTML('beforeend','<article><div data-message-author-role="user">手动消息</div></article><article><div data-message-author-role="assistant">手动消息的回答</div><button aria-label="复制"></button></article>');
  p.doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());const ours=p.doc.querySelectorAll('article')[1];ours.insertAdjacentHTML('beforeend','<button aria-label="复制"></button>');ours.querySelector('div').textContent='插件自己的回复';
  await p.tick();h.advance(4000);await p.tick();assert.equal(h.storage.run.tasks[0].completed,1);assert.equal(h.storage.run.tasks[0].transcript[0].response,'插件自己的回复');
});
test('unknown send automatically retries with backoff, then skips without user intervention',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId,{dropSend:true});
  for(let n=0;n<4;n++){h.advance(16000);await p.tick();if(n<3)await p.recover();}
  assert.equal(p.sends(),4);assert.equal(h.storage.run.tasks[0].status,'skipped');assert.equal(h.storage.run.status,'completed');
});
test('a late user bubble is adopted during recovery without a second click',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId,{dropSend:true});
  h.advance(16000);await p.tick();const text=h.storage.run.tasks[0].turns[0].text;
  const article=p.doc.createElement('article');article.innerHTML='<div data-message-author-role="user"></div>';article.firstChild.textContent=text;p.doc.querySelector('main').append(article);
  await p.recover();assert.equal(p.sends(),1);assert.equal(h.storage.run.tasks[0].phase,'waiting');
});
test('pause during typing cancels further device events and resumes by clearing the partial draft',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:true});let once=false;
  const p=await connect(h,t,s.run.tasks[0].tabId,{intercept:async(message,w)=>{if(!once&&message.type==='HEARTBEAT'&&w.document.querySelector('textarea').value.length>4){once=true;await h.message('RUN_PAUSE');}}});
  assert.equal(p.sends(),0);assert.equal(h.storage.run.status,'paused');await h.message('RUN_RESUME');await p.tick();assert.equal(p.sends(),1);
});
for(const locale of ['en','ja'])test(`${locale} device input recognizes localized controls and finishes six rounds`,async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId,{locale});
  for(let i=0;i<6;i++){await p.finish();if(i<5){h.advance(3000);await p.tick();}}
  assert.equal(h.storage.run.status,'completed');assert.equal(p.sends(),6);
});
test('page/worker reload while waiting records the reply without issuing another send',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId);await h.reloadWorker();await p.tick();assert.equal(p.sends(),1);assert.equal(h.storage.run.tasks[0].phase,'waiting');
});
test('stable idle answer without final buttons completes after ten seconds instead of waiting for timeout',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false,responseTimeout:1200});const p=await connect(h,t,s.run.tasks[0].tabId);
  p.doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());p.doc.querySelector('[data-message-author-role="assistant"]').textContent='没有最终按钮但已经结束的回复';
  await p.tick();h.advance(5000);await p.tick();assert.equal(h.storage.run.tasks[0].completed,0);h.advance(6000);await p.tick();assert.equal(h.storage.run.tasks[0].completed,1);assert.equal(p.sends(),1);
});
test('default 1200-second response wait survives the old 240-second cutoff during real streaming',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId);
  h.advance(601000);await p.tick();assert.equal(h.storage.run.tasks[0].phase,'waiting');assert.equal(h.storage.run.tasks[0].recoveries,0);assert.equal(p.sends(),1);
});
test('waiting reports generation progress and completion confirmation before the timeout',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false,responseTimeout:1200});const p=await connect(h,t,s.run.tasks[0].tabId);
  const reply=p.doc.querySelector('[data-message-author-role="assistant"]');reply.textContent='';
  await p.tick();let task=(await h.message('GET_STATE')).run.tasks[0];assert.match(task.waitStatus,/AI 正在思考.*上限 1200 秒/);
  reply.textContent='部分回复';h.advance(1200);await p.tick();task=(await h.message('PANEL_STATE',{},99)).run.tasks[0];assert.match(task.waitStatus,/正在生成回复.*已收到 4 字/);
  p.doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());reply.parentElement.insertAdjacentHTML('beforeend','<button aria-label="复制"></button>');
  await p.tick();task=(await h.message('GET_STATE')).run.tasks[0];assert.match(task.waitStatus,/正在确认完成/);assert.equal(task.completed,0);
  h.advance(4000);await p.tick();task=(await h.message('GET_STATE')).run.tasks[0];assert.equal(task.completed,1);assert.equal(task.waitStatus,'');assert.equal(task.recoveries,0);
});
test('the runner confirms page readiness before sending and uses a native bottom-arrow click',async t=>{
  const h=await harness(t);await bank(h,1);await h.message('RUN_START',{config:{sessions:1,typing:false,includeImages:false,minDelay:2,maxDelay:2}});const tabId=h.storage.run.tasks[0].tabId;const p=await connect(h,t,tabId);
  assert.equal(p.sends(),0);h.advance(2500);await p.tick();assert.equal(h.storage.run.tasks[0].pageReady,true);await p.tick();assert.equal(p.sends(),1);
  const bottom=p.doc.createElement('button');bottom.setAttribute('aria-label','Scroll to bottom');p.doc.body.append(bottom);bottom.getBoundingClientRect=()=>({left:520,top:20,right:560,bottom:60,width:40,height:40});const hit=p.doc.elementFromPoint;p.doc.elementFromPoint=x=>x>500?bottom:hit(x);const handler=h.inputHandlers.get(tabId);h.inputHandlers.set(tabId,(method,args)=>method==='Input.dispatchMouseEvent'&&args.x>500?undefined:handler(method,args));const prior=h.deviceEvents.length;await p.finish();
  assert.ok(h.deviceEvents.slice(prior).some(x=>x.method==='Input.dispatchMouseEvent'&&x.params.type==='mousePressed'));assert.equal(h.storage.run.tasks[0].completed,1);
});
test('image fallback waits for an actual loaded image, then continues its twelve-round refinement',async t=>{
  const h=await harness(t);await h.message('LIBRARY_SAVE',{library:[{id:'image-test',title:'连续图像',category:'test',turns:Array.from({length:12},(_,i)=>({text:`请基于上一张图直接生成第${i+1}版图片，保持同一主体。`,kind:'image'}))}]});
  const s=await h.start({sessions:1,includeImages:true,imageRatio:100,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId);
  p.doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());p.doc.querySelector('[data-message-author-role="assistant"]').textContent='正在生成图片';await p.tick();h.advance(20000);await p.tick();assert.equal(h.storage.run.tasks[0].completed,0);assert.equal(h.storage.run.tasks[0].recoveries,0);
  const img=p.doc.createElement('img');img.alt='生成的图片';img.src='https://example.org/generated.png';Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:1024});p.doc.querySelector('[data-message-author-role="assistant"]').append(img);await p.tick();h.advance(11000);await p.tick();assert.equal(h.storage.run.tasks[0].completed,1);assert.deepEqual(h.storage.run.tasks[0].transcript[0].images,['https://example.org/generated.png']);
});
test('an image-only gallery confirms the existing send and advances to the next refinement',async t=>{
  const h=await harness(t);await h.message('LIBRARY_SAVE',{library:[{id:'gallery-test',title:'纯图片连续会话',category:'test',turns:Array.from({length:12},(_,i)=>({text:`请直接生成第${i+1}版图片，延续上一版的主体。`,kind:'image'}))}]});
  const s=await h.start({sessions:1,includeImages:true,imageRatio:100,typing:false});const p=await connect(h,t,s.run.tasks[0].tabId);
  p.doc.querySelectorAll('[data-test-stop]').forEach(n=>n.remove());const article=p.doc.querySelector('main article:last-child');article.dataset.talvtTurnState='complete';article.innerHTML='<div><h4 data-conversation-role="assistant">ChatGPT 说：</h4><div data-chatgpt-search-message-ids="gallery"><div data-testid="generated-image-gallery"><img alt="已生成图像 1" src="https://example.org/gallery.png"></div></div></div>';
  const img=article.querySelector('img');Object.defineProperty(img,'complete',{value:true});Object.defineProperty(img,'naturalWidth',{value:64});await p.tick();h.advance(4000);await p.tick();assert.equal(p.sends(),1);assert.equal(h.storage.run.tasks[0].completed,1);assert.deepEqual(h.storage.run.tasks[0].transcript[0].images,['https://example.org/gallery.png']);
});
test('foreground loading can defer a committed send without consuming retries or leaving an uncertain checkpoint',async t=>{
  const h=await harness(t);await bank(h,1);const s=await h.start({sessions:1,typing:false});let deferred=false;
  const p=await connect(h,t,s.run.tasks[0].tabId,{intercept:async message=>{if(!deferred&&message.type==='DEVICE_INPUT'&&message.action==='send'){deferred=true;throw Error('XULIAO_PAGE_LOADING');}}});
  assert.equal(p.sends(),0);assert.equal(h.storage.run.tasks[0].checkpoint,null);assert.equal(h.storage.run.tasks[0].phase,'preparing');assert.equal(h.storage.run.tasks[0].recoveries,0);await p.tick();assert.equal(p.sends(),1);assert.equal(h.storage.run.tasks[0].phase,'waiting');
});
