import test from 'node:test';
import assert from 'node:assert/strict';
import { podLogText } from '../src/kubernetes/pod-log-text';

test('plain text pod logs pass through unchanged', () => {
  assert.equal(podLogText('hello\n'), 'hello\n');
  assert.equal(podLogText(''), '');
});

test('a log the client JSON-parsed comes back as its JSON text, not [object Object]', () => {
  const parsed = { returnsSeen: ['a', 'b'], dryRun: true };
  assert.equal(podLogText(parsed), '{"returnsSeen":["a","b"],"dryRun":true}');
  assert.equal(podLogText([1, 2]), '[1,2]');
});

test('buffers and byte arrays are decoded as utf8', () => {
  assert.equal(podLogText(Buffer.from('buffer log\n')), 'buffer log\n');
  assert.equal(podLogText(new TextEncoder().encode('bytes log\n')), 'bytes log\n');
});

test('missing bodies are empty and unserialisable ones do not throw', () => {
  assert.equal(podLogText(undefined), '');
  assert.equal(podLogText(null), '');
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(typeof podLogText(circular), 'string');
});
