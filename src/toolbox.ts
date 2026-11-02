import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDefinition } from './gateway';

// Skills, plugin skills and MCP servers already installed for Codex and Claude Code.
// - Discovery only runs when the CEO presses Quét; the public snapshot (no env/headers) is cached.
// - Skills are reference text only: SKILL.md and text files beside it, never their scripts.
// - MCP servers start only after the CEO enables them and only when a model needs them.
//   Read-only tools (readOnlyHint, not destructive) run directly; anything else is queued for review.
// - The AE_Codex server is excluded: AE work always goes through the built-in engine and plan queue.
// - Credentials stay in the original config files and are only handed to the MCP process/request.

export interface SkillInfo { id: string; name: string; description: string; source: string; file: string; }
export interface McpServerInfo { id: string; name: string; source: string; type: 'stdio' | 'http' | 'sse'; target: string; }
export interface McpServerSpec extends McpServerInfo {
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; url?: string; headers?: Record<string, string>;
}
export interface ToolboxSnapshot { scannedAt: number; skills: SkillInfo[]; servers: McpServerInfo[]; excluded: string[]; }
export interface McpTool { name: string; description: string; readOnly: boolean; inputSchema: unknown; }
export interface McpProposal {
  id: string; sessionId?: string; taskId?: string; serverId: string; serverName: string; tool: string;
  args: Record<string, unknown>; reason: string; state: 'proposed' | 'dispatching' | 'success' | 'uncertain' | 'dismissed';
  createdAt: number; result?: unknown;
}

const MAX_SKILLS = 300, MAX_SKILL_BYTES = 60000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', 'scripts', 'agents', 'dist', 'tests', 'src']);
const SKILL_TEXT = /\.(md|txt|json|ya?ml|csv|tsv)$/i;

async function readJson(file: string): Promise<any> { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; } }
async function isDir(dir: string): Promise<boolean> { try { return (await fs.stat(dir)).isDirectory(); } catch { return false; } }

export function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), fields: Record<string, string> = {};
  if (match) for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (pair && !fields[pair[1]]) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return fields;
}

async function scanSkills(root: string, source: string, found: SkillInfo[], depth = 4): Promise<void> {
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth || found.length >= MAX_SKILLS) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      const file = path.join(dir, 'SKILL.md');
      try {
        const meta = frontmatter((await fs.readFile(file, 'utf8')).slice(0, 4000));
        const name = meta.name || path.basename(dir);
        found.push({ id: source + ':' + name, name, description: (meta.description || '').slice(0, 300), source, file });
      } catch { /* unreadable skill */ }
      return; // a skill folder's subfolders are its own references
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), level + 1);
  };
  await walk(root, 0);
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';
function expand(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => vars[name] ?? '');
}
/** Normalizes Codex TOML and Claude JSON server entries; returns undefined for disabled/invalid ones. */
export function normalizeServer(raw: any, name: string, source: string, vars: Record<string, string | undefined> = process.env): McpServerSpec | undefined {
  if (!raw || typeof raw !== 'object' || raw.enabled === false || raw.disabled === true) return undefined;
  const text = (v: unknown) => typeof v === 'string' ? expand(v, vars) : undefined;
  const map = (v: unknown) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v as Record<string, unknown> : {})
    .filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, expand(x as string, vars)]));
  const base = { id: '', name, source };
  const url = text(raw.url) || text(raw.serverUrl);
  if (url) {
    let parsed: URL; try { parsed = new URL(url); } catch { return undefined; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    const headers = { ...map(raw.headers), ...map(raw.http_headers) };
    for (const [header, variable] of Object.entries(map(raw.env_http_headers))) if (vars[variable]) headers[header] = vars[variable]!;
    if (typeof raw.bearer_token_env_var === 'string' && vars[raw.bearer_token_env_var]) headers.Authorization = 'Bearer ' + vars[raw.bearer_token_env_var];
    return { ...base, type: raw.type === 'sse' || raw.transport === 'sse' ? 'sse' : 'http', target: parsed.host, url, headers };
  }
  const command = text(raw.command);
  if (!command) return undefined;
  const env = map(raw.env);
  // Codex env_vars: names forwarded from the parent environment.
  if (Array.isArray(raw.env_vars)) for (const variable of raw.env_vars) if (typeof variable === 'string' && vars[variable] !== undefined) env[variable] = vars[variable]!;
  return { ...base, type: 'stdio', target: path.basename(command), command,
    args: Array.isArray(raw.args) ? raw.args.filter((a: unknown) => typeof a === 'string').map((a: string) => expand(a, vars)) : [],
    cwd: text(raw.cwd), env };
}
/** AE_Codex is reached through the built-in engine only. */
export function isAeCodexServer(spec: McpServerSpec): boolean {
  return /^ae[_-]?functions$|codex[_-]?ae|ae[_-]?codex/i.test(spec.name) || [spec.command, ...(spec.args || [])].some(a => /AeFunctionsMcp\.js/i.test(a || ''));
}

