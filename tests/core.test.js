import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, validateLibrary, normalizeConfig, migrateConfig, eligibleLibrary, imageAllocation, isImageSession, buildRun, progress, jitterPrompt } from '../lib/core.js';
const library = validateLibrary(JSON.parse(await readFile(new URL('../data/conversations.json', import.meta.url), 'utf8')));
test('380 unique scenarios include 280 text scripts and 100 twenty-step image refinements', () => {
  assert.equal(library.length,380); assert.equal(new Set(library.map(x=>x.title)).size,380);
  assert.equal(new Set(library.map(x=>x.category)).size,15);
  assert.equal(library.filter(isImageSession).length,100);assert.equal(library.flatMap(x=>x.turns).length,6200);
  for(const item of library){assert.equal(item.turns.length,isImageSession(item)?20:15);assert.ok(item.turns.every(t=>t.text.length>20&&!/\{(?:brief|focus|change|title)\}/.test(t.text)));if(isImageSession(item)){assert.ok(item.turns.every(t=>t.kind==='image'));assert.match(item.turns[0].text,/直接生成一张图片/);assert.ok(item.turns.slice(1).every(t=>/上一轮刚生成的图片/.test(t.text)));}}
});
test('new defaults give six chats, 12–45 seconds, slow typing, images and 1200-second waits',()=>{
  assert.deepEqual(normalizeConfig(),DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.sessions,6);assert.equal(DEFAULT_CONFIG.minDelay,12);assert.equal(DEFAULT_CONFIG.maxDelay,45);
  assert.equal(DEFAULT_CONFIG.responseTimeout,1200);assert.equal(DEFAULT_CONFIG.imageTimeout,1200);assert.equal(DEFAULT_CONFIG.typing,true);assert.equal(DEFAULT_CONFIG.includeImages,true);
});
test('config migration enables tone jitter for existing default selections while preserving an explicit empty selection',()=>{
  assert.ok(migrateConfig({ jitterKinds: ['theme', 'entity', 'number'] }, 3).jitterKinds.includes('tone'));
  assert.deepEqual(migrateConfig({ jitterKinds: [] }, 3).jitterKinds, []);
});
test('eligibility enforces six text rounds or twelve image rounds and the image switch',()=>{
  assert.equal(eligibleLibrary(library,normalizeConfig({includeImages:false})).length,280);
  assert.equal(eligibleLibrary(library,normalizeConfig()).length,380);
  assert.equal(eligibleLibrary(library,normalizeConfig({categories:['软件开发']})).length,20);
  const short=validateLibrary([{title:'short text',turns:['x']},{title:'short image',turns:Array(11).fill({text:'image',kind:'image'})}]);
  assert.equal(eligibleLibrary(short,normalizeConfig()).length,0);
});
test('sampling freezes contiguous prefixes and never repeats a script in the same batch',()=>{
  const run=buildRun(library,{sessions:280,includeImages:false,parallel:true,promptJitter:false});
  assert.equal(new Set(run.tasks.map(t=>t.sourceId)).size,280);assert.ok(run.concurrencyLimit>=1&&run.concurrencyLimit<=3);
  for(const t of run.tasks){const source=library.find(x=>x.id===t.sourceId);assert.ok(t.turns.length>=6&&t.turns.length<=15);assert.deepEqual(t.turns,source.turns.slice(0,t.turns.length));assert.notEqual(t.turns,source.turns);}
  assert.equal(progress(run).total,run.tasks.reduce((n,t)=>n+t.turns.length,0));
});
test('random endpoints include text 6/15, image 12/20 and parallel 1/3',()=>{
  for(const [value,textRounds,imageRounds,concurrent] of [[0,6,12,1],[0.999999,15,20,3]]){
    for(const [ratio,rounds] of [[0,textRounds],[100,imageRounds]]){const run=buildRun(library,{sessions:1,imageRatio:ratio,parallel:true},()=>value);assert.equal(run.tasks[0].turns.length,rounds);assert.equal(run.concurrencyLimit,concurrent);}
  }
  assert.equal(buildRun(library,{parallel:false}).concurrencyLimit,1);
});
test('image ratio selects rounded group counts and automatically fills scarce categories',()=>{
  for(const [ratio,count] of [[0,0],[30,2],[50,3],[100,6]]){
    const run=buildRun(library,{sessions:6,imageRatio:ratio});assert.equal(run.imageSessions,count);assert.equal(run.tasks.filter(isImageSession).length,count);
  }
  assert.equal(buildRun(library,{sessions:6,includeImages:false,imageRatio:100}).imageSessions,0);
  assert.equal(buildRun(library,{sessions:6,categories:['图片创作'],imageRatio:0}).imageSessions,6);
  assert.equal(buildRun(library,{sessions:6,categories:['旅行规划'],imageRatio:100}).imageSessions,0);
  const limited=library.filter(isImageSession).slice(0,1).concat(library.filter(x=>!isImageSession(x)).slice(0,8));
  assert.deepEqual(imageAllocation(limited,{sessions:6,imageRatio:80}),{images:1,text:5,requested:5,available:9});
  assert.equal(buildRun(limited,{sessions:6,imageRatio:80}).tasks.length,6);
});
test('old manual limits cannot override random rules and explicit switches take precedence',()=>{
  const c=normalizeConfig({sessions:999,rounds:1,concurrency:999,mode:'parallel',minDelay:20,maxDelay:3,imageRatio:999});
  assert.equal(c.sessions,300);assert.equal(c.parallel,true);assert.equal(c.rounds,undefined);assert.equal(c.concurrency,undefined);assert.equal(c.maxDelay,20);assert.equal(c.imageRatio,100);
  assert.equal(normalizeConfig({mode:'parallel',parallel:false}).parallel,false);
});
test('short custom scripts cap the prefix at the available length',()=>{
  for(const [count,kind] of [[6,'text'],[12,'image']]){const custom=validateLibrary([{title:'custom',turns:Array(count).fill({text:'same',kind})}]);assert.equal(buildRun(custom,{sessions:1},()=>0.999).tasks[0].turns.length,count);}
});
test('imports reject duplicates, empty prompts and more than twenty turns',()=>{
  assert.throws(()=>validateLibrary([{id:'a',title:'a',turns:['x']},{id:'a',title:'b',turns:['x']}]),/重复/);
  assert.throws(()=>validateLibrary([{title:'a',turns:[' ']}]),/第 1 轮/);
  assert.throws(()=>validateLibrary([{title:'a',turns:Array(21).fill('x')}]),/1–20/);
  assert.throws(()=>buildRun(library,{sessions:21,categories:['旅行规划']}),/只有 20 组/);
});
test('wording jitter preserves the body and full jitter can be disabled without changing the source',()=>{
  const original='请输出 12–20 轮，颜色保持 #315dce。只输出 "hello"，示例代码 `const n = 42;` 不要改动。';
  const low=jitterPrompt(original,()=>0),high=jitterPrompt(original,()=>0.999999);assert.notEqual(low,high);assert.notEqual(low,original);assert.ok(low.includes(original.slice(1)));assert.ok(high.includes(original.slice(1)));
  const raw='{"message":"请保持这个字段原文", "count":1200}';assert.ok(jitterPrompt(raw,()=>0.5).includes(raw));
  const scripts=validateLibrary([{id:'same',title:'same',turns:Array(6).fill(original)}]);const before=structuredClone(scripts);
  const a=buildRun(scripts,{sessions:1,promptJitter:true},()=>0),b=buildRun(scripts,{sessions:1,promptJitter:true},()=>0.999999);
  assert.notEqual(a.tasks[0].turns[0].text,b.tasks[0].turns[0].text);assert.equal(a.tasks[0].turns[0].sourceText,original);assert.deepEqual(scripts,before);
  const exact=buildRun(scripts,{sessions:1,promptJitter:false});assert.deepEqual(exact.tasks[0].turns,scripts[0].turns);
});
