import { Protocol } from './core';

export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface Turn { text: string; calls: ToolCall[]; raw: any; inputTokens: number; outputTokens: number; }
export interface RequestOptions {
  baseUrl: string; apiKey: string; model: string; protocol: Protocol; system: string; prompt: string;
  maxTokens: number; tools: ToolDefinition[]; signal?: AbortSignal;
}

export function endpoint(base: string, route: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL không hợp lệ.');
  const clean = base.replace(/\/+$/, '');
  if (/\/(responses|messages|chat\/completions|models)$/.test(clean)) throw new Error('Nhập Base URL, không nhập đường dẫn endpoint đầy đủ.');
  return clean + '/' + route;
}

function args(value: unknown): Record<string, unknown> {
  const decoded = typeof value === 'string' ? JSON.parse(value || '{}') : value;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Đối số công cụ không hợp lệ.');
  return decoded as Record<string, unknown>;
}

export class GatewayConversation {
  private history: any[];
  constructor(private options: RequestOptions, private fetcher: typeof fetch = fetch) {
    this.history = options.protocol === 'responses' ?
      [{ role: 'user', content: options.prompt }] :
      [{ role: 'user', content: options.prompt }];
  }
  async turn(): Promise<Turn> {
    const o = this.options;
    const toolDefs = o.tools.map(t => o.protocol === 'messages' ?
      { name: t.name, description: t.description, input_schema: t.parameters } :
      o.protocol === 'chat' ? { type: 'function', function: t } : { type: 'function', ...t, strict: false });
    const body: any = { model: o.model };
    if (o.protocol === 'responses') {
      Object.assign(body, { instructions: o.system, input: this.history, max_output_tokens: o.maxTokens, store: false,
        include: ['reasoning.encrypted_content'], tools: toolDefs });
    } else if (o.protocol === 'messages') {
      Object.assign(body, { system: o.system, messages: this.history, max_tokens: o.maxTokens, tools: toolDefs });
    } else {
      Object.assign(body, { messages: [{ role: 'system', content: o.system }, ...this.history],
        max_completion_tokens: o.maxTokens, tools: toolDefs });
    }
    const route = o.protocol === 'responses' ? 'responses' : o.protocol === 'messages' ? 'messages' : 'chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'AE-Team-VSCode/0.3.1' };
    if (o.protocol === 'messages') { headers['x-api-key'] = o.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else headers.Authorization = 'Bearer ' + o.apiKey;
    const signals = [AbortSignal.timeout(120000)];
    if (o.signal) signals.push(o.signal);
    const response = await this.fetcher(endpoint(o.baseUrl, route), {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any(signals),
      redirect: 'error'
    });
    if (!response.ok) {
      const raw = (await response.text()).slice(0, 1800);
      const detail = raw.split(o.apiKey).join('[REDACTED]');
      throw new Error('Gateway HTTP ' + response.status + ': ' + detail +
        (response.status === 403 ? '\nKiểm tra client và endpoint được gateway cho phép. Không tự giả mạo User-Agent.' : ''));
    }
    const json: any = await response.json();
    let text = ''; let calls: ToolCall[] = [];
    if (o.protocol === 'responses') {
      if (json.status === 'incomplete' || json.error) throw new Error('Response chưa hoàn tất: ' + JSON.stringify(json.incomplete_details || json.error));
      const output = json.output || [];
      text = output.filter((x: any) => x.type === 'message').flatMap((x: any) => x.content || [])
        .filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('\n');
      calls = output.filter((x: any) => x.type === 'function_call').map((x: any) =>
        ({ id: x.call_id, name: x.name, arguments: args(x.arguments) }));
      this.history.push(...output);
    } else if (o.protocol === 'messages') {
      if (json.stop_reason === 'max_tokens') throw new Error('Output bị cắt do giới hạn token. Tăng giới hạn hoặc thu nhỏ task.');
      text = (json.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
      calls = (json.content || []).filter((x: any) => x.type === 'tool_use').map((x: any) =>
        ({ id: x.id, name: x.name, arguments: args(x.input) }));
      this.history.push({ role: 'assistant', content: json.content });
    } else {
      const choice = json.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('Output bị cắt do giới hạn token.');
      const message = choice?.message;
      if (!message) throw new Error('Gateway không trả assistant message.');
      text = message.content || '';
      calls = (message.tool_calls || []).map((x: any) => ({ id: x.id, name: x.function.name, arguments: args(x.function.arguments) }));
      this.history.push(message);
    }
    const cachedInput = o.protocol === 'messages' ?
      (json.usage?.cache_read_input_tokens || 0) + (json.usage?.cache_creation_input_tokens || 0) : 0;
    return { text, calls, raw: json, inputTokens: (json.usage?.input_tokens ?? json.usage?.prompt_tokens ?? 0) + cachedInput,
      outputTokens: json.usage?.output_tokens ?? json.usage?.completion_tokens ?? 0 };
  }
  toolResults(results: { id: string; output: string }[]): void {
    if (this.options.protocol === 'responses') {
      this.history.push(...results.map(r => ({ type: 'function_call_output', call_id: r.id, output: r.output })));
    } else if (this.options.protocol === 'messages') {
      this.history.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })) });
    } else {
      this.history.push(...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.output })));
    }
  }
}
