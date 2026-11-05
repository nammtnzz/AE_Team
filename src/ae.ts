import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { searchLibrary } from '../engine/tools/AeLibrarySearch';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolDefinition } from './gateway';

export interface AeStep { function: string; args: Record<string, unknown>; as?: string; }
export interface AePlan { schema: 'aect-functions/v1'; steps: AeStep[]; }
export interface AeProposal {
  id: string; sessionId?: string; taskId?: string; title: string; reason: string; plan: AePlan;
  state: 'proposed' | 'dispatching' | 'success' | 'uncertain' | 'dismissed';
  createdAt: number; result?: unknown;
}
export interface AeFunction { name: string; description: string; inputSchema: any; mutates: boolean; exclusive?: boolean; }
export interface AeOptions { root?: string; node?: string; pwsh?: string; log?: (text: string) => void; }
export const AE_READ_FUNCTIONS = ['team.system.info', 'team.project.inspect', 'team.comp.inspect', 'team.layer.inspect', 'team.property.list', 'team.property.get', 'team.project.search', 'team.comp.hierarchy', 'team.effects.list', 'team.effect.inspect'];

export function unpack(result: any): any {
  const text = result.content?.filter((v: any) => v.type === 'text').map((v: any) => v.text).join('\n') || '';
  let value: any; try { value = JSON.parse(text); } catch { value = { message: text }; }
  if (result.isError) throw new Error(value.message || text || 'AE MCP error');
  return value;
}
export function validatePlan(value: unknown, functions: AeFunction[]): AePlan {
  // Copy data to prevent edits to a staged plan during review/dispatch.
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > 131072) throw new Error('Plan tối đa 128 KiB.');
  const plan = JSON.parse(text);
  const walk = (x: any, depth = 0) => {
    if (depth > 32) throw new Error('Plan quá sâu.');
    if (x && typeof x === 'object') for (const k of Object.keys(x)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('Khóa JSON không hợp lệ.');
      walk(x[k], depth + 1);
    }
  };
  walk(plan);
  if (plan?.schema !== 'aect-functions/v1' || Object.keys(plan).some(k => !['schema', 'steps'].includes(k)) ||
      !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100) throw new Error('Cần schema aect-functions/v1 và 1–100 bước.');
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  let captures = 0; const labels = new Set<string>();
  // The runtime resolves every {name} selector before step 1 runs, so a comp/layer created earlier in the
  // same plan can only be reached through step.as + {"ref": label}. Catch this here, before dispatch.
  const created = new Map<string, string>();
  const selectorNames = (value: any, out: string[] = []): string[] => {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['comp', 'layer', 'parent', 'item'].includes(key) && child && typeof child === 'object' && typeof (child as any).name === 'string') out.push((child as any).name);
      selectorNames(child, out);
    }
    return out;
  };
  for (const step of plan.steps) {
    for (const name of selectorNames(step?.args)) if (created.has(name))
      throw new Error(step.function + ': "' + name + '" được tạo ở bước ' + created.get(name) + ' của cùng plan. Thêm "as": "<nhãn>" vào bước tạo và dùng {"ref": "<nhãn>"} thay cho {"name": "' + name + '"}.');
    if (/\.create$/.test(String(step?.function)) && typeof step?.args?.name === 'string') created.set(step.args.name, step.function);
  }
  for (const step of plan.steps) {
    if (!step || typeof step.function !== 'string' || !step.args || typeof step.args !== 'object' || Array.isArray(step.args) ||
        Object.keys(step).some(k => !['function', 'args', 'as'].includes(k))) throw new Error('Bước plan không hợp lệ.');
    const fn = functions.find(f => f.name === step.function && f.name !== 'team.script.run');
    if (!fn) throw new Error('Function chưa cài hoặc bị chặn: ' + step.function);
    const validate = ajv.compile(fn.inputSchema);
    if (!validate(step.args)) throw new Error(step.function + ': ' + ajv.errorsText(validate.errors));
    if (step.as !== undefined) {
      if (typeof step.as !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(step.as) || labels.has(step.as)) throw new Error('Nhãn as thiếu, trùng hoặc không hợp lệ.');
      labels.add(step.as);
    }
    if (step.function === 'team.inspection.capture') {
      captures++;
      if (captures > 1 || (Array.isArray(step.args.times) && step.args.times.length > 3) || Number(step.args.numFrames || 1) > 3) throw new Error('Chỉ một capture, tối đa 3 frame/plan.');
    }
    if ((fn.exclusive || ['team.app.memory', 'team.project.open', 'team.project.save', 'team.project.undo', 'team.render.start'].includes(step.function)) && plan.steps.length !== 1) throw new Error(step.function + ' phải chạy riêng.');
  }
  return plan;
}
export function makeAeProposal(plan: AePlan, title: string, reason: string, sessionId?: string, taskId?: string): AeProposal {
  if (!title?.trim() || title.length > 200 || !reason?.trim() || reason.length > 5000) throw new Error('Plan cần tên và lý do hợp lệ.');
  return { id: randomUUID(), sessionId, taskId, title, reason, plan, state: 'proposed', createdAt: Date.now() };
}
export function boundedResult(value: any): any {
  const text = JSON.stringify(value);
  return text.length <= 120000 ? value : { state: value?.state, runId: value?.runId, truncated: true,
    message: 'Kết quả quá lớn cho dashboard. Đọc bản đầy đủ trong .ae-codex/bridge/results của engine.', preview: text.slice(0, 120000) };
}

