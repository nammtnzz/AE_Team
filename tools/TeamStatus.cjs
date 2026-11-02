/* Manual diagnostics only. Configured is not the same as connected. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
function status(installRoot) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(installRoot, 'installation.json')));
    const rel = path.relative(path.join(installRoot, 'versions'), info.runtimeRoot);
    if (!['aect-installation/v1','codex-ae-installation/v1'].includes(info.schema) || !rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Invalid installation pointer');
    const capability = require(path.join(info.runtimeRoot, 'tools/AeCapabilities.js')).capabilityStatus();
    const faults = [];
    if (!capability.installation.certificateMatches) faults.push('Bundle chưa có chứng nhận trùng phiên bản');
    for (const key of ['panelPath','startupPath']) {
      if (!info[key] || !fs.existsSync(info[key])) { faults.push('Thiếu loader: ' + key); continue; }
      const source = fs.readFileSync(info[key], 'utf8');
      const literal = /bundle = new File\(("(?:\\.|[^"\\])*")\);/.exec(source);
      let target; try { target = literal && JSON.parse(literal[1]); } catch {}
      if (typeof target !== 'string' || path.resolve(target).toLowerCase() !== path.resolve(info.runtimeRoot, 'jsx/AECT Engine.jsx').toLowerCase()) faults.push('Loader chưa trỏ đúng engine: ' + key);
    }
    const c = capability.connection, connected = !faults.length && c.fresh && c.state === 'running' && c.revisionMatches;
    return { state: faults.length ? 'repair-required' : connected ? 'connected' : 'disconnected', product: 'AE_CodexTeam', engineVersion: info.version, teamVersion: info.teamVersion || null, runtimeRoot: info.runtimeRoot,
      toolCount: capability.activeTools, additionalTools: ['aect_library_search'], connection: c, certificateMatches: capability.installation.certificateMatches,
      transport: 'ScriptUI-compatible', native: 'awaiting-sdk', faults,
      message: faults.length ? 'Cần sửa bản cài: ' + faults.join('; ') : connected ? 'Đã kết nối After Effects ' + c.afterEffectsVersion + ' · heartbeat mới, đúng phiên bản.' :
        'Đã cài engine · Chưa kết nối AE. Mở AE → Window → AE_CodexTeam Bridge, đóng/mở lại panel rồi kiểm tra.',
      checkedAt: new Date().toISOString() };
  } catch (e) { return { state: 'not-installed', message: 'Chưa cài hoặc cần sửa bản cài: ' + e.message }; }
}
if (require.main === module) console.log(JSON.stringify(status(process.argv[2] || path.join(process.env.LOCALAPPDATA, 'AE_CodexTeam')), null, 2));
module.exports = { status };
