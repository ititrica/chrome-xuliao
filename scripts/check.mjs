import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { validateLibrary } from '../lib/core.js';
import lexicon from '../data/jitter-lexicon.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.ok(manifest.permissions.includes('debugger'));
for (const target of [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)]) await access(path.join(root, target));
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test-output'].includes(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target)); else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(target);
  }
  return files;
}
for (const file of await walk(root)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}\n${result.stderr}`);
}
const library = validateLibrary(JSON.parse(await readFile(path.join(root, 'data/conversations.json'), 'utf8')));
assert.equal(library.length, 380);
await access(path.join(root, 'data/builtin-history.json'));
assert.equal(library.filter(item => item.turns.some(turn => turn.kind === 'image')).length, 100);
assert.ok(new Set(lexicon.categories.flatMap(group => group.words)).size > 2000);
assert.equal(lexicon.uniqueCount, new Set(lexicon.categories.flatMap(group => group.words)).size);
assert.equal(lexicon.count, lexicon.categories.reduce((sum, group) => sum + group.words.length, 0));
assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data/jitter-lexicon.json'), 'utf8')), lexicon);
console.log(`Manifest、运行文件引用、JavaScript 语法、380 组聊天库和 ${lexicon.uniqueCount} 词分类抖动词库检查通过。`);
