import type { MockContext } from '../plugin.ts';
import { reply, type Router } from '../router.ts';

const ROUTINGS = ['all', 'per_app', 'off', 'flag'] as const;
type Routing = (typeof ROUTINGS)[number];

export function fastBuilderRoutes(r: Router, { store }: MockContext) {
	const fallback: Routing = 'flag';
	let available = true;
	let flagConfigured = false;

	const view = () => ({
		value: store.state.fastBuilderRouting ?? fallback,
		dbValue: store.state.fastBuilderRouting ?? null,
		fallback,
		available,
		flagConfigured
	});

	r.get('/admin/instance-settings/fast-builder', () => view());

	r.patch('/admin/instance-settings/fast-builder', ({ body }) => {
		if (!ROUTINGS.includes(body?.value))
			return reply(400, {
				message: `value must be one of ${ROUTINGS.join(', ')}`,
				statusCode: 400
			});
		store.state.fastBuilderRouting = body.value;
		return view();
	});

	r.post('/__mock/fast-builder', ({ body }) => {
		if (typeof body?.available === 'boolean') available = body.available;
		if (typeof body?.flagConfigured === 'boolean') flagConfigured = body.flagConfigured;
		return view();
	});
}
