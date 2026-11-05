import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { ToolDefinition, Turn } from './gateway';

export async function findClaude(configured = ''): Promise<string> {
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  if (configured) { await fs.access(configured); return configured; }
  const extensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
  const folders = (await fs.readdir(extensionRoot).catch(() => []))
    .filter(name => name.startsWith('anthropic.claude-code-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const candidates = [
    ...folders.map(name => path.join(extensionRoot, name, 'resources', 'native-binary', executable)),
    path.join(os.homedir(), '.local', 'bin', executable)
  ];
  for (const file of candidates) try { await fs.access(file); return file; } catch { /* next */ }
  throw new Error('Không tìm thấy Claude Code CLI chính thức. Cài Claude Code hoặc cấu hình aeTeam.claudePath.');
}

/**
 * The gateway/API settings the user configured for Claude Code (~/.claude/settings.json "env").
 * --restricted makes the CLI ignore that file, so AE_Team passes only these connection values through.
 */
const CONNECTION_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
export async function claudeCodeConnection(home = process.env.AECT_CLAUDE_HOME || os.homedir()): Promise<Record<string, string>> {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const env = settings && typeof settings.env === 'object' ? settings.env : {};
    return Object.fromEntries(CONNECTION_KEYS.filter(k => typeof env[k] === 'string' && env[k].trim()).map(k => [k, String(env[k]).trim()]));
  } catch { return {}; }
}

/** True when the CLI can reach Claude without an AE_Team key: Claude Code's own API/gateway settings or a signed-in account. */
export async function claudeAccountReady(executable: string): Promise<boolean> {
  const connection = await claudeCodeConnection();
  if (connection.ANTHROPIC_AUTH_TOKEN || connection.ANTHROPIC_API_KEY) return true;
  // A key helper program configured for Claude Code also counts as connected.
  try {
    const settings = JSON.parse(await fs.readFile(path.join(process.env.AECT_CLAUDE_HOME || os.homedir(), '.claude', 'settings.json'), 'utf8'));
    if (typeof settings?.apiKeyHelper === 'string' && settings.apiKeyHelper.trim()) return true;
  } catch { /* no user settings */ }
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE;
    const child = spawn(executable, ['auth', 'status'], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 20000);
    child.stdout.on('data', data => { stdout += String(data); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(stdout).loggedIn === true); } catch { resolve(false); } });
  });
}

export const CLI_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'Kết quả cuối cùng, hoặc giải thích ngắn khi cần gọi công cụ.' },
    toolCalls: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string' }, argumentsJson: { type: 'string', description: 'JSON object được encode thành chuỗi.' } },
      required: ['name', 'argumentsJson']
    } }
  },
  required: ['text', 'toolCalls']
};

export function parseCliOutput(stdout: string, tools: ToolDefinition[], round: number): Turn {
  const raw = JSON.parse(stdout.trim());
  if (raw.is_error) throw new Error('Claude Code: ' + String(raw.result || raw.subtype || 'request failed').slice(0, 1600));
  const output = raw.structured_output;
  if (!output || typeof output.text !== 'string' || !Array.isArray(output.toolCalls)) {
    throw new Error('Claude Code không trả structured_output hợp lệ. Kiểm tra phiên bản CLI và gateway.');
  }
  const calls = output.toolCalls.map((call: any, index: number) => {
    if (!tools.some(t => t.name === call.name)) throw new Error('CLI yêu cầu công cụ ngoài phạm vi: ' + call.name);
    const args = JSON.parse(call.argumentsJson);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Đối số công cụ CLI không hợp lệ.');
    return { id: 'cli-' + round + '-' + index, name: call.name, arguments: args };
  });
  return { text: output.text, calls, raw,
    inputTokens: (raw.usage?.input_tokens || 0) + (raw.usage?.cache_read_input_tokens || 0) + (raw.usage?.cache_creation_input_tokens || 0),
    outputTokens: raw.usage?.output_tokens || 0 };
}