async function pluginServers(root: string, source: string, out: McpServerSpec[], vars: Record<string, string | undefined>): Promise<void> {
  const local = { ...vars, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root };
  const manifest = await readJson(path.join(root, '.claude-plugin', 'plugin.json')) || await readJson(path.join(root, 'plugin.json'));
  let servers = manifest?.mcpServers;
  if (typeof servers === 'string') servers = await readJson(path.resolve(root, servers));
  if (!servers) servers = await readJson(path.join(root, '.mcp.json')) || await readJson(path.join(root, 'mcp.json'));
  servers = servers?.mcpServers || servers;
  if (servers && typeof servers === 'object') for (const [name, raw] of Object.entries(servers)) {
    const spec = normalizeServer(raw, name, source, local); if (spec) out.push(spec);
  }
}
async function newestVersion(dir: string): Promise<string | undefined> {
  let names: string[]; try { names = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); } catch { return undefined; }
  names.sort((a, b) => a === 'latest' ? 1 : b === 'latest' ? -1 : b.localeCompare(a, undefined, { numeric: true }));
  return names[0] ? path.join(dir, names[0]) : undefined;
}

export interface DiscoverOptions { home?: string; workspace?: string; env?: Record<string, string | undefined>; }
/** Full discovery including credentials. Callers persist only `publicSnapshot()` of it. */
export async function discover(options: DiscoverOptions = {}) {
  const home = options.home || os.homedir(), env = options.env || process.env, workspace = options.workspace;
  const skills: SkillInfo[] = [], servers: McpServerSpec[] = [];
  for (const [dir, source] of [[path.join(home, '.codex', 'skills'), 'codex'], [path.join(home, '.agents', 'skills'), 'agents'],
    [path.join(home, '.claude', 'skills'), 'claude'], ...(workspace ? [[path.join(workspace, '.claude', 'skills'), 'workspace'], [path.join(workspace, '.agents', 'skills'), 'workspace']] : [])])
    if (await isDir(dir)) await scanSkills(dir, source, skills);

  // Codex: config.toml servers and enabled plugins.
  let codex: any = {};
  try { codex = parseToml(await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8')); } catch { /* no Codex config */ }
  for (const [name, raw] of Object.entries(codex.mcp_servers || {})) { const spec = normalizeServer(raw, name, 'codex', env); if (spec) servers.push(spec); }
  for (const [key, value] of Object.entries(codex.plugins || {})) {
    if ((value as any)?.enabled !== true) continue;
    const [plugin, market] = key.split('@'); if (!plugin || !market) continue;
    const root = await newestVersion(path.join(home, '.codex', 'plugins', 'cache', market, plugin));
    if (!root) continue;
    await scanSkills(path.join(root, 'skills'), 'codex-plugin:' + plugin, skills);
    await pluginServers(root, 'codex-plugin:' + plugin, servers, env);
  }
  // Claude Code: user + project servers, workspace .mcp.json and installed plugins.
  const claude = await readJson(path.join(home, '.claude.json')) || {};
  for (const [name, raw] of Object.entries(claude.mcpServers || {})) { const spec = normalizeServer(raw, name, 'claude', env); if (spec) servers.push(spec); }
  if (workspace) {
    const project = Object.entries(claude.projects || {}).find(([p]) => path.resolve(p).toLowerCase() === path.resolve(workspace).toLowerCase())?.[1] as any;
    for (const [name, raw] of Object.entries(project?.mcpServers || {})) { const spec = normalizeServer(raw, name, 'claude-project', env); if (spec) servers.push(spec); }
    const local = await readJson(path.join(workspace, '.mcp.json'));
    for (const [name, raw] of Object.entries(local?.mcpServers || {})) { const spec = normalizeServer(raw, name, 'workspace', env); if (spec) servers.push(spec); }
  }
  const installed = await readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  for (const [key, entries] of Object.entries(installed?.plugins || {})) {
    const entry = Array.isArray(entries) ? entries.at(-1) : entries;
    const root = typeof (entry as any)?.installPath === 'string' ? (entry as any).installPath : undefined;
    if (!root || !await isDir(root)) continue;
    const plugin = key.split('@')[0];
    await scanSkills(path.join(root, 'skills'), 'claude-plugin:' + plugin, skills);
    await pluginServers(root, 'claude-plugin:' + plugin, servers, env);
  }

  const taken = new Set<string>(), excluded: string[] = [], kept: McpServerSpec[] = [];
  for (const spec of servers) {
    if (isAeCodexServer(spec)) { excluded.push(spec.source + ':' + spec.name); continue; }
    let id = slug(spec.source + '-' + spec.name);
    if (taken.has(id)) id = id.slice(0, 33) + '-' + createHash('sha256').update(spec.source + spec.name + kept.length).digest('hex').slice(0, 6);
    taken.add(id); kept.push({ ...spec, id });
  }
  const seenSkills = new Set<string>();
  return { skills: skills.filter(s => !seenSkills.has(s.id) && seenSkills.add(s.id)), servers: kept, excluded };
}
export function publicSnapshot(found: Awaited<ReturnType<typeof discover>>): ToolboxSnapshot {
  return { scannedAt: Date.now(), skills: found.skills, excluded: found.excluded,
    servers: found.servers.map(({ id, name, source, type, target }) => ({ id, name, source, type, target })) };
}

/** Reads SKILL.md or a text reference file inside the skill folder. Never runs anything. */
export async function readSkill(skill: SkillInfo, file?: string, offset = 0): Promise<{ file: string; total: number; text: string }> {
  const dir = path.dirname(skill.file);
  let target = skill.file;
  if (file) {
    const resolved = path.resolve(dir, file), rel = path.relative(dir, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !SKILL_TEXT.test(resolved)) throw new Error('Chỉ đọc file văn bản (.md/.txt/.json/.yaml/.csv) bên trong thư mục skill.');
    target = resolved;
  }
  const real = await fs.realpath(target), realDir = await fs.realpath(dir);
  if (path.relative(realDir, real).startsWith('..')) throw new Error('File nằm ngoài thư mục skill.');
  if ((await fs.stat(real)).size > MAX_SKILL_BYTES * 4) throw new Error('File skill quá lớn.');
  const text = await fs.readFile(real, 'utf8');
  return { file: path.relative(dir, real).replace(/\\/g, '/') || 'SKILL.md', total: text.length, text: text.slice(offset, offset + MAX_SKILL_BYTES / 3) };
}

/** Lazy MCP connections for CEO-enabled servers. No polling; closed on pause/dispose. */
export class McpHub {
  private clients = new Map<string, { client: Client; tools?: McpTool[] }>();
  private connecting = new Map<string, Promise<Client>>();
  constructor(private resolve: (id: string) => Promise<McpServerSpec | undefined>, private log: (text: string) => void = () => {}) {}
  private async client(id: string): Promise<Client> {
    const open = this.clients.get(id); if (open) return open.client;
    const pending = this.connecting.get(id); if (pending) return pending;
    const promise = (async () => {
      const spec = await this.resolve(id);
      if (!spec) throw new Error('Server MCP ' + id + ' không còn trong cấu hình Codex/Claude hoặc chưa được bật. Bấm Quét lại.');
      const transport = spec.type === 'stdio' ?
        new StdioClientTransport({ command: spec.command!, args: spec.args, cwd: spec.cwd, env: { ...getDefaultEnvironment(), ...spec.env }, stderr: 'pipe' }) :
        spec.type === 'sse' ? new SSEClientTransport(new URL(spec.url!), { requestInit: { headers: spec.headers } }) :
          new StreamableHTTPClientTransport(new URL(spec.url!), { requestInit: { headers: spec.headers } });
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', data => this.log('[mcp ' + id + '] ' + String(data).slice(0, 1000)));
      const client = new Client({ name: 'ae-codexteam', version: '1.0.0' }, { capabilities: {} });
      client.onclose = () => { if (this.clients.get(id)?.client === client) this.clients.delete(id); };
      try { await client.connect(transport, { timeout: 30000 }); }
      catch (error) { await client.close().catch(() => {}); throw error; }
      this.clients.set(id, { client }); return client;
    })().finally(() => this.connecting.delete(id));
    this.connecting.set(id, promise); return promise;
  }
  async tools(id: string): Promise<McpTool[]> {
    const client = await this.client(id), entry = this.clients.get(id)!;
    if (!entry.tools) {
      const list = await client.listTools(undefined, { timeout: 30000 });
      entry.tools = list.tools.slice(0, 200).map(t => ({ name: t.name, description: (t.description || '').slice(0, 600),
        readOnly: t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true, inputSchema: t.inputSchema }));
    }
    return entry.tools;
  }
  async call(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal, timeout = 120000): Promise<unknown> {
    const client = await this.client(id);
    const result: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout, signal });
    const text = (result.content || []).map((c: any) => c.type === 'text' ? c.text : '[' + c.type + ']').join('\n');
    if (result.isError) throw new Error((text || 'MCP tool lỗi').slice(0, 4000));
    return { text: text.slice(0, 30000), truncated: text.length > 30000, structured: result.structuredContent };
  }
  get open(): number { return this.clients.size; }
  async closeAll(): Promise<void> {
    const all = [...this.clients.values()]; this.clients.clear();
    await Promise.all(all.map(c => c.client.close().catch(() => {})));
  }
}

