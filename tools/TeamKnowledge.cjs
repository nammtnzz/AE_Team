// Shares learned lessons between machines. The release carries a sanitized copy of this machine's lessons;
// installing it merges them into the receiving machine's own store, which keeps learning on top of them.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'aect-shared-lessons/v1';
const KINDS = ['tip', 'fix', 'preference', 'project', 'avoid'];
const ROLES = ['lead', 'architect', 'gameplay', 'camera_ui', 'sfx_vfx', 'art', 'reviewer'];
const MAX_LESSONS = 2000;
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,}|password\s*[:=]|access_token|refresh_token)/i;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 1) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, file);
}
const words = text => String(text || '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}_.]+/u).filter(w => w.length > 1);
const key = item => words(item.title).join(' ') + '|' + words(item.project).join(' ');
// Personal profile paths never travel; project folders shrink to the project's own name.
const sanitize = value => String(value || '').replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '%USERPROFILE%');
const roles = value => Array.isArray(value) ? [...new Set(value.filter(r => ROLES.includes(r)))] : [];
const valid = item => item && typeof item.title === 'string' && typeof item.lesson === 'string' && !SECRET.test(item.title + ' ' + item.lesson);

function exportShared(knowledgeDir, outputFile) {
  const store = readJson(path.join(knowledgeDir, 'lessons.json'), { lessons: [] });
  const lessons = (Array.isArray(store.lessons) ? store.lessons : []).filter(valid).map(item => ({
    title: sanitize(item.title), lesson: sanitize(item.lesson), kind: KINDS.includes(item.kind) ? item.kind : 'tip',
    tags: (Array.isArray(item.tags) ? item.tags : []).slice(0, 12).map(sanitize), roles: roles(item.roles),
    project: path.basename(sanitize(item.project).replace(/[\\/]+$/, '')), createdAt: item.createdAt, updatedAt: item.updatedAt,
    confirmations: item.confirmations || 1
  })).sort((a, b) => a.title.localeCompare(b.title) || a.project.localeCompare(b.project));
  if (!lessons.length) { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); return { exported: 0 }; }
  writeJson(outputFile, { schema: SCHEMA, lessons });
  return { exported: lessons.length };
}

function mergeShared(sharedFile, knowledgeDir) {
  const shared = readJson(sharedFile, null);
  if (!shared || shared.schema !== SCHEMA || !Array.isArray(shared.lessons)) return { added: 0, updated: 0, kept: 0 };
  const storeFile = path.join(knowledgeDir, 'lessons.json');
  const store = readJson(storeFile, { schema: 'codex-ae-knowledge/v1', lessons: [] });
  const lessons = Array.isArray(store.lessons) ? store.lessons : [];
  const local = new Map(lessons.map(item => [key(item), item]));
  let added = 0, updated = 0, kept = 0;
  const now = new Date().toISOString();
  for (const item of shared.lessons) {
    if (!valid(item)) continue;
    const existing = local.get(key(item));
    if (!existing) {
      const entry = { id: crypto.randomUUID().slice(0, 8), title: item.title, lesson: item.lesson, kind: KINDS.includes(item.kind) ? item.kind : 'tip',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [], project: item.project || '', roles: roles(item.roles),
        createdAt: item.createdAt || now, updatedAt: item.updatedAt || now, confirmations: item.confirmations || 1, source: 'shared-release' };
      lessons.push(entry); local.set(key(entry), entry); added++;
    } else if ((item.updatedAt || '') > (existing.updatedAt || '')) {
      // The newer wording wins; this machine's own confirmations are never lowered.
      Object.assign(existing, { lesson: item.lesson, kind: KINDS.includes(item.kind) ? item.kind : existing.kind, updatedAt: item.updatedAt,
        roles: roles(item.roles).length ? roles(item.roles) : existing.roles, confirmations: Math.max(existing.confirmations || 1, item.confirmations || 1) });
      updated++;
    } else { existing.confirmations = Math.max(existing.confirmations || 1, item.confirmations || 1); kept++; }
  }
  if (lessons.length > MAX_LESSONS) { lessons.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); lessons.length = MAX_LESSONS; }
  if (added || updated || kept) writeJson(storeFile, { schema: 'codex-ae-knowledge/v1', lessons });
  return { added, updated, kept, total: lessons.length };
}

if (require.main === module) {
  try {
    const [command, first, second] = process.argv.slice(2);
    let result;
    if (command === '--export' && first && second) result = exportShared(path.resolve(first), path.resolve(second));
    else if (command === '--merge' && first && second) result = mergeShared(path.resolve(first), path.resolve(second));
    else throw new Error('Usage: TeamKnowledge.cjs --export <knowledgeDir> <sharedFile> | --merge <sharedFile> <knowledgeDir>');
    process.stdout.write(JSON.stringify({ schema: 'aect-knowledge-share/v1', state: 'success', ...result }));
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { exportShared, mergeShared };
