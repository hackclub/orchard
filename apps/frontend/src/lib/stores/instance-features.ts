import { derived, writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { apiFetch } from './api';

export interface InstanceFeatures {
	mcp: boolean;
	sandboxes: boolean;
	earlyAccessOpen: boolean;
	fastBuilder: boolean;
	email: boolean;
	superBuilds: boolean;
	resourceLimits: 'on' | 'off';
	fastBuilderRouting: 'all' | 'per_app' | 'off' | 'flag';
	devices: { resource: string; label: string; max: number }[];
	storage: {
		s3: boolean;
		backups: 'external' | 'local' | 'none';
		uploads: boolean;
		localDeploys: boolean;
	};
}

const STORAGE_DEFAULT: InstanceFeatures['storage'] = {
	s3: true,
	backups: 'external',
	uploads: true,
	localDeploys: true
};

const features = writable<InstanceFeatures>({
	mcp: true,
	sandboxes: false,
	earlyAccessOpen: false,
	fastBuilder: false,
	email: true,
	superBuilds: false,
	resourceLimits: 'on',
	fastBuilderRouting: 'flag',
	devices: [],
	storage: STORAGE_DEFAULT
});
let loaded = false;

export const instanceFeatures = {
	subscribe: features.subscribe,
	async load(force = false) {
		if (loaded && !force) return get(features);
		const response = await apiFetch('/apiv1/instance/features');
		if (!response.ok) return get(features);
		loaded = true;
		const next = {
			mcp: true,
			sandboxes: false,
			earlyAccessOpen: false,
			fastBuilder: false,
			email: true,
			superBuilds: false,
			resourceLimits: 'on' as const,
			fastBuilderRouting: 'flag' as const,
			devices: [],
			storage: STORAGE_DEFAULT,
			...((await response.json()) as Partial<InstanceFeatures>)
		};
		features.set(next);
		return next;
	}
};

function loadedOnUse<T>(store: Readable<T>): Readable<T> {
	return {
		subscribe(run, invalidate) {
			if (browser) instanceFeatures.load().catch(() => undefined);
			return store.subscribe(run, invalidate);
		}
	};
}

export const uploadsEnabled = loadedOnUse(
	derived(features, ($features) => $features.storage.uploads)
);

export const emailEnabled = loadedOnUse(derived(features, ($features) => $features.email));

export const backupsOnThisServer = loadedOnUse(
	derived(features, ($features) => $features.storage.backups === 'local')
);