export class ClaudeCliConversation {
  private history: unknown[] = [];
  private round = 0;
  constructor(private options: { executable: string; cwd: string; baseUrl: string; apiKey: string;
    model: string; system: string; prompt: string; maxTokens: number; tools: ToolDefinition[]; signal: AbortSignal }) {}
  async turn(): Promise<Turn> {
    const o = this.options; o.signal.throwIfAborted(); this.round++;
    const bridge = 'Bạn giao tiếp với ứng dụng AE Team qua structured output. ' +
      'Các built-in tool và MCP của CLI bị tắt có chủ đích. ' +
      'Muốn dùng công cụ của ứng dụng, trả toolCalls gồm name và argumentsJson là JSON object encode thành chuỗi. ' +
      'Khi đủ dữ liệu, trả text là bàn giao cuối và toolCalls = []. Không tạo file bằng cách khác.\n' +
      'CÔNG CỤ KHẢ DỤNG\n' + JSON.stringify(o.tools);
    const prompt = o.prompt + '\n\nLỊCH SỬ CÔNG CỤ VÀ PHẢN HỒI\n' + JSON.stringify(this.history);
    // Without an AE_Team key the CLI connects exactly like the user's own Claude Code: it loads the USER settings
    // (gateway/API env, apiKeyHelper) and the signed-in account, so whatever makes `claude` work on a machine makes
    // AE_Team work there too. Project/local settings stay ignored, and --tools '', --strict-mcp-config,
    // --disable-slash-commands and --permission-prompts none keep the run isolated. --bare (API keys only) is key mode.
    // A saved key is only used together with an Anthropic Base URL; a key with no Claude endpoint (e.g. one saved
    // for the OpenAI gateway) must not be sent to the official API, so Claude Code's own connection is used instead.
    const account = !o.apiKey || !o.baseUrl.trim();
    const connection = account ? await claudeCodeConnection() : {};
    const args = ['--print', '--output-format', 'json', ...(account ? ['--setting-sources', 'user', '--settings', JSON.stringify({ disableAllHooks: true })] : ['--bare', '--restricted']), '--strict-mcp-config',
      '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence',
      '--model', o.model, '--effort', 'medium', '--max-turns', '3',
      '--json-schema', JSON.stringify(CLI_SCHEMA), '--system-prompt', o.system + '\n' + bridge];
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(o.maxTokens), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN;
    if (account) Object.assign(env, connection);
    else { env.ANTHROPIC_BASE_URL = o.baseUrl.replace(/\/v1\/?$/, ''); env.ANTHROPIC_API_KEY = o.apiKey; }
    delete env.CLAUDECODE;
    // Secrets never reach error messages; an empty value must not be "redacted" (split('') breaks every character).
    const secrets = [o.apiKey, connection.ANTHROPIC_AUTH_TOKEN, connection.ANTHROPIC_API_KEY].filter((s): s is string => Boolean(s));
    const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(o.executable, args, { cwd: o.cwd, env, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', data => { stdout += String(data); if (stdout.length > 3000000) child.kill(); });
      child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-2000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        const safe = redact(stderr);
        if (code === 0) resolve(stdout);
        else {
          let detail = safe;
          try { const error = JSON.parse(stdout); detail = redact(String(error.result || error.subtype || safe)); } catch { /* stderr */ }
          // Account mode needs a CLI login of its own: the Claude Code VS Code extension keeps its session to itself.
          if (account && /not logged in|please run \/login/i.test(detail)) reject(new Error('Claude CLI chưa kết nối được. Cấu hình API/gateway cho Claude Code (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN trong ~/.claude/settings.json), lưu API key qua "AE_Team: Lưu API key", hoặc chạy "claude" rồi /login.'));
          else reject(new Error('Claude Code CLI (exit ' + code + '): ' + detail.slice(0, 1600)));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    let turn: Turn;
    // Errors reported inside a successful CLI run (e.g. a gateway rejection) are redacted too.
    try { turn = parseCliOutput(output, o.tools, this.round); } catch (error: any) { throw new Error(redact(String(error?.message || error))); }
    this.history.push({ assistant: { text: turn.text, toolCalls: turn.calls } });
    return turn;
  }
  toolResults(results: { id: string; output: string }[]): void { this.history.push({ toolResults: results }); }
}
