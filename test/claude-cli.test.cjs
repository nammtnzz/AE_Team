const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCliOutput, CLI_SCHEMA } = require('../dist/claude-cli');
const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }];
test('official CLI bridge validates structured output and maps custom tool calls', () => {
  const result = parseCliOutput(JSON.stringify({
    structured_output: { text: 'Need a file', toolCalls: [{ name: 'read_file', argumentsJson: '{"path":"Level.cs"}' }] },
    num_turns: 2, usage: { input_tokens: 30, output_tokens: 15 }
  }), tools, 1);
  assert.equal(result.calls[0].name, 'read_file');
  assert.equal(result.calls[0].arguments.path, 'Level.cs');
  assert.equal(result.inputTokens, 30);
  assert.deepEqual(CLI_SCHEMA.required, ['text', 'toolCalls']);
});
test('CLI bridge rejects missing structured output, unknown tools and malformed arguments', () => {
  assert.throws(() => parseCliOutput('{"result":"unstructured"}', tools, 1), /structured_output/);
  assert.throws(() => parseCliOutput(JSON.stringify({ structured_output: { text: '', toolCalls: [
    { name: 'Bash', argumentsJson: '{}' }
  ] } }), tools, 1), /ngoài phạm vi/);
  assert.throws(() => parseCliOutput(JSON.stringify({ structured_output: { text: '', toolCalls: [
    { name: 'read_file', argumentsJson: '[]' }
  ] } }), tools, 1), /không hợp lệ/);
  assert.throws(() => parseCliOutput('{"is_error":true,"result":"permission denied"}', tools, 1), /permission denied/);
});
