<script lang="ts">
	import { tokenize, type SyntaxLanguage } from '$lib/utils/syntax';

	const HIGHLIGHT_LIMIT = 200_000;

	let {
		value = $bindable(''),
		element = $bindable(null),
		syntax = null,
		label,
		readonly = false,
		minHeight = '16rem',
		onsave = undefined,
		class: className = ''
	}: {
		value?: string;
		element?: HTMLTextAreaElement | null;
		syntax?: SyntaxLanguage | null;
		label: string;
		readonly?: boolean;
		minHeight?: string;
		onsave?: () => void;
		class?: string;
	} = $props();

	let scrollTop = $state(0);
	let scrollLeft = $state(0);
	let escaped = false;

	const lines = $derived(tokenize(value, value.length <= HIGHLIGHT_LIMIT ? syntax : null));
	const numbers = $derived(
		Array.from({ length: Math.max(1, value.split('\n').length) }, (_, i) => i + 1).join('\n')
	);
	const gutter = $derived(String(lines.length).length);
	const indent = $derived(/^\t/m.test(value) ? '\t' : '  ');

	function insert(text: string) {
		if (!element) return;
		element.focus();
		if (!document.execCommand('insertText', false, text)) {
			const { selectionStart: a, selectionEnd: b } = element;
			value = value.slice(0, a) + text + value.slice(b);
			const at = a + text.length;
			queueMicrotask(() => element?.setSelectionRange(at, at));
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			onsave?.();
			return;
		}
		if (e.key === 'Escape') {
			escaped = true;
			return;
		}
		if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !escaped) {
			if (readonly) return;
			e.preventDefault();
			insert(indent);
		}
		escaped = false;
	}
</script>

<div class="ui-code-editor {className}" style:--gutter="{gutter}ch" style:min-height={minHeight}>
	<pre
		class="numbers"
		aria-hidden="true"
		style:transform="translateY({-scrollTop}px)">{numbers}</pre>
	<div class="stage">
		<pre
			class="paint"
			aria-hidden="true"
			style:transform="translate({-scrollLeft}px, {-scrollTop}px)"><code
				>{#each lines as line, i (i)}{#each line as token, t (t)}{#if token.kind}<span
								class="tk tk--{token.kind}">{token.text}</span
							>{:else}{token.text}{/if}{/each}{'\n'}{/each}</code
			></pre>
		<textarea
			bind:this={element}
			bind:value
			class="input"
			aria-label={label}
			{readonly}
			spellcheck="false"
			autocapitalize="off"
			autocomplete="off"
			wrap="off"
			{onkeydown}
			onscroll={(e) => {
				scrollTop = e.currentTarget.scrollTop;
				scrollLeft = e.currentTarget.scrollLeft;
			}}></textarea>
	</div>
</div>

<style>
	.ui-code-editor {
		--pad-y: 0.75rem;
		position: relative;
		display: flex;
		min-width: 0;
		overflow: clip;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		box-shadow: inset 0 0 0 1px var(--console-edge);
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.25rem;
		transition: box-shadow var(--dur-fast) ease;
	}
	.ui-code-editor:has(.input:focus-visible) {
		box-shadow:
			inset 0 0 0 1px var(--accent-solid),
			0 0 0 3.5px color-mix(in oklab, var(--accent-solid) 22%, transparent);
	}
	.numbers {
		flex-shrink: 0;
		box-sizing: content-box;
		width: var(--gutter);
		margin: 0;
		padding: var(--pad-y) 1.25rem var(--pad-y) 0.875rem;
		color: var(--text-faint);
		font: inherit;
		text-align: right;
		font-variant-numeric: tabular-nums;
		user-select: none;
		pointer-events: none;
	}
	.stage {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: clip;
	}
	.paint,
	.input {
		margin: 0;
		padding: var(--pad-y) 1rem var(--pad-y) 0;
		font: inherit;
		tab-size: 2;
		white-space: pre;
		letter-spacing: normal;
	}
	.paint {
		position: absolute;
		top: 0;
		left: 0;
		min-width: 100%;
		color: var(--console-text);
		pointer-events: none;
	}
	.input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: none;
		background: transparent;
		color: transparent;
		caret-color: var(--console-text);
		resize: none;
		overflow: auto;
		overscroll-behavior: contain;
	}
	.input:focus {
		outline: none;
	}
	.input::selection {
		background: color-mix(in oklab, var(--accent-7) 28%, transparent);
		color: transparent;
	}
	.tk--keyword {
		color: var(--syntax-keyword);
	}
	.tk--string {
		color: var(--syntax-string);
	}
	.tk--number {
		color: var(--syntax-number);
	}
	.tk--literal {
		color: var(--syntax-literal);
	}
	.tk--key {
		color: var(--syntax-key);
	}
	.tk--tag {
		color: var(--syntax-tag);
	}
	.tk--heading {
		color: var(--syntax-heading);
		font-weight: var(--weight-medium);
	}
	.tk--comment {
		color: var(--syntax-comment);
		font-style: italic;
	}
	.tk--punct {
		color: var(--syntax-punct);
	}
</style>
