import { apiFetch, toasts } from '$lib/stores';
import type { Service, ServiceFormState, ServicePortForm } from '$lib/types/deployment';

interface ServicesDeps {
	deploymentId: () => string;
	getServices: () => Service[];
	setDeployment: (d: unknown) => void;
	refetch: () => void;
}

function createPortRow(overrides?: Partial<ServicePortForm>): ServicePortForm {
	return {
		name: '',
		containerPort: 80,
		servicePort: 80,
		protocol: 'TCP',
		nodePort: null,
		...overrides
	};
}

function buildPortPayloadFromForm(form: ServiceFormState) {
	const payload: {
		name?: string;
		containerPort: number;
		servicePort: number;
		protocol: string;
		nodePort?: number;
	}[] = [];

	for (let index = 0; index < form.ports.length; index += 1) {
		const port = form.ports[index];
		const containerPort = Number(port.containerPort);
		const servicePort = Number(port.servicePort);

		if (!Number.isInteger(containerPort) || containerPort <= 0) {
			return { error: `Port ${index + 1}: Enter a whole number above 0 for the container port` };
		}

		if (!Number.isInteger(servicePort) || servicePort <= 0) {
			return { error: `Port ${index + 1}: Enter a whole number above 0 for the exposed port` };
		}

		const protocol =
			typeof port.protocol === 'string' && port.protocol.trim().length > 0
				? port.protocol.trim().toUpperCase()
				: 'TCP';

		const nodePortValue =
			port.nodePort === undefined || port.nodePort === null ? undefined : Number(port.nodePort);

		const nodePort =
			nodePortValue !== undefined && Number.isInteger(nodePortValue) && nodePortValue > 0
				? nodePortValue
				: undefined;

		payload.push({
			name: port.name?.trim() || undefined,
			containerPort,
			servicePort,
			protocol,
			nodePort
		});
	}

	if (payload.length === 0) {
		return { error: 'Add at least one valid port' };
	}

	return { payload };
}

export class ServicesController {
	showForm = $state(false);

	newForm = $state<ServiceFormState>({
		name: '',
		exposePublic: false,
		ports: [createPortRow()]
	});

	formError = $state<string | null>(null);

	editForms = $state<Record<string, ServiceFormState>>({});

	editErrors = $state<Record<string, string | null>>({});

	creating = $state(false);

	savingId = $state<string | null>(null);

	deletingId = $state<string | null>(null);

	portPublicBusyId = $state<string | null>(null);

	isEditing = $state(false);

	copiedUrlId = $state<string | null>(null);

	#deps: ServicesDeps;

	constructor(deps: ServicesDeps) {
		this.#deps = deps;
	}

	resetNewForm() {
		this.newForm = {
			name: '',
			exposePublic: false,
			ports: [createPortRow()]
		};
		this.formError = null;
	}

	updateNewPort(index: number, changes: Partial<ServicePortForm>) {
		this.newForm = {
			...this.newForm,
			ports: this.newForm.ports.map((port, idx) => (idx === index ? { ...port, ...changes } : port))
		};
	}

	mapServiceToForm(service: Service): ServiceFormState {
		const sourcePorts =
			service.ports && service.ports.length > 0
				? service.ports
				: [
						{
							name: service.name,
							port: service.port,
							targetPort: service.targetPort,
							protocol: service.protocol,
							nodePort: service.nodePort ?? null
						}
					];

		return {
			name: service.name,
			exposePublic: service.type === 'external',
			ports: sourcePorts.map((entry) =>
				createPortRow({
					name: entry.name ?? '',
					containerPort: entry.targetPort,
					servicePort: entry.port,
					protocol: entry.protocol ?? 'TCP',
					nodePort: entry.nodePort ?? null
				})
			)
		};
	}

	toggleEdit(service: Service) {
		if (this.editForms[service.id]) {
			const { [service.id]: _removedForm, ...restForms } = this.editForms;
			this.editForms = restForms;
			const { [service.id]: _removedError, ...restErrors } = this.editErrors;
			this.editErrors = restErrors;
			if (Object.keys(this.editForms).length === 0 && !this.showForm) {
				this.isEditing = false;
			}
			return;
		}

		this.isEditing = true;
		this.editForms = {
			...this.editForms,
			[service.id]: this.mapServiceToForm(service)
		};
		this.editErrors = {
			...this.editErrors,
			[service.id]: null
		};
	}

