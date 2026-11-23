<script lang="ts">
	import CopyButton from './CopyButton.svelte';
	import { tokenize, type SyntaxLanguage } from '$lib/utils/syntax';

	let {
		code,
		language = undefined,
		title = undefined,
		lineNumbers = false,
		highlight = [],
		wrap = false,
		maxHeight = undefined,
		syntax = null,
		fill = false,
		class: className = ''
	}: {
		code: string;
		language?: string;
		title?: string;
		lineNumbers?: boolean;
		highlight?: number[];
		wrap?: boolean;
		maxHeight?: string;
		syntax?: SyntaxLanguage | null;
		fill?: boolean;
		class?: string;
	} = $props();

	const lines = $derived(tokenize(code, syntax));
	const marked = $derived(new Set(highlight));
	const gutter = $derived(String(lines.length).length);
	const heading = $derived(title ?? language);
</script>

<figure
	class="code {className}"
	class:code--fill={fill}
	class:code--wrap={wrap}
	class:code--headless={!heading}
>
	{#if heading}
		<figcaption class="bar">
			<span class="name" class:name--mono={!!title}>{heading}</span>
			{#if title && language}<span class="lang">{language}</span>{/if}
			<span class="copy"><CopyButton value={code} label="Copy code" /></span>
		</figcaption>
	{:else}
		<span class="copy copy--float"><CopyButton value={code} label="Copy code" /></span>
	{/if}
	<div class="scroll" style:max-height={maxHeight}>
		<pre class="pre" style:--gutter="{gutter}ch"><code class="lines"
				>{#each lines as line, i (i)}<span class="line" class:line--marked={marked.has(i + 1)}
						>{#if lineNumbers}<span class="no" aria-hidden="true">{i + 1}</span>{/if}<span
							class="src"
							>{#each line as token, t (t)}{#if token.kind}<span class="tk tk--{token.kind}"
										>{token.text}</span
									>{:else}{token.text}{/if}{:else}{' '}{/each}</span
						></span
					>{/each}</code
			></pre>
	</div>
</figure>

<style>
	.code {
		position: relative;
		min-width: 0;
		margin: 0;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		box-shadow: inset 0 0 0 1px var(--console-edge);
		overflow: clip;
	}
	.code--fill {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.code--fill .scroll {
		flex: 1;
		min-height: 0;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		padding: 0 0.25rem 0 0.875rem;
		box-shadow: inset 0 -1px 0 var(--console-edge);
	}
	.name {
		display: block;
		min-width: 0;
		overflow-x: clip;
		padding-block: 0.3em;
		margin-block: -0.3em;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
	.name--mono {
		font-family: var(--font-mono);
		font-weight: var(--weight-regular);
		color: var(--text-default);
	}
	.lang {
		display: block;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		text-box: trim-both cap alphabetic;
	}
	.copy {
		display: flex;
		margin-left: auto;
	}
	.copy--float {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		z-index: 1;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--console-bg);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.code:hover .copy--float,
	.copy--float:focus-within {
		opacity: 1;
	}
	.scroll {
		overflow: auto;
		overscroll-behavior: contain;
	}
	.pre {
		margin: 0;
		padding: 0.75rem 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.25rem;
		color: var(--console-text);
		tab-size: 2;
	}
	.code--headless .pre {
		padding-right: 2.25rem;
	}
	.lines {
		display: grid;
		min-width: max-content;
		font: inherit;
	}
	.code--wrap .lines {
		min-width: 0;
	}
	.line {
		display: flex;
		padding: 0 1rem 0 0.875rem;
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
	.line--marked {
		background: color-mix(in oklab, var(--accent-7) 10%, transparent);
	}
	.no {
		flex-shrink: 0;
		width: var(--gutter);
		margin-right: 1.25rem;
		color: var(--text-faint);
		text-align: right;
		font-variant-numeric: tabular-nums;
		user-select: none;
	}
	.line--marked .no {
		color: var(--accent-9);
	}
	.src {
		white-space: pre;
	}
	.code--wrap .src {
		min-width: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
