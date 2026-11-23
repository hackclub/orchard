import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, type Token } from './syntax';

const kinds = (line: Token[]) =>
	line.filter((t) => t.kind).map((t) => `${t.kind}:${t.text.trim()}`);

test('tokens always add back up to the source text', () => {
	const code = 'const a = "x"; // hi\n<b class="y">&lt;</b>\n';
	for (const lang of ['typescript', 'html', 'json', null] as const) {
		const lines = tokenize(code, lang);
		assert.equal(
			lines.map((l) => l.map((t) => t.text).join('')).join('\n'),
			code.replace(/\n$/, '')
		);
	}
});

test('typescript finds keywords, strings, numbers and comments', () => {
	const [line] = tokenize(
		'export const port = Number(process.env.PORT ?? 3000); // listen',
		'typescript'
	);
	assert.deepEqual(
		kinds(line).filter((k) => !k.startsWith('punct')),
		['keyword:export', 'keyword:const', 'number:3000', 'comment:// listen']
	);
});

test('block comments and template strings carry across lines', () => {
	const lines = tokenize('/* one\ntwo */ let x = `a\nb` + 1', 'javascript');
	assert.equal(lines[0][0].kind, 'comment');
	assert.equal(lines[1][0].kind, 'comment');
	assert.ok(kinds(lines[1]).includes('string:`a'));
	assert.equal(lines[2][0].kind, 'string');
	assert.ok(kinds(lines[2]).includes('number:1'));
});

test('json keys differ from string values', () => {
	const [line] = tokenize('  "name": "web", "private": true', 'json');
	assert.deepEqual(
		kinds(line).filter((k) => !k.startsWith('punct')),
		['key:"name"', 'string:"web"', 'key:"private"', 'literal:true']
	);
});

test('env and yaml keys, shell comments only after whitespace', () => {
	assert.deepEqual(kinds(tokenize('DATABASE_URL="postgres://x" # db', 'dotenv')[0]), [
		'key:DATABASE_URL',
		'punct:=',
		'string:"postgres://x"',
		'comment:# db'
	]);
	assert.deepEqual(kinds(tokenize('  image: nginx:1.27', 'yaml')[0]).slice(0, 1), ['key:image']);
	assert.ok(!kinds(tokenize('echo a#b', 'shell')[0]).some((k) => k.startsWith('comment')));
});

test('markup is never interpreted, only labelled', () => {
	const [line] = tokenize('<script>alert(1)</script>', 'html');
	assert.deepEqual(kinds(line), ['tag:<script>', 'tag:</script>']);
	assert.equal(line.map((t) => t.text).join(''), '<script>alert(1)</script>');
});
