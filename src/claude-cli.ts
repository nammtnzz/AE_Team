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
    const args = ['--print', '--output-format', 'json', '--bare', '--restricted', '--strict-mcp-config',
      '--tools', '', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence',
      '--model', o.model, '--effort', 'medium', '--max-turns', '3',
      '--json-schema', JSON.stringify(CLI_SCHEMA), '--system-prompt', o.system + '\n' + bridge];
    const env = { ...process.env, ANTHROPIC_BASE_URL: o.baseUrl.replace(/\/v1\/?$/, ''),
      ANTHROPIC_API_KEY: o.apiKey, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(o.maxTokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete (env as NodeJS.ProcessEnv).ANTHROPIC_AUTH_TOKEN;
    delete (env as NodeJS.ProcessEnv).CLAUDECODE;
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
        const safe = stderr.split(o.apiKey).join('[REDACTED]');
        if (code === 0) resolve(stdout);
        else {
          let detail = safe;
          try { const error = JSON.parse(stdout); detail = String(error.result || error.subtype || safe).split(o.apiKey).join('[REDACTED]'); } catch { /* stderr */ }
          reject(new Error('Claude Code CLI (exit ' + code + '): ' + detail.slice(0, 1600)));
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
