import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneStalePins, type PinnedItem } from './pinned-items';

const pin = (item: Partial<PinnedItem> & Pick<PinnedItem, 'id' | 'type'>): PinnedItem => ({
	name: item.id,
	href: `/orchard-demo/deployments/${item.id}`,
	...item
});

const ids = (items: PinnedItem[]) => items.map((i) => i.id);

test('pins for deployments that still exist are kept', () => {
	const items = [pin({ id: 'dep-1', type: 'deployment' })];
	assert.deepEqual(ids(pruneStalePins(items, 'orchard-demo', ['dep-1'], [])), ['dep-1']);
});

test('a pin for a deleted deployment is dropped', () => {
	const items = [
		pin({ id: 'dep-1', type: 'deployment' }),
		pin({ id: 'dep-2', type: 'deployment' })
	];
	assert.deepEqual(ids(pruneStalePins(items, 'orchard-demo', ['dep-1'], [])), ['dep-1']);
});

test('a pin for a deleted project is dropped', () => {
	const items = [
		pin({ id: 'proj-1', type: 'project', href: '/orchard-demo/projects/one' }),
		pin({ id: 'proj-2', type: 'project', href: '/orchard-demo/projects/two' })
	];
	assert.deepEqual(ids(pruneStalePins(items, 'orchard-demo', [], ['proj-1'])), ['proj-1']);
});

test('pins belonging to another organization are left alone', () => {
	const items = [
		pin({ id: 'dep-1', type: 'deployment', href: '/other-org/deployments/dep-1' }),
		pin({ id: 'proj-1', type: 'project', href: '/other-org/projects/one' })
	];
	assert.deepEqual(ids(pruneStalePins(items, 'orchard-demo', [], [])), ['dep-1', 'proj-1']);
});

test('a pin with a type the sidebar does not know is left alone', () => {
	const items = [
		pin({ id: 'odd-1', type: 'widget' as PinnedItem['type'], href: '/orchard-demo/widgets/odd-1' })
	];
	assert.deepEqual(ids(pruneStalePins(items, 'orchard-demo', [], [])), ['odd-1']);
});

test('without an organization slug nothing is pruned', () => {
	const items = [pin({ id: 'dep-1', type: 'deployment' })];
	assert.deepEqual(ids(pruneStalePins(items, '', [], [])), ['dep-1']);
});
