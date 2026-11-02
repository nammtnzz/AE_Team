const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { GatewayConversation, endpoint } = require('../dist/gateway');

const tool = { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
function options(protocol) {
  return { protocol, baseUrl: 'https://gateway.example/v1', apiKey: 'private-test-key',
    model: protocol === 'messages' ? 'claude-sonnet-5' : 'gpt-6.1-sol',
    system: 'System', prompt: 'User brief', maxTokens: 4096, tools: [tool] };
}
test('Responses tool output is linked by call_id and output history is retained', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return Response.json(requests.length === 1 ? {
      output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.cs"}' }],
      usage: { input_tokens: 20, output_tokens: 10 }
    } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Finished' }] }], usage: { input_tokens: 30, output_tokens: 15 } });
  };
  const conversation = new GatewayConversation(options('responses'), fetcher);
  const first = await conversation.turn();
  assert.equal(first.calls[0].arguments.path, 'a.cs');
  conversation.toolResults([{ id: 'call-1', output: 'code' }]);
  assert.equal((await conversation.turn()).text, 'Finished');
  assert.equal(requests[0].url, 'https://gateway.example/v1/responses');
  assert.equal(requests[1].body.input.at(-1).call_id, 'call-1');
  assert.equal(requests[0].headers['User-Agent'], 'AE-Team-VSCode/0.3.1');
  assert.equal(requests[0].body.store, false);
});
test('Anthropic tool_use and tool_result preserve the Messages protocol', async () => {
  let last;
  let count = 0;
  const conversation = new GatewayConversation(options('messages'), async (url, init) => {
    last = { url, body: JSON.parse(init.body), headers: init.headers };
    return Response.json(++count === 1 ? {
      content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'Level.cs' } }],
      usage: { input_tokens: 5, output_tokens: 2 }
    } : { content: [{ type: 'text', text: 'Done' }] });
  });
  assert.equal((await conversation.turn()).calls[0].id, 'tool-1');
  conversation.toolResults([{ id: 'tool-1', output: 'file contents' }]);
  await conversation.turn();
  assert.equal(last.url, 'https://gateway.example/v1/messages');
  assert.equal(last.headers['x-api-key'], 'private-test-key');
  assert.equal(last.body.messages.at(-1).content[0].tool_use_id, 'tool-1');
});
test('Chat adapter sends tool_call_id and detects truncated output', async () => {
  let count = 0; let sent;
  const conversation = new GatewayConversation(options('chat'), async (_, init) => {
    sent = JSON.parse(init.body);
    return Response.json(++count === 1 ? { choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'chat-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] } :
      { choices: [{ finish_reason: 'length', message: { content: 'cut off' } }] });
  });
  await conversation.turn(); conversation.toolResults([{ id: 'chat-call', output: 'file' }]);
  await assert.rejects(conversation.turn(), /bị cắt/);
  assert.equal(sent.messages.at(-1).tool_call_id, 'chat-call');
});
test('403 errors redact the API key and explain client restrictions', async () => {
  const conversation = new GatewayConversation(options('responses'), async () =>
    new Response('denied private-test-key client', { status: 403 }));
  await assert.rejects(conversation.turn(), error =>
    error.message.includes('403') && !error.message.includes('private-test-key') && error.message.includes('User-Agent'));
});
test('real HTTP transport works against a local mock gateway', async t => {
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Local gateway result' }] }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const o = options('responses'); o.baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  assert.equal((await new GatewayConversation(o).turn()).text, 'Local gateway result');
  assert.equal(received.path, '/v1/responses');
  assert.equal(received.authorization, 'Bearer private-test-key');
});
test('abort signal cancels requests and endpoint rejects accidental full routes', async () => {
  assert.throws(() => endpoint('https://example.com/v1/responses', 'responses'));
  const controller = new AbortController(); controller.abort();
  const conversation = new GatewayConversation({ ...options('responses'), signal: controller.signal }, async (_, init) => {
    init.signal.throwIfAborted(); return Response.json({});
  });
  await assert.rejects(conversation.turn(), { name: 'AbortError' });
});
