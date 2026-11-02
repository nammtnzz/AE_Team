const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { safePath, listFiles, readText, allowedFile } = require('../dist/files');

test('workspace tools reject traversal, credentials, ignored trees and oversized files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-team-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Assets'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'Assets', 'Level.cs'), 'class Level {}');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=secret');
  await fs.writeFile(path.join(root, 'node_modules', 'module.js'), 'ignored');
  assert.deepEqual(await listFiles(root), ['Assets/Level.cs']);
  await assert.rejects(safePath(root, '../outside.cs'));
  await assert.rejects(safePath(root, 'Assets/../../outside.cs'));
  await assert.rejects(safePath(root, 'node_modules/module.js'));
  await assert.rejects(readText(root, '.env'));
  assert.equal(allowedFile('credentials.json'), false);
  assert.equal(await readText(root, 'Assets/Level.cs'), 'class Level {}');
  await fs.writeFile(path.join(root, 'large.cs'), 'x'.repeat(230000));
  await assert.rejects(readText(root, 'large.cs'), /lớn/);
  const nested = await safePath(root, 'New/Nested/Level.cs');
  assert.equal(nested, path.join(root, 'New', 'Nested', 'Level.cs'));
});