	async copyInternalUrl(url: string | undefined, serviceId: string) {
		if (!url) {
			toasts.add({
				title: "Couldn't copy the internal URL",
				description: 'This port has no internal URL.',
				color: 'error'
			});
			return;
		}

		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				const textArea = document.createElement('textarea');
				textArea.value = url;
				textArea.style.position = 'fixed';
				textArea.style.left = '-999999px';
				textArea.style.top = '-999999px';
				document.body.appendChild(textArea);
				textArea.focus();
				textArea.select();
				const successful = document.execCommand('copy');
				document.body.removeChild(textArea);
				if (!successful) {
					throw new Error('execCommand failed');
				}
			}
			this.copiedUrlId = serviceId;
			setTimeout(() => {
				this.copiedUrlId = null;
			}, 2000);
			toasts.add({
				title: 'Copied',
				description: 'Internal URL copied',
				color: 'success'
			});
		} catch (error) {
			console.error("Couldn't copy:", error);
			toasts.add({
				title: 'Select the URL and copy it yourself.',
				description: 'Select the URL and copy it yourself.',
				color: 'error'
			});
		}
	}

	updateEditPort(serviceId: string, index: number, changes: Partial<ServicePortForm>) {
		const form = this.editForms[serviceId];
		if (!form) return;

		this.editForms = {
			...this.editForms,
			[serviceId]: {
				...form,
				ports: form.ports.map((port, idx) => (idx === index ? { ...port, ...changes } : port))
			}
		};
	}

	async create() {
		const { payload, error } = buildPortPayloadFromForm(this.newForm);
		if (error) {
			this.formError = error;
			return;
		}

		const firstPort = this.newForm.ports[0]?.containerPort ?? 80;
		const existingNames = new Set(this.#deps.getServices().map((s) => s.name));
		let serviceName = `port-${firstPort}`;
		let suffix = 2;
		while (existingNames.has(serviceName)) {
			serviceName = `port-${firstPort}-${suffix}`;
			suffix++;
		}

		this.formError = null;
		this.creating = true;

		try {
			const response = await apiFetch(`/apiv1/deployments/${this.#deps.deploymentId()}/services`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: serviceName,
					ports: payload,
					exposePublic: this.newForm.exposePublic
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't add port");
			}

			const updated = await response.json();
			this.#deps.setDeployment(updated);

			toasts.add({
				title: 'Port added',
				description: `Port ${this.newForm.ports[0]?.containerPort ?? ''} is now routing traffic`,
				color: 'success'
			});

			this.showForm = false;
			this.resetNewForm();
			if (Object.keys(this.editForms).length === 0) {
				this.isEditing = false;
			}
		} catch (e) {
			this.formError = e instanceof Error ? e.message : "Couldn't add port";
		} finally {
			this.creating = false;
		}
	}

	async togglePortPublic(
		serviceId: string,
		portId: string,
		currentlyEnabled: boolean,
		preserveClientIp?: boolean
	) {
		this.portPublicBusyId = portId;
		try {
			const method = currentlyEnabled ? 'DELETE' : 'POST';
			const withBody = method === 'POST' && preserveClientIp !== undefined;
			const response = await apiFetch(
				`/apiv1/deployments/${this.#deps.deploymentId()}/services/${serviceId}/ports/${portId}/public`,
				withBody
					? {
							method,
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ preserveClientIp })
						}
					: { method }
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't change public access");
			}
			const res = await response.json();
			await this.#deps.refetch();
			toasts.add({
				title: currentlyEnabled
					? 'Port is private'
					: withBody && res?.preserveClientIp
						? 'Port keeps client addresses'
						: 'Port is public',
				description:
					!currentlyEnabled && res?.host && res?.port
						? `Address ${res.host}:${res.port}`
						: undefined,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't change public access",
				description: e instanceof Error ? e.message : 'Try again.',
				color: 'error'
			});
		} finally {
			this.portPublicBusyId = null;
		}
	}

	async savePorts(serviceId: string) {
		const form = this.editForms[serviceId];
		if (!form) {
			return;
		}

		const { payload, error } = buildPortPayloadFromForm(form);
		if (error) {
			this.editErrors = { ...this.editErrors, [serviceId]: error };
			return;
		}

		this.editErrors = { ...this.editErrors, [serviceId]: null };
		this.savingId = serviceId;

		try {
			const response = await apiFetch(
				`/apiv1/deployments/${this.#deps.deploymentId()}/services/${serviceId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ports: payload })
				}
			);

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't update port");
			}

			const updated = await response.json();
			this.#deps.setDeployment(updated);

			const { [serviceId]: _removedForm, ...restForms } = this.editForms;
			this.editForms = restForms;
			const { [serviceId]: _removedError, ...restErrors } = this.editErrors;
			this.editErrors = restErrors;

			if (Object.keys(this.editForms).length === 0 && !this.showForm) {
				this.isEditing = false;
			}

			toasts.add({
				title: 'Port updated',

				color: 'success'
			});
		} catch (e) {
			this.editErrors = {
				...this.editErrors,
				[serviceId]: e instanceof Error ? e.message : "Couldn't update port"
			};
		} finally {
			this.savingId = null;
		}
	}

	async delete(serviceId: string) {
		if (this.deletingId) return;
		this.deletingId = serviceId;

		try {
			const response = await apiFetch(
				`/apiv1/deployments/${this.#deps.deploymentId()}/services/${serviceId}`,
				{
					method: 'DELETE'
				}
			);

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't remove port");
			}

			const updated = await response.json();
			this.#deps.setDeployment(updated);

			toasts.add({
				title: 'Port removed',
				color: 'success'
			});

			const { [serviceId]: _removedForm, ...restForms } = this.editForms;
			this.editForms = restForms;
			const { [serviceId]: _removedError, ...restErrors } = this.editErrors;
			this.editErrors = restErrors;
		} catch (e) {
			toasts.add({
				title: "Couldn't remove port",
				description: e instanceof Error ? e.message : "Couldn't remove port",
				color: 'error'
			});
		} finally {
			this.deletingId = null;
		}
	}
}
