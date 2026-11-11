import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('chat content scripts only observe DOM and request native input', async () => {
  for (const file of ['content/adapter-chatgpt.js', 'content/runner.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.click\s*\(|execCommand|\.focus\s*\(|\.dispatchEvent\s*\(|\.value\s*=/, file);
  }
});
test('both control surfaces expose a parallel switch and no manual round or concurrency field', async () => {
  for (const file of ['ui/index.html', 'content/overlay.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /name="parallel"[^>]*type="checkbox"|type="checkbox"[^>]*name="parallel"/);
    assert.doesNotMatch(source, /name="(?:rounds|concurrency|mode)"/);
  }
});
test('both control surfaces expose a horizontal image ratio range',async()=>{
  for(const file of ['ui/index.html','content/overlay.js']){const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');assert.match(source,/name="imageRatio"[^>]*type="range"/);assert.match(source,/12–20/);}
});
test('the workbench exposes a selectable tone jitter range', async () => {
  const source = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(source, /name="jitter-kind" value="tone"/);
});
