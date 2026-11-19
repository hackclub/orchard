<script lang="ts" module>
	export interface TableColumn<T = unknown> {
		id: string;
		label?: string;
		width?: string;
		align?: 'start' | 'end';
		numeric?: boolean;
		sortable?: boolean;
		sortValue?: (item: T) => string | number | null | undefined;
	}

	export interface TableSort {
		id: string;
		dir: 'asc' | 'desc';
	}
</script>

<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { ChevronUp } from 'lucide-svelte';

	let {
		columns,
		rows,
		cell = undefined,
		row = undefined,
		rowKey = (_item: T, i: number) => i,
		rowHref = undefined,
		onRowClick = undefined,
		rowActive = undefined,
		rowLabel = undefined,
		rowSelected = undefined,
		onRowContextMenu = undefined,
		sort = $bindable(null),
		onsort = undefined,
		empty = undefined,
		emptyText = 'Nothing here yet',
		maxHeight = undefined,
		dense = false,
		compact = false,
		inset = true,
		label = undefined
	}: {
		columns: TableColumn<T>[];
		rows: T[];
		cell?: Snippet<[T, TableColumn<T>, number]>;
		row?: Snippet<[T, number]>;
		rowKey?: (item: T, i: number) => unknown;
		rowHref?: (item: T) => string;
		onRowClick?: (item: T) => void;
		rowActive?: (item: T) => boolean;
		rowLabel?: (item: T) => string;
		rowSelected?: (item: T) => boolean;
		onRowContextMenu?: (item: T, event: MouseEvent) => void;
		sort?: TableSort | null;
		onsort?: (sort: TableSort | null) => void;
		empty?: Snippet;
		emptyText?: string;
		maxHeight?: string;
		dense?: boolean;
		compact?: boolean;
		inset?: boolean;
		label?: string;
	} = $props();

	const template = $derived(
		columns.map((c) => c.width ?? (c.numeric ? 'max-content' : 'minmax(0, 1fr)')).join(' ')
	);
	const hasLabels = $derived(columns.some((c) => c.label));
	const interactive = $derived(!!rowHref || !!onRowClick);
	const isActive = (item: T) => interactive && (rowActive?.(item) ?? true);

	function valueOf(item: T, col: TableColumn<T>) {
		if (col.sortValue) return col.sortValue(item);
		return (item as Record<string, unknown>)[col.id] as string | number | null | undefined;
	}

	const sorted = $derived.by(() => {
		if (!sort || onsort) return rows;
		const col = columns.find((c) => c.id === sort?.id);
		if (!col) return rows;
		const dir = sort.dir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const x = valueOf(a, col);
			const y = valueOf(b, col);
			if (x == null && y == null) return 0;
			if (x == null) return 1;
			if (y == null) return -1;
			if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
			return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
		});
	});

	function toggle(col: TableColumn<T>) {
		const next: TableSort | null =
			sort?.id !== col.id
				? { id: col.id, dir: col.numeric ? 'desc' : 'asc' }
				: sort.dir === (col.numeric ? 'desc' : 'asc')
					? { id: col.id, dir: col.numeric ? 'asc' : 'desc' }
					: null;
		sort = next;
		onsort?.(next);
	}

	function ariaSort(col: TableColumn<T>) {
		if (!col.sortable) return undefined;
		if (sort?.id !== col.id) return 'none' as const;
		return sort.dir === 'asc' ? ('ascending' as const) : ('descending' as const);
	}
</script>

<div
	class="frame"
	class:frame--inset={inset}
	class:frame--dense={dense}
	class:frame--compact={compact}
	class:frame--scroll={!!maxHeight}
	style:max-height={maxHeight}
