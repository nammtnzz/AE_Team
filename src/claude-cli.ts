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

/** True when Claude Code is signed in to a Claude account, so the CLI can run without an API key. */
export async function claudeAccountReady(executable: string): Promise<boolean> {
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
    // Without an API key the CLI runs on the Claude account signed in to Claude Code (subscription/OAuth).
    // --bare accepts only API keys, so account mode drops it; --restricted still ignores user/project
    // settings and removes code-running tools, and --tools '' / --strict-mcp-config keep the CLI isolated.
    const account = !o.apiKey;
    const args = ['--print', '--output-format', 'json', ...(account ? [] : ['--bare']), '--restricted', '--strict-mcp-config',
      '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence',
      '--model', o.model, '--effort', 'medium', '--max-turns', '3',
      '--json-schema', JSON.stringify(CLI_SCHEMA), '--system-prompt', o.system + '\n' + bridge];
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(o.maxTokens), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    if (account) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; }
    else { env.ANTHROPIC_BASE_URL = o.baseUrl.replace(/\/v1\/?$/, ''); env.ANTHROPIC_API_KEY = o.apiKey; }
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDECODE;
    // An empty key must not be "redacted": split('') would interleave the marker between every character.
    const redact = (text: string) => o.apiKey ? text.split(o.apiKey).join('[REDACTED]') : text;
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
          if (account && /not logged in|please run \/login/i.test(detail)) reject(new Error('Claude CLI chưa đăng nhập tài khoản. Mở terminal, chạy "claude" rồi gõ /login (một lần), hoặc lưu API key qua "AE_Team: Lưu API key".'));
          else reject(new Error('Claude Code CLI (exit ' + code + '): ' + detail.slice(0, 1600)));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    const turn = parseCliOutput(output, o.tools, this.round);
    this.history.push({ assistant: { text: turn.text, toolCalls: turn.calls } });
    return turn;
  }
  toolResults(results: { id: string; output: string }[]): void { this.history.push({ toolResults: results }); }
}