/** One lazy local MCP connection, no polling and no automatic job replay. */
export function resolveEngineRoot(explicit?: string, local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')): string {
  if (explicit) return path.resolve(explicit);
  for (const name of ['AE_Team', 'AE_CodexTeam', 'CodexAE']) {
    const base = path.join(local, name);
    try { const info = JSON.parse(readFileSync(path.join(base, 'installation.json'), 'utf8'));
      const runtime = path.resolve(info.runtimeRoot); const rel = path.relative(path.join(base, 'versions'), runtime);
      // CodexAE is only a pre-migration fallback: it must carry our product marker and not be retired,
      // so a side-by-side Codex AE install there is never mistaken for AE_CodexTeam.
      if (['aect-installation/v1', 'codex-ae-installation/v1'].includes(info.schema) && (['AE_Team', 'AE_CodexTeam'].includes(name) || (info.product === 'AE_CodexTeam' && info.state !== 'uninstalled')) && rel && !rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(path.join(runtime, 'tools', 'AeFunctionsMcp.js'))) return runtime;
    } catch { /* try next compatible install */ }
  }
  // The VSIX does not package engine/ (the EXE installs it), so the bundled folder only exists in a source checkout.
  const bundled = path.resolve(__dirname, '..', 'engine'), legacy = path.join(os.homedir(), 'AE_Codex');
  // The integrated engine travels with AE_CodexTeam; legacy AE_Codex is migration-only.
  for (const candidate of [bundled, legacy]) if (existsSync(path.join(candidate, 'tools', 'AeFunctionsMcp.js'))) return candidate;
  return '';
}
export const ENGINE_MISSING = 'Chưa tìm thấy engine AE_CodexTeam. Chạy AE_CodexTeam-Setup.exe → Cài đặt / Sửa chữa, hoặc đặt aeTeam.enginePath trong Settings.';
export class AeEngine {
  readonly root: string;
  private client?: Client;
  private connecting?: Promise<void>;
  private closed = false;
  private busy = false;
  private discovered?: AeFunction[];
  constructor(private options: AeOptions = {}) { this.root = resolveEngineRoot(options.root); }
  private async connect(): Promise<void> {
    if (this.closed) throw new Error('AE connector đã đóng.');
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.root) throw new Error(ENGINE_MISSING);
      const script = path.join(this.root, 'tools', 'AeFunctionsMcp.js');
      await fs.access(script).catch(() => { throw new Error(ENGINE_MISSING); });
      const bundledPwsh = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
      const pwsh = this.options.pwsh || (await fs.access(bundledPwsh).then(() => bundledPwsh, () => 'pwsh'));
      const transport = new StdioClientTransport({ command: this.options.node || 'node', args: [script], cwd: this.root,
        env: { ...getDefaultEnvironment(), AECT_PWSH: pwsh }, stderr: 'pipe', maxBufferSize: 10 * 1024 * 1024 });
      transport.stderr?.on('data', data => this.options.log?.(String(data).slice(0, 2000)));
      const client = new Client({ name: 'ae-team-vscode', version: '1.0.0' }, { capabilities: {} });
      client.onerror = e => this.options.log?.(e.message);
      client.onclose = () => { if (this.client === client) { this.client = undefined; this.discovered = undefined; } };
      try {
        await client.connect(transport, { timeout: 10000 });
        // Search comes first; catalog discovery never dispatches an AE job.
        unpack(await client.callTool({ name: 'aect_search_capabilities', arguments: { kind: 'function', limit: 1 } }, undefined, { timeout: 10000 }));
        if (this.closed) throw new Error('AE connector đã đóng.');
        this.client = client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async call(name: string, args: Record<string, unknown> = {}, live = false): Promise<any> {
    // Every project dispatch (including inspections) shares one lane.
    if (live && this.busy) throw new Error('AE đang có lệnh chạy. Chờ kết quả trước.');
    if (live) this.busy = true;
    try {
      await this.connect();
      return unpack(await this.client!.callTool({ name, arguments: args }, undefined, { timeout: live ? 210000 : 15000 }));
    } finally { if (live) this.busy = false; }
  }
  async functions(refresh = false): Promise<AeFunction[]> {
    if (this.discovered && !refresh) return this.discovered;
    await this.connect();
    const list = await this.client!.listTools(undefined, { timeout: 15000 });
    const entries = unpack(await this.client!.callTool({ name: 'aect_list_functions', arguments: { includeLegacy: false } }, undefined, { timeout: 15000 }));
    this.discovered = entries.functions.filter((f: any) => f.name !== 'team.script.run').map((f: any) => {
      const tool = list.tools.find(t => t.name === 'aect_' + f.name.replaceAll('.', '_'));
      if (!tool) throw new Error('Thiếu MCP schema: ' + f.name);
      return { name: f.name, description: f.description, mutates: Boolean(f.mutates), exclusive: Boolean(f.exclusive), inputSchema: tool.inputSchema };
    });
    return this.discovered!;
  }
  async validate(value: unknown): Promise<AePlan> { return validatePlan(value, await this.functions()); }
  async run(plan: AePlan): Promise<any> {
    const checked = validatePlan(plan, await this.functions(true));
    return this.call('aect_run_plan', { steps: checked.steps }, true);
  }
  async read(fn: string, args: Record<string, unknown>): Promise<any> {
    // Explicit allowlist. ReadOnlyHint alone never permits a new live tool.
    if (!AE_READ_FUNCTIONS.includes(fn)) throw new Error('Chỉ cho phép công cụ đọc project. Đề xuất plan cho các lệnh khác.');
    const plan = await this.validate({ schema: 'aect-functions/v1', steps: [{ function: fn, args }] });
    return this.call('aect_run_plan', { steps: plan.steps }, true);
  }
  async inventory(query = ''): Promise<unknown> {
    if (typeof query !== 'string' || query.length > 200) throw new Error('Từ khóa tối đa 200 ký tự.');
    if (!this.root) throw new Error(ENGINE_MISSING);
    const current = JSON.parse(await fs.readFile(path.join(this.root, '.ae-codex/library/current.json'), 'utf8').catch((e: any) => { if (e.code === 'ENOENT') return '{}'; throw e; }));
    const config = JSON.parse(await fs.readFile(path.join(this.root, '.ae-codex/library/config.json'), 'utf8').catch((error: any) => {
      if (error.code === 'ENOENT') return '{}'; throw error;
    }));
    const sfxEnabled = Boolean(config.sfx && config.sfx.enabled !== false && (config.sfx.enabled === true || config.sfx.roots?.length));
    if (!sfxEnabled) {
      for (const key of Object.keys(current)) if (/^sfx/i.test(key)) delete current[key];
      current.sfxCount = 0; current.sfxEnabled = false; current.sfxState = 'disabled';
    }
    const guidance = await Promise.all(['.ae-codex/library/USAGE.md', '.ae-codex/plugins/USAGE.md'].map(p => fs.readFile(path.join(this.root, p), 'utf8').then(s => s.slice(0, 14000))));
    let effects: string[] = [];
    if (query && config.effects?.enabled !== false && current.effectsEnabled !== false) {
      const text = await fs.readFile(path.join(this.root, '.ae-codex/plugins/effects-and-parameters.tsv'), 'utf8').catch((e: any) => { if (e.code === 'ENOENT') return ''; throw e; });
      effects = text.split(/\r?\n/).filter(s => s.toLowerCase().includes(query.toLowerCase())).slice(0, 35);
    }
    const sfx = sfxEnabled ? await searchLibrary(this.root, { query, limit: 20 }) : { state: 'disabled', results: [] };
    // SFX catalog is never traversed or exposed when indexing is opted out.
    return { current, effectsEnabled: config.effects?.enabled !== false, sfxEnabled,
      effects, sfx, guidance, note: 'Catalog đã lưu; không quét. Không xác nhận license/render support. SFX: kết quả tìm từ metadata đã lưu; chưa import audio.' };
  }
  async dispose(): Promise<void> { this.closed = true; await this.client?.close().catch(() => {}); this.client = undefined; }
}

export const AE_TOOLS: ToolDefinition[] = [
  { name: 'aect_find', description: 'Tìm function AE đã cài; chỉ đọc catalog, không chạy JSX.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'aect_schema', description: 'Đọc schema của capability ID từ aect_find trước khi lập plan.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'aect_read', description: 'Đọc project qua named function. Một lệnh AE tại một thời điểm, không tự retry sau lỗi/timeout.', parameters: { type: 'object', properties: { function: { type: 'string' }, argumentsJson: { type: 'string', description: 'JSON object theo schema vừa inspect' } }, required: ['function', 'argumentsJson'], additionalProperties: false } },
  { name: 'aect_library', description: 'Đọc trạng thái và hướng dẫn thư viện plugin/SFX, tìm effect matchName và SFX theo tên/tags trong catalog đã lưu. Không quét.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'aect_propose_plan', description: 'Gửi JSON plan; ứng dụng chạy ngay trong AE (một lần, tuần tự) và trả kết quả thật. Plan schema aect-functions/v1; chỉ function đã inspect. Comp/layer tạo trong cùng plan: gắn "as" ở bước tạo và tham chiếu {"ref": nhãn} ở các bước sau (không dùng {"name"}).', parameters: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' }, planJson: { type: 'string' } }, required: ['title', 'reason', 'planJson'], additionalProperties: false } }
];