>
	<table class="tbl" style:grid-template-columns={template} aria-label={label}>
		{#if hasLabels}
			<thead class="thead">
				<tr class="tr tr--head">
					{#each columns as col (col.id)}
						<th
							class="th"
							class:cell--end={col.align === 'end' || col.numeric}
							scope="col"
							aria-sort={ariaSort(col)}
						>
							{#if col.sortable}
								<button
									type="button"
									class="sorter"
									class:sorter--on={sort?.id === col.id}
									onclick={() => toggle(col)}
								>
									<span class="th-label">{col.label ?? ''}</span>
									<span
										class="chev"
										class:chev--desc={sort?.id === col.id && sort.dir === 'desc'}
										aria-hidden="true"><ChevronUp size={12} strokeWidth={2.5} /></span
									>
								</button>
							{:else}
								<span class="th-label">{col.label ?? ''}</span>
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
		{/if}
		<tbody class="tbody">
			{#each sorted as item, i (rowKey(item, i))}
				<tr
					class="tr"
					class:tr--interactive={isActive(item)}
					class:tr--selected={rowSelected?.(item) ?? false}
					aria-selected={rowSelected ? rowSelected(item) : undefined}
					oncontextmenu={onRowContextMenu ? (e) => onRowContextMenu(item, e) : undefined}
				>
					{#if row}
						{@render row(item, i)}
					{:else}
						{#each columns as col, c (col.id)}
							<td class="td" class:cell--end={col.align === 'end'} class:cell--num={col.numeric}>
								{#if c === 0 && rowHref && isActive(item)}
									<a class="hit" href={rowHref(item)} aria-label={rowLabel?.(item)}></a>
								{:else if c === 0 && onRowClick && isActive(item)}
									<button
										type="button"
										class="hit"
										aria-label={rowLabel?.(item) ?? 'Open row'}
										onclick={() => onRowClick(item)}
									></button>
								{/if}
								{#if cell}
									{@render cell(item, col, i)}
								{:else}
									<span class="text">{valueOf(item, col) ?? ''}</span>
								{/if}
							</td>
						{/each}
					{/if}
				</tr>
			{:else}
				<tr class="tr tr--empty">
					<td class="td td--empty" colspan={columns.length}>
						{#if empty}{@render empty()}{:else}<span class="empty-text">{emptyText}</span>{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.frame {
		--row-h: 2.75rem;
		--pad-x: 1rem;
		--hover-inset: 0.375rem;
		position: relative;
		min-width: 0;
		overflow-x: auto;
	}
	.frame--dense {
		--row-h: 2.25rem;
	}
	.frame--compact {
		--pad-x: 0.75rem;
		--cell-x: 0.375rem;
	}
	.frame--inset {
		border-radius: calc(var(--section-r, var(--radius-card)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow-x: auto;
		overflow-y: clip;
	}
	.frame--scroll {
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.tbl {
		display: grid;
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-body);
		line-height: var(--lh-body);
	}
	.thead,
	.tbody {
		display: contents;
	}
	.tr {
		position: relative;
		isolation: isolate;
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		min-height: var(--row-h);
	}
	.tr--head {
		position: sticky;
		top: 0;
		z-index: 2;
		min-height: 2.25rem;
		background: color-mix(in oklab, var(--bg-surface) 92%, transparent);
		backdrop-filter: blur(12px) saturate(1.4);
	}
	.tr--head::after {
		content: '';
		position: absolute;
		right: var(--pad-x);
		bottom: 0;
		left: var(--pad-x);
		height: 1px;
		background: var(--border-default);
		pointer-events: none;
	}
	.frame--inset .tr--head {
		min-height: calc(var(--pad-x) * 2 + 1cap);
		font-size: var(--text-caption);
	}
	.frame:not(.frame--inset) .tr--head {
		background: var(--bg-sheet);
		backdrop-filter: none;
	}
	.tbody .tr:not(:first-child)::before {
		content: '';
		position: absolute;
		top: 0;
		left: var(--pad-x);
		right: var(--pad-x);
		height: 1px;
		background: var(--border-default);
		transition: opacity var(--dur-fast) ease;
		pointer-events: none;
	}
	.tr--interactive::after {
		content: '';
		position: absolute;
		inset: 0.125rem var(--hover-inset);
		z-index: -1;
		border-radius: calc(var(--section-r, var(--radius-card)) - var(--hover-inset));
		background: var(--bg-hover);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
		pointer-events: none;
	}
	.tr--interactive:hover::after,
	.tr--interactive:has(.hit:focus-visible)::after {
		opacity: 1;
	}
	.tr--selected::after,
	.tr--selected.tr--interactive:hover::after {
		opacity: 1;
		background: var(--bg-active);
	}
	.tr--selected::before,
	.tr--selected + .tr::before {
		opacity: 0;
	}
	.tr--interactive:active::after {
		background: var(--bg-active);
	}
	.tr--interactive:hover::before,
	.tr--interactive:hover + .tr::before,
	.tr--interactive:has(.hit:focus-visible)::before,
	.tr--interactive:has(.hit:focus-visible) + .tr::before {
		opacity: 0;
	}
	.th,
	.td {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		height: 100%;
		padding: 0 var(--cell-x, 0.75rem);
		text-align: start;
	}
	.th:first-child,
	.td:first-child {
		padding-left: var(--pad-x);
	}
	.th:last-child,
	.td:last-child {
		padding-right: var(--pad-x);
	}
	.td :global(:is(a, button, input, [role='button']):not(.hit)) {
		position: relative;
		z-index: 1;
	}
	.cell--end {
		justify-content: flex-end;
		text-align: end;
	}
	.cell--num {
		justify-content: flex-end;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.th {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.th-label {
		display: block;
		text-box: trim-both cap alphabetic;
	}
	.sorter {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.5rem;
		margin: 0 -0.5rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.cell--end .sorter {
		flex-direction: row-reverse;
	}
	.sorter:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}
	.sorter--on {
		color: var(--text-default);
	}
	.chev {
		display: flex;
		color: var(--text-faint);
		opacity: 0;
		transition:
			opacity var(--dur-fast) ease,
			transform var(--spring-glide-duration) var(--spring-glide);
	}
	.sorter:hover .chev {
		opacity: 1;
	}
	.sorter--on .chev {
		color: var(--text-muted);
		opacity: 1;
	}
	.chev--desc {
		transform: rotate(180deg);
	}
	.text {
		display: block;
		min-width: 0;
		overflow: hidden;
		padding-block: 0.3em;
		margin-block: -0.3em;
		color: var(--text-default);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.hit {
		position: absolute;
		inset: 0;
		z-index: 0;
		padding: 0;
		border: none;
		border-radius: 0;
		background: none;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: none;
	}
	.tr--empty {
		min-height: 7rem;
	}
	.td--empty {
		grid-column: 1 / -1;
		justify-content: center;
	}
	.empty-text {
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
	:global(html.reduce-transparency) .tr--head {
		background: var(--bg-surface);
	}
</style>
