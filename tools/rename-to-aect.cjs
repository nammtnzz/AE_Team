'use strict';
// One-off migration: give AE_CodexTeam its own identifiers so nothing is shared with Codex AE.
// Usage: node tools/rename-to-aect.cjs [--dry]
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), dry = process.argv.includes('--dry');
const dirs = ['engine', 'src', 'test', 'tools', 'native', 'media'];
const exts = new Set(['.js', '.ts', '.cjs', '.ps1', '.cs', '.cpp', '.h', '.json', '.md', '.html', '.r', '.cmd']);
const skip = p => /[\\/](out|node_modules)[\\/]/.test(p) || /media[\\/]office\.js$/.test(p) || /rename-to-aect\.cjs$/.test(p);

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'engine/.ae-codex/functions/catalog.json'), 'utf8'));
const functionNames = [...new Set([...catalog.functions.map(f => f.name), 'script.run'])].filter(n => !n.startsWith('team.'));

// Legacy spots that must keep reading the OLD names (pre-rename installs).
const keep = [
  "(Join-Path $legacyInstall.runtimeRoot 'jsx/Codex Bridge.jsx')"
];
const rules = [
  // Wire schemas and data formats.
  [/codex-ae-/g, 'aect-'],
  // ExtendScript / process globals and env vars.
  [/__CODEX_AE_/g, '__AECT_'], [/CODEX_AE_/g, 'AECT_'], [/__codexAe/g, '__aect'], [/CodexAeSetup/g, 'AectSetup'],
  // Bundle file.
  [/Codex Bridge\\\\?\.jsx/g, m => m.replace('Codex Bridge', 'AECT Engine')],
  [/Codex%20Bridge\.jsx/g, 'AECT%20Engine.jsx'],
  [/Codex AE Bridge/g, 'AE_CodexTeam Bridge'],
  // MCP server tools.
  [/\bae_(search_capabilities|inspect_capability|run_plan|capability_status|list_functions|library_search|run_capability)\b/g, 'aect_$1'],
  // Per-function MCP tool / capability IDs.
  [/"ae_" \+ name/g, '"aect_" + name'], [/'ae_' \+ f\.name/g, "'aect_' + f.name"], [/startsWith\('ae_'\)/g, "startsWith('aect_')"],
];
// Model-facing tools of the VS Code extension (src/test/media only).
const modelTools = [[/\bpropose_ae_plan\b/g, 'aect_propose_plan'], [/\bae_search\b/g, 'aect_find'], [/\bae_inspect\b/g, 'aect_schema'],
  [/\bae_read\b/g, 'aect_read'], [/\bae_inventory\b/g, 'aect_library']];
// Function names: only exact quoted literals, e.g. "comp.create" -> "team.comp.create".
const fnPattern = new RegExp('(["\'])(' + functionNames.map(n => n.replace(/\./g, '\\.')).join('|') + ')\\1', 'g');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) walk(p, out); else if (exts.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}
let changed = 0, hits = 0;
for (const file of dirs.flatMap(d => walk(path.join(root, d)))) {
  const before = fs.readFileSync(file, 'utf8');
  let text = before;
  keep.forEach((k, i) => { text = text.split(k).join('\u0000KEEP' + i + '\u0000'); });
  for (const [re, to] of rules) text = text.replace(re, m => (hits++, typeof to === 'function' ? to(m) : m.replace(re, to)));
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (/^(src|test|media)\//.test(rel)) for (const [re, to] of modelTools) text = text.replace(re, () => (hits++, to));
  text = text.replace(fnPattern, (m, q, name) => (hits++, q + 'team.' + name + q));
  keep.forEach((k, i) => { text = text.split('\u0000KEEP' + i + '\u0000').join(k); });
  if (text !== before) { changed++; if (!dry) fs.writeFileSync(file, text); }
}
console.log(JSON.stringify({ dry, files: changed, hits, functions: functionNames.length }));
