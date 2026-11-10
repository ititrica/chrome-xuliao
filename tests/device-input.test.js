import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceInput } from '../lib/device-input.js';
function setup(check=async()=>{},mac=false){const events=[],attached=[];const api={debugger:{async attach(target){attached.push(target);},async detach(){},async sendCommand(target,method,params){if(method==='Input.dispatchKeyEvent'&&params.type==='char')assert.equal(params.text.length,1);events.push({target,method,params});}}};return {driver:createDeviceInput(api,check,mac),events,attached};}
test('clear uses native pointer, platform select-all and backspace; text never uses DOM evaluation',async()=>{
  for(const mac of [false,true]){const {driver,events,attached}=setup(undefined,mac);await driver.perform(4,{action:'clear',point:{x:100,y:50}});await driver.perform(4,{action:'type',text:'日本語\nEnglish🦊'});await driver.perform(4,{action:'send',point:{x:200,y:50}});
  assert.equal(attached.length,1);assert.ok(events.every(e=>e.method.startsWith('Input.') || e.method === 'Emulation.setFocusEmulationEnabled'));assert.equal(events.find(e=>e.params.commands)?.params.modifiers,mac?4:2);assert.ok(events.some(e=>e.params.key==='Enter'&&e.params.modifiers===8));assert.equal(events.filter(e=>e.params.type==='mousePressed').length,2);}
});
test('pause/stop gate is checked again after attach before sending a pointer press',async()=>{
  let calls=0;const {driver,events}=setup(async()=>{if(++calls>1)throw Error('cancelled');});await assert.rejects(()=>driver.perform(2,{action:'send',point:{x:20,y:20}}),/cancelled/);assert.ok(!events.some(e=>e.params.type==='mousePressed'));
});
test('manual debugger cancellation is respected and programmatic cleanup does not cancel future sessions',async()=>{
  const {driver}=setup();await driver.perform(3,{action:'type',text:'a'});await driver.release(3);assert.equal(driver.detached(3,'canceled_by_user'),false);await driver.perform(3,{action:'type',text:'b'});assert.equal(driver.detached(3,'canceled_by_user'),true);await assert.rejects(()=>driver.perform(3,{action:'type',text:'c'}),/用户取消/);driver.resume();await driver.perform(3,{action:'type',text:'d'});
});

test('input transactions for concurrent tabs never interleave',async()=>{
  const {driver,events}=setup();await Promise.all([driver.perform(1,{action:'clear',point:{x:20,y:20}}),driver.perform(2,{action:'type',text:'第二页'})]);
  const split=events.findIndex(e=>e.target.tabId===2);assert.ok(split>0);assert.ok(events.slice(split).every(e=>e.target.tabId===2));
});
test('native actions select the task tab without focusing its OS window',async()=>{
  const order=[];let active=false;
  const api={tabs:{async get(id){return {id,windowId:7,active};},async update(id,data){active=data.active;order.push('activate');}},windows:{async update(id,data){assert.equal(id,7);assert.equal(data.focused,true);order.push('focus');}},debugger:{async attach(){order.push('attach');},async detach(){},async sendCommand(target,method){if(method.startsWith('Input.')){assert.equal(active,true);order.push('input');}}}};
  const driver=createDeviceInput(api,async()=>{});await driver.perform(9,{action:'bottom',point:{x:20,y:30}});await driver.perform(9,{action:'type',text:'后台输入'});assert.ok(order.indexOf('activate')<order.indexOf('input'));assert.ok(!order.includes('focus'));assert.equal(order.filter(x=>x==='activate').length,1);
});
