import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.js';

test('serial scheduling waits for the whole random-length conversation before replenishing', async t => {
  const h=await harness(t);const s=await h.start({sessions:2,parallel:false});assert.equal(h.tabs.size,1);
  await h.completeTask(s.run.tasks[0].id);assert.equal(h.tabs.size,1);
  await h.completeTask('task-2');assert.equal(h.storage.run.status,'completed');
});
test('parallel random ceiling is obeyed and one slot is replenished on completion', async t => {
  const h=await harness(t);const s=await h.start({sessions:5,parallel:true});const ceiling=s.run.concurrencyLimit;
  assert.ok(ceiling>=1&&ceiling<=3);assert.equal(h.tabs.size,ceiling);
  await h.completeTask('task-1');assert.equal(h.tabs.size,ceiling);
  await h.readyAll();assert.equal(h.storage.run.tasks.filter(t=>['running','opening'].includes(t.status)).length,ceiling);
});
test('pause blocks new commit and device input; stop rejects late mutations', async t => {
  const h=await harness(t);const s=await h.start({sessions:1});const task=s.run.tasks[0],p={taskId:task.id,turn:0};
  await h.message('PULL',{},task.tabId);await h.message('CLAIM',p,task.tabId);await h.message('RUN_PAUSE');
  assert.equal((await h.message('COMMIT',{...p,checkpoint:{userCount:0}},task.tabId)).allowed,false);
  await assert.rejects(()=>h.message('DEVICE_INPUT',{...p,runId:s.run.id,revision:0,action:'type',text:'x'},task.tabId),/CANCELLED/);
  await h.message('RUN_STOP');await assert.rejects(()=>h.message('COMPLETE',{...p,response:'late'},task.tabId),/变化/);
  assert.equal(h.deviceEvents.length,0);
});
test('recovery persists backoff, reloads on the second attempt and skips after the third retry', async t => {
  const h=await harness(t);const s=await h.start({sessions:2});const task=s.run.tasks[0],p={taskId:task.id,turn:0};
  await h.message('PULL',{},task.tabId);
  for(let n=1;n<=4;n++) {await h.message('RECOVER',{...p,reason:'temporary'},task.tabId);assert.equal(h.storage.run.tasks[0].recoveries,n);}
  assert.equal(h.storage.run.tasks[0].status,'skipped');assert.equal(h.tabs.size,1);assert.equal(h.removedTabs.get(task.tabId).reloads,1);
});
test('uncertain send recovery reconciles its saved user count without sending again', async t => {
  const h=await harness(t);const s=await h.start({sessions:1});const task=s.run.tasks[0],p={taskId:task.id,turn:0};
  await h.message('PULL',{},task.tabId);await h.message('CLAIM',p,task.tabId);await h.message('COMMIT',{...p,checkpoint:{userCount:2}},task.tabId);
  await h.message('RECOVER',{...p,reason:'unconfirmed'},task.tabId);
  assert.equal(h.storage.run.tasks[0].checkpoint,null);assert.equal(h.storage.run.tasks[0].recoveryCheckpoint.userCount,2);
  await h.message('ADOPT_SENT',p,task.tabId);assert.equal(h.storage.run.tasks[0].phase,'waiting');assert.equal(h.storage.run.tasks[0].checkpoint.userCount,2);
});
test('stale run/revision and unassigned tabs cannot dispatch device events', async t => {
  const h=await harness(t);const s=await h.start({sessions:1});const task=s.run.tasks[0],p={taskId:task.id,turn:0,revision:0,runId:s.run.id};
  await h.message('PULL',{},task.tabId);await h.message('CLAIM',p,task.tabId);
  await h.message('RECOVER',{...p,reason:'retry'},task.tabId);
  await assert.rejects(()=>h.message('DEVICE_INPUT',{...p,action:'type',text:'x'},task.tabId),/CANCELLED/);
  await assert.rejects(()=>h.message('DEVICE_INPUT',{...p,action:'type',text:'x'},task.tabId+99),/对应/);
  assert.equal(h.deviceEvents.length,0);
});
test('closing a task tab skips it and advances the queue automatically', async t => {
  const h=await harness(t);const s=await h.start({sessions:2});const id=s.run.tasks[0].tabId;h.tabs.delete(id);
  await h.chrome.tabs.onRemoved.listeners[0](id);assert.equal(h.storage.run.tasks[0].status,'skipped');assert.equal(h.tabs.size,1);
});
test('library edits do not alter running prompt snapshots; custom scripts survive builtin migration', async t => {
  const custom={id:'custom-one',title:'personal',category:'test',turns:Array.from({length:8},(_,i)=>({text:`personal ${i}`,kind:'text'}))};
  const h=await harness(t,{library:[custom]});const loaded=await h.message('GET_STATE');assert.ok(loaded.library.some(x=>x.id==='custom-one'));assert.equal(loaded.library.length,381);
  await h.start({sessions:1});const before=await h.message('RUN_EXPORT');await h.message('LIBRARY_SAVE',{library:[custom]});assert.deepEqual((await h.message('RUN_EXPORT')).tasks[0].turns,before.tasks[0].turns);
});
test('floating menu accepts count, parallel and image ratio while ignoring unsupported overrides', async t => {
  const h=await harness(t);await h.message('PANEL_ACTION',{action:'start',config:{sessions:2,parallel:true,rounds:1,concurrency:99,typing:false,imageRatio:50,promptJitter:false}},99);
  assert.equal(h.storage.run.tasks.length,2);assert.equal(h.storage.run.config.typing,true);assert.equal(h.storage.run.config.parallel,true);assert.equal(h.storage.run.config.imageRatio,50);
  assert.equal(h.storage.run.config.promptJitter,false);
  assert.ok(h.storage.run.tasks.every(t=>t.turns.length>=6&&t.turns.length<=20));
});
test('ordinary worker reactivation keeps a run; browser startup pauses it', async t => {
  const h=await harness(t);await h.start({sessions:1});await h.reloadWorker();assert.equal(h.storage.run.status,'running');
  await h.chrome.runtime.onStartup.listeners[0]();assert.equal(h.storage.run.status,'paused');
});