export function makeMcpProposal(fields: Omit<McpProposal, 'id' | 'state' | 'createdAt'>): McpProposal {
  if (!fields.reason?.trim() || fields.reason.length > 5000) throw new Error('Lệnh MCP cần lý do (1–5000 ký tự).');
  if (JSON.stringify(fields.args).length > 65536) throw new Error('Đối số MCP tối đa 64 KiB.');
  return { ...fields, id: randomUUID(), state: 'proposed', createdAt: Date.now() };
}

export const TOOLBOX_TOOLS: ToolDefinition[] = [
  { name: 'list_skills', description: 'Liệt kê skill đã cài cho Codex/Claude (kể cả skill trong plugin). Skill là tài liệu hướng dẫn tham khảo; không chạy script của skill.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } },
  { name: 'read_skill', description: 'Đọc SKILL.md (hoặc file tham khảo văn bản trong thư mục skill) theo id từ list_skills.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, file: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['id'], additionalProperties: false } },
  { name: 'mcp_list_tools', description: 'Liệt kê tool của một server MCP đã được CEO bật. readOnly=true thì gọi trực tiếp được; còn lại mcp_call sẽ tạo đề xuất chờ CEO duyệt.',
    parameters: { type: 'object', properties: { serverId: { type: 'string' } }, required: ['serverId'], additionalProperties: false } },
  { name: 'mcp_call', description: 'Gọi tool MCP. Tool chỉ đọc chạy ngay và trả kết quả. Tool có thể ghi/sửa không chạy ngay: tạo đề xuất trong hàng chờ, CEO duyệt rồi mới thực thi, một lệnh một lúc, không tự chạy lại khi lỗi.',
    parameters: { type: 'object', properties: { serverId: { type: 'string' }, tool: { type: 'string' }, argumentsJson: { type: 'string', description: 'JSON object theo inputSchema' }, reason: { type: 'string' } },
      required: ['serverId', 'tool', 'argumentsJson', 'reason'], additionalProperties: false } }
];
