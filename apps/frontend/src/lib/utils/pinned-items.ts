export interface PinnedItem {
	id: string;
	name: string;
	type: 'project' | 'deployment';
	href: string;
}

export function pruneStalePins(
	items: PinnedItem[],
	orgSlug: string,
	deploymentIds: Iterable<string>,
	projectIds: Iterable<string>
): PinnedItem[] {
	if (!orgSlug) return items;
	const deployments = new Set(deploymentIds);
	const projects = new Set(projectIds);
	const prefix = `/${orgSlug}/`;
	return items.filter((item) => {
		if (!item.href.startsWith(prefix)) return true;
		if (item.type === 'deployment') return deployments.has(item.id);
		if (item.type === 'project') return projects.has(item.id);
		return true;
	});
}