test('new pages open active one at a time and wait for PAGE_READY before filling parallel slots',async t=>{
  const h=await harness(t);await h.message('RUN_START',{config:{sessions:3,parallel:true,includeImages:false}});
  const first=h.storage.run.tasks[0];assert.equal(h.tabs.size,1);assert.equal(h.tabs.get(first.tabId).active,true);
  await h.message('PULL',{},first.tabId);assert.equal(h.storage.run.tasks[0].status,'opening');assert.equal(h.tabs.size,1);
  await h.message('PAGE_READY',{taskId:first.id,turn:0},first.tabId);
  assert.equal(h.storage.run.tasks[0].pageReady,true);assert.equal(h.tabs.size,Math.min(2,h.storage.run.concurrencyLimit));
});
test('finished task closes before replacement creation, preserves response URLs and leaves unrelated tabs alone',async t=>{
  const h=await harness(t,{},[{id:44,url:'https://example.org/',active:true}]);const s=await h.start({sessions:2});const old=s.run.tasks[0].tabId;
  await h.completeTask('task-1');const state=h.storage.run.tasks[0];assert.equal(state.tabId,null);assert.equal(state.closePending,false);assert.ok(state.url);assert.equal(state.transcript.length,state.turns.length);
  const removed=h.operations.findIndex(x=>x.action==='remove'&&x.id===old);assert.ok(removed>=0);assert.equal(h.operations[removed+1].action,'create');assert.equal(h.operations[removed+1].data.active,true);assert.ok(h.tabs.has(44));
  await h.completeTask('task-2');assert.equal(h.tabs.size,1);assert.equal(h.storage.run.status,'completed');
});
test('a failed close is persisted and retried before another page can be created',async t=>{
  const h=await harness(t);await h.start({sessions:2});const original=h.chrome.tabs.remove;let fail=true;
  h.chrome.tabs.remove=async id=>{if(fail)throw Error('temporary close failure');return original(id);};
  await h.completeTask('task-1');assert.equal(h.storage.run.tasks[0].closePending,true);assert.equal(h.storage.run.tasks[1].status,'queued');
  fail=false;await h.chrome.alarms.onAlarm.listeners[0]({name:'xuliao-watchdog'});await h.message('GET_STATE');assert.equal(h.storage.run.tasks[0].tabId,null);assert.equal(h.storage.run.tasks[1].status,'opening');
});
test('0.3 migration upgrades released image scripts and old defaults while preserving edited and custom scripts',async t=>{
  const {readFile}=await import('node:fs/promises');const old=JSON.parse(await readFile(new URL('fixtures/builtin-0.2.0-image.json',import.meta.url),'utf8'));
  const edited={...structuredClone(old),id:'builtin-15-02',title:'我编辑过的图片',turns:old.turns.map((x,i)=>i===0?{...x,text:'personal prompt'}:x)};
  const h=await harness(t,{config:{sessions:3,minDelay:5,maxDelay:12,responseTimeout:240,imageTimeout:600,includeImages:false,typing:true},configVersion:2,builtinLibraryVersion:2,library:[old,edited]});
  const s=await h.message('GET_STATE');assert.equal(s.library.length,380);assert.equal(s.library.find(x=>x.id===old.id).turns.length,20);assert.ok(s.library.find(x=>x.id===old.id).turns.every(x=>x.kind==='image'));assert.deepEqual(s.library.find(x=>x.id===edited.id),edited);
  assert.equal(s.config.sessions,6);assert.equal(s.config.minDelay,12);assert.equal(s.config.maxDelay,45);assert.equal(s.config.responseTimeout,1200);assert.equal(s.config.imageTimeout,1200);assert.equal(s.config.includeImages,true);
  await h.message('SAVE_CONFIG',{config:{...s.config,sessions:9,includeImages:false,responseTimeout:900}});await h.reloadWorker();const again=await h.message('GET_STATE');assert.equal(again.config.sessions,9);assert.equal(again.config.includeImages,false);assert.equal(again.config.responseTimeout,900);
});
test('existing tasks cannot steal focus while another new conversation is still loading',async t=>{
  const {buildRun}=await import('../lib/core.js');const scripts=[0,1].map(n=>({id:`focus-${n}`,title:`focus ${n}`,category:'test',turns:Array.from({length:6},()=>({text:'prompt',kind:'text'}))}));
  const run=buildRun(scripts,{sessions:2,parallel:true,includeImages:false},()=>0.99);run.tasks[0].status='opening';run.tasks[0].tabId=1;
  const h=await harness(t,{run,library:scripts,builtinLibraryVersion:3,configVersion:3},[{id:1,url:'https://chatgpt.com/',active:true}]);
  await h.message('PAGE_READY',{taskId:run.tasks[0].id,turn:0},1);const first=h.storage.run.tasks[0],second=h.storage.run.tasks[1];assert.equal(second.status,'opening');
  const payload={taskId:first.id,turn:0,runId:run.id,revision:0,action:'clear',point:{x:20,y:20}};await h.message('CLAIM',payload,1);
  await assert.rejects(()=>h.message('DEVICE_INPUT',payload,1),/PAGE_LOADING/);assert.equal(h.deviceEvents.length,0);
  await h.message('PAGE_READY',{taskId:second.id,turn:0},second.tabId);await h.message('DEVICE_INPUT',payload,1);assert.ok(h.deviceEvents.some(x=>x.method==='Input.dispatchMouseEvent'));assert.equal(h.tabs.get(1).active,true);
});
test('jittered prompts are frozen across recoveries and exports retain both sent and original prompts',async t=>{
  const h=await harness(t);await h.start({sessions:1,promptJitter:true});const task=h.storage.run.tasks[0];const prompt=structuredClone(task.turns[0]);assert.ok(prompt.sourceText);assert.notEqual(prompt.text,prompt.sourceText);
  await h.message('RECOVER',{taskId:task.id,turn:0,reason:'temporary'},task.tabId);h.advance(3000);assert.deepEqual(h.storage.run.tasks[0].turns[0],prompt);
  await h.complete(h.storage.run.tasks[0]);const row=(await h.message('RUN_EXPORT')).tasks[0].transcript[0];assert.equal(row.prompt,prompt.text);assert.equal(row.sourcePrompt,prompt.sourceText);assert.equal(row.jittered,true);
});
test('scheduling replacement tabs never focuses the OS window',async t=>{
  const h=await harness(t);const focused=[];h.chrome.windows.update=async(id,options)=>focused.push({id,options});
  const s=await h.start({sessions:2});h.storage.run.windowId=1;
  // Set the real in-memory run window through a saved-state restart as well.
  await h.reloadWorker();await h.message('GET_STATE');await h.completeTask(s.run.tasks[0].id);
  assert.equal(h.storage.run.tasks[1].status,'opening');assert.equal(focused.length,0);assert.equal(h.tabs.get(h.storage.run.tasks[1].tabId).active,true);
});
test('paused idle conversations do not trigger watchdog reloads or consume retries',async t=>{
  const h=await harness(t);await h.start({sessions:1});await h.message('RUN_PAUSE');h.advance(180000);
  await h.chrome.alarms.onAlarm.listeners[0]({name:'xuliao-watchdog'});await h.message('GET_STATE');
  assert.equal(h.storage.run.tasks[0].recoveries,0);assert.equal(h.tabs.get(h.storage.run.tasks[0].tabId).reloads,undefined);assert.equal(h.storage.run.status,'paused');
});
