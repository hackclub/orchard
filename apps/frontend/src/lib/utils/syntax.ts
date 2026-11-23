export type SyntaxLanguage =
	| 'javascript'
	| 'typescript'
	| 'json'
	| 'yaml'
	| 'toml'
	| 'shell'
	| 'python'
	| 'ruby'
	| 'go'
	| 'rust'
	| 'css'
	| 'html'
	| 'markdown'
	| 'sql'
	| 'dotenv'
	| 'dockerfile'
	| 'prisma';

export type TokenKind =
	| 'comment'
	| 'string'
	| 'number'
	| 'keyword'
	| 'literal'
	| 'key'
	| 'tag'
	| 'heading'
	| 'punct';

export interface Token {
	kind: TokenKind | null;
	text: string;
}

interface Grammar {
	line?: string[];
	block?: [string, string];
	quotes: string[];
	multiline?: string[];
	keywords?: Set<string>;
	literals?: Set<string>;
	caseInsensitive?: boolean;
	keyBeforeColon?: boolean;
	keyBeforeEquals?: boolean;
	keyBeforeQuoteColon?: boolean;
	headerLine?: RegExp;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words(`
	break case catch class const continue debugger default delete do else export extends finally
	for from function if import in instanceof let new of return static super switch this throw try
	typeof var void while with yield async await as`);
const TS_KEYWORDS = new Set([
	...JS_KEYWORDS,
	...words(`type interface enum implements private protected public readonly declare namespace
	abstract keyof satisfies infer is`)
]);
const LITERALS = words('true false null undefined NaN Infinity');

const GRAMMARS: Record<SyntaxLanguage, Grammar> = {
	javascript: {
		line: ['//'],
		block: ['/*', '*/'],
		quotes: ['"', "'", '`'],
		multiline: ['`'],
		keywords: JS_KEYWORDS,
		literals: LITERALS
	},
	typescript: {
		line: ['//'],
		block: ['/*', '*/'],
		quotes: ['"', "'", '`'],
		multiline: ['`'],
		keywords: TS_KEYWORDS,
		literals: LITERALS
	},
	json: { quotes: ['"'], literals: words('true false null'), keyBeforeQuoteColon: true },
	yaml: {
		line: ['#'],
		quotes: ['"', "'"],
		literals: words('true false null yes no on off ~'),
		keyBeforeColon: true
	},
	toml: {
		line: ['#', ';'],
		quotes: ['"', "'"],
		literals: words('true false'),
		keyBeforeEquals: true,
		headerLine: /^\s*\[.*\]\s*$/
	},
	shell: {
		line: ['#'],
		quotes: ['"', "'"],
		keywords: words(`if then else elif fi for while until do done case esac in function return
			export local set unset echo exit source alias cd readonly shift trap exec`)
	},
	python: {
		line: ['#'],
		quotes: ['"', "'"],
		keywords: words(`and as assert async await break class continue def del elif else except
			finally for from global if import in is lambda nonlocal not or pass raise return try while
			with yield self`),
		literals: words('True False None')
	},
	ruby: {
		line: ['#'],
		quotes: ['"', "'"],
		keywords: words(`alias and begin break case class def defined do else elsif end ensure for if
			in module next not or redo rescue retry return self super then undef unless until when
			while yield require attr_accessor attr_reader`),
		literals: words('true false nil')
	},
	go: {
		line: ['//'],
		block: ['/*', '*/'],
		quotes: ['"', "'", '`'],
		multiline: ['`'],
		keywords: words(`break case chan const continue default defer else fallthrough for func go goto
			if import interface map package range return select struct switch type var`),
		literals: words('true false nil iota')
	},
	rust: {
		line: ['//'],
		block: ['/*', '*/'],
		quotes: ['"'],
		keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl
			in let loop match mod move mut pub ref return self Self static struct super trait type
			unsafe use where while`),
		literals: words('true false None Some Ok Err')
	},
	css: {
		block: ['/*', '*/'],
		quotes: ['"', "'"],
		keywords: words('@media @import @supports @keyframes @font-face @layer !important'),
		keyBeforeColon: true
	},
	html: { block: ['<!--', '-->'], quotes: ['"', "'"] },
	markdown: { quotes: ['`'], headerLine: /^\s{0,3}#{1,6}\s/ },
	sql: {
		line: ['--'],
		block: ['/*', '*/'],
		quotes: ["'", '"'],
		caseInsensitive: true,
		keywords: words(`select from where insert into values update set delete create table index
			drop alter add column primary key foreign references not null unique default and or join
			left right inner outer on group by order having limit offset as distinct returning begin
			commit rollback if exists`),
		literals: words('true false null')
	},
	dotenv: { line: ['#'], quotes: ['"', "'"], keyBeforeEquals: true },
	dockerfile: {
		line: ['#'],
		quotes: ['"', "'"],
		caseInsensitive: true,
		keywords: words(`from run cmd label expose env add copy entrypoint volume user workdir arg
			onbuild stopsignal healthcheck shell as`)
	},
	prisma: {
		line: ['//'],
		quotes: ['"'],
		keywords: words('model enum datasource generator type view'),
		literals: words('true false')
	}
};

export interface SyntaxState {
	block: boolean;
	quote: string | null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const CSS_IDENT = /[@!]?[A-Za-z_-][\w-]*/y;
const NUMBER = /(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/y;

function push(out: Token[], kind: TokenKind | null, text: string) {
	if (!text) return;
	const last = out[out.length - 1];
	if (last && last.kind === kind) last.text += text;
	else out.push({ kind, text });
}

function startsAt(line: string, i: number, list: string[] | undefined): string | null {
	if (!list) return null;
	for (const s of list) if (line.startsWith(s, i)) return s;
	return null;
}

function readString(line: string, i: number, quote: string): { end: number; closed: boolean } {
	let j = i;
	while (j < line.length) {
		const c = line[j];
		if (c === '\\' && quote !== "'") {
			j += 2;
			continue;
		}
		if (c === quote) return { end: j + 1, closed: true };
		j += 1;
	}
	return { end: line.length, closed: false };
}

function tokenizeHtmlLine(line: string, state: SyntaxState): Token[] {
	const out: Token[] = [];
	let i = 0;
	if (state.block) {
		const end = line.indexOf('-->');
		if (end === -1) return [{ kind: 'comment', text: line }];
		push(out, 'comment', line.slice(0, end + 3));
		state.block = false;
		i = end + 3;
	}
	while (i < line.length) {
		if (line.startsWith('<!--', i)) {
			const end = line.indexOf('-->', i + 4);
			if (end === -1) {
				push(out, 'comment', line.slice(i));
				state.block = true;
				return out;
			}
			push(out, 'comment', line.slice(i, end + 3));
			i = end + 3;
			continue;
		}
		const tag = /<\/?[A-Za-z][\w:-]*/y;
		tag.lastIndex = i;
		const m = tag.exec(line);
		if (m) {
			push(out, 'tag', m[0]);
			i += m[0].length;
			while (i < line.length && line[i] !== '>') {
				const c = line[i];
				if (c === '"' || c === "'") {
					const { end } = readString(line, i + 1, c);
					push(out, 'string', line.slice(i, end));
					i = end;
					continue;
				}
				const attr = /[\w:@.-]+/y;
				attr.lastIndex = i;
				const a = attr.exec(line);
				if (a) {
					push(out, 'key', a[0]);
					i += a[0].length;
					continue;
				}
				push(out, null, c);
				i += 1;
			}
			if (line[i] === '>') {
				push(out, 'tag', '>');
				i += 1;
			}
			continue;
		}
		push(out, null, line[i]);
		i += 1;
	}
	return out;
}

export function tokenizeLine(line: string, language: SyntaxLanguage, state: SyntaxState): Token[] {
	if (language === 'html') return tokenizeHtmlLine(line, state);
	const g = GRAMMARS[language];
	const out: Token[] = [];
	let i = 0;
	if (g.headerLine?.test(line))
		return [{ kind: language === 'markdown' ? 'heading' : 'tag', text: line }];
	if (language === 'markdown') {
		while (i < line.length) {
			if (line[i] === '`') {
				const end = line.indexOf('`', i + 1);
				const stop = end === -1 ? line.length : end + 1;
				push(out, 'string', line.slice(i, stop));
				i = stop;
				continue;
			}
			push(out, null, line[i]);
			i += 1;
		}
		return out;
	}
	if (state.block && g.block) {
		const end = line.indexOf(g.block[1]);
		if (end === -1) return [{ kind: 'comment', text: line }];
		push(out, 'comment', line.slice(0, end + g.block[1].length));
		state.block = false;
		i = end + g.block[1].length;
	}
	if (state.quote) {
		const { end, closed } = readString(line, 0, state.quote);
		push(out, 'string', line.slice(0, end));
		if (!closed) return out;
		state.quote = null;
		i = end;
	}
	let lineStart = true;
	while (i < line.length) {
		const c = line[i];
		if (g.block && line.startsWith(g.block[0], i)) {
			const end = line.indexOf(g.block[1], i + g.block[0].length);
			if (end === -1) {
				push(out, 'comment', line.slice(i));
				state.block = true;
				return out;
			}
			push(out, 'comment', line.slice(i, end + g.block[1].length));
			i = end + g.block[1].length;
			continue;
		}
		const lineComment = startsAt(line, i, g.line);
		if (lineComment && (lineComment !== '#' || i === 0 || /\s/.test(line[i - 1]))) {
			push(out, 'comment', line.slice(i));
			return out;
		}
		if (g.quotes.includes(c)) {
			const { end, closed } = readString(line, i + 1, c);
			const text = line.slice(i, end);
			const isKey =
				g.keyBeforeQuoteColon && closed && /^\s*:/.test(line.slice(end)) ? 'key' : 'string';
			push(out, isKey, text);
			if (!closed && g.multiline?.includes(c)) state.quote = c;
			i = end;
			lineStart = false;
			continue;
		}
		if (lineStart && (g.keyBeforeColon || g.keyBeforeEquals)) {
			const keyRe = g.keyBeforeEquals
				? /\s*(?:export\s+)?[\w.\-[\]"']+(?=\s*=)/y
				: /\s*-?\s*[\w.\-/@$"' ]+?(?=\s*:(?:\s|$))/y;
			keyRe.lastIndex = i;
			const k = keyRe.exec(line);
			if (k) {
				const lead = k[0].match(/^[\s-]*/)?.[0] ?? '';
				push(out, null, lead);
				push(out, 'key', k[0].slice(lead.length));
				i += k[0].length;
				lineStart = false;
				continue;
			}
		}
		if (/\s/.test(c)) {
			push(out, null, c);
			i += 1;
			continue;
		}
		lineStart = false;
		NUMBER.lastIndex = i;
		const prev = line[i - 1];
		if (/\d/.test(c) && !(prev && /[\w$]/.test(prev))) {
			const n = NUMBER.exec(line);
			if (n) {
				push(out, 'number', n[0]);
				i += n[0].length;
				continue;
			}
		}
		const ident = language === 'css' ? CSS_IDENT : IDENT;
		ident.lastIndex = i;
		const id = ident.exec(line);
		if (id) {
			const word = id[0];
			const probe = g.caseInsensitive ? word.toLowerCase() : word;
			const kind = g.keywords?.has(probe) ? 'keyword' : g.literals?.has(probe) ? 'literal' : null;
			push(out, kind, word);
			i += word.length;
			continue;
		}
		push(out, /[{}()[\];,.:=<>+\-*/%!&|?^~]/.test(c) ? 'punct' : null, c);
		i += 1;
	}
	return out;
}

export function tokenize(code: string, language: SyntaxLanguage | null): Token[][] {
	const lines = code.replace(/\n$/, '').split('\n');
	if (!language) return lines.map((text) => (text ? [{ kind: null, text }] : []));
	const state: SyntaxState = { block: false, quote: null };
	return lines.map((line) => tokenizeLine(line, language, state));
}
