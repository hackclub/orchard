<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		user,
		apiFetch,
		toasts,
		pendingInvitations,
		organizations,
		instanceFeatures,
		earlyAccessFlag,
		type PendingInvitation
	} from '$lib/stores';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import SettingsShell from '$lib/components/patterns/SettingsShell.svelte';
	import GraftMount from '$lib/grafts/GraftMount.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import {
		loadEarlyAccessFeatures,
		setEarlyAccessFeatureEnrollment,
		isFeatureEnabledNow,
		type EarlyAccessFeature
	} from '$lib/posthog';
	import { page } from '$app/stores';
	import { registerPasskey as createPasskey, passkeyErrorMessage } from '$lib/utils/passkey';
	import { StepUpError } from '$lib/utils/step-up';
	import { rememberReturnTo } from '$lib/utils/url-secrets';
	import {
		UserIdentityHero,
		UserInvitations,
		UserLinkedOrganizations,
		UserSignInSafety,
		UserGitHub,
		UserGitProviders,
		UserTailscale,
		UserPasskeys,
		UserSessions,
		UserEarlyAccess,
		UserAccessibility,
		UserApiTokens,
		UserMcp,
		UserAppearance,
		UserNotifications,
		UserLogs
	} from '$lib/components/user-settings';

	let githubLinked = $state(false);
	let githubUsername = $state<string | null>(null);
	let loading = $state(true);
	let unlinking = $state(false);
	let githubInstallations = $state<
		Array<{
			id: string;
			installationId: string;
			accountLogin: string;
			accountType: string;
			repositorySelection: string;
		}>
	>([]);
	let githubAppInstallUrl = $state<string | null>(null);
	let githubTokenExpired = $state(false);
	let githubAppConfigured = $state(true);

	let tailscaleLinked = $state(false);
	let tailscaleTailnet = $state<string | null>(null);
	let tailscaleLoading = $state(true);
	let unlinkingTailscale = $state(false);
	let tailscaleApiKey = $state('');
	let tailscaleLoginServer = $state('');
	let linkingTailscale = $state(false);
	let showTailscaleForm = $state(false);

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}
	let passkeys = $state<PasskeyRecord[]>([]);
	let passkeysLoading = $state(true);
	let passkeyListError = $state<string | null>(null);
	let registerLoading = $state(false);
	let newPasskeyName = $state('');
	let passkeyCurrentPassword = $state('');
	let passkeyNeedsCurrent = $state(false);
	let passkeyStale = $state(false);
	let editingPasskeyId = $state<string | null>(null);
	let renameValue = $state('');
	let renaming = $state(false);
	let deletingPasskeyId = $state<string | null>(null);
	let passkeyEnvWarning = $state<string | null>(null);
	let showAddPasskey = $state(false);
	let showDeletePasskeyModal = $state(false);
	let passkeyToDelete = $state<PasskeyRecord | null>(null);

	let isEditingProfile = $state(false);
	let editFirstName = $state('');
	let editLastName = $state('');
	let editUsername = $state('');
	let savingProfile = $state(false);
	let emailRevealed = $state(false);
	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);

	let acceptingInvitation = $state<string | null>(null);
	let decliningInvitation = $state<string | null>(null);
	const invitations = $derived($pendingInvitations);

	interface SessionRecord {
		id: string;
		ipAddress?: string | null;
		deviceName?: string | null;
		location?: string | null;
		authMethod?: string | null;
		lastActiveAt: string;
		createdAt: string;
		isCurrent: boolean;
	}
	let sessions = $state<SessionRecord[]>([]);
	let sessionsLoading = $state(true);
	let sessionsError = $state<string | null>(null);
	let revokingSessionId = $state<string | null>(null);
	let revokingAll = $state(false);
	let showRevokeAllModal = $state(false);
	let sessionToRevoke = $state<SessionRecord | null>(null);
	let showRevokeSessionModal = $state(false);

	let earlyAccessFeatures = $state<EarlyAccessFeature[]>([]);
	let earlyAccessLoading = $state(true);
	let earlyAccessEnrollment = $state<Record<string, boolean>>({});
	let togglingFeature = $state<string | null>(null);

	let backendVersion = $state<string | null>(null);
	const frontendVersion = __APP_VERSION__;

	const tailscaleEnabled = earlyAccessFlag('tailscale-integration');
	const notificationsEnabled = earlyAccessFlag('notifications');

	let tailscaleChecked = false;
	$effect(() => {
		if (!$tailscaleEnabled || tailscaleChecked) return;
		tailscaleChecked = true;
		void checkTailscaleStatus();
	});

	const graftTabs = $derived(
		graftHost.slot('user.settings.tabs', {}).map(({ graftId, host, item }) => ({
			key: `graft-${graftId}-${item.id}`,
			id: item.id,
			graftId,
			host,
			label: item.label,
			mount: item.mount
		}))
	);

	const RAIL_GROUPS = $derived(
		[
			{
				label: 'Connections',
				items: [
					{ id: 'connections', label: 'Connections' },
					{ id: 'tokens', label: 'API tokens' },
					...($instanceFeatures.mcp ? [{ id: 'mcp', label: 'MCP' }] : [])
				]
			},
			{
				label: 'Security',
				items: [{ id: 'security', label: 'Passkeys and devices' }]
			},
			...(graftTabs.length
				? [
						{
							label: 'Extensions',
							items: graftTabs.map((t) => ({ id: t.key, label: t.label }))
						}
					]
				: []),
			{
				label: 'Preferences',
				items: [
					...($notificationsEnabled ? [{ id: 'notifications', label: 'Notifications' }] : []),
					{ id: 'appearance', label: 'Appearance' },
					{ id: 'accessibility', label: 'Accessibility' },
					{ id: 'logs', label: 'Logs' },
					{ id: 'early-access', label: 'Early access' }
				]
			}
		].map((group) => ({
			...group,
			items: group.items.map((item) => ({ ...item, href: `/user/settings?tab=${item.id}` }))
		}))
	);

	const activeTab = $derived.by(() => {
		const t = $page.url.searchParams.get('tab');
		if (!t || t === 'profile') return 'connections';
		if (RAIL_GROUPS.some((g) => g.items.some((i) => i.id === t))) return t;
		return graftTabs.find((g) => g.id === t)?.key ?? t;
	});
	const activeGraftTab = $derived(graftTabs.find((t) => t.key === activeTab));

	function censorEmail(email: string): string {
		const [local, domain] = email.split('@');
		if (!domain) return '••••••';
		return `${local.slice(0, 2)}${'•'.repeat(Math.max(local.length - 2, 3))}@${domain}`;
	}
	let displayEmail = $derived.by(() => {
		const email = $user?.email || '';
		if (!email) return '';
		return emailRevealed ? email : censorEmail(email);
	});

	function startEditProfile() {
		editFirstName = $user?.firstName || '';
		editLastName = $user?.lastName || '';
		editUsername = $user?.username || '';
		isEditingProfile = true;
	}
	function cancelEditProfile() {
		isEditingProfile = false;
	}
	function invalidUsernameChars(value: string) {
		return [...new Set([...value].filter((ch) => !/[a-zA-Z0-9_-]/.test(ch)))];
	}
	async function saveProfile() {
		if (savingProfile) return;
		const username = editUsername
			.trim()
			.normalize('NFKC')
			.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
		const bad = invalidUsernameChars(username);
		if (bad.length) {
			const shown = bad
				.map((ch) =>
					ch.codePointAt(0)! > 126
						? `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`
						: `"${ch}"`
				)
				.join(', ');
			toasts.add({
				title: 'Invalid username',
				description: `Not allowed: ${shown}. Use letters, numbers, underscores, and hyphens.`,
				color: 'error'
			});
			return;
		}
		savingProfile = true;
		try {
			const body: Record<string, string | null> = {
				firstName: editFirstName.trim() || null,
				lastName: editLastName.trim() || null
			};
			if (username) body.username = username;
			const response = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't update");
			}
			const updatedUser = await response.json();
			user.set({ ...$user, ...updatedUser });
			toasts.add({ title: 'Profile updated', color: 'success' });
			isEditingProfile = false;
		} catch (e) {
			toasts.add({
				title: "Couldn't update",
				description: e instanceof Error ? e.message : "Couldn't update",
				color: 'error'
			});
		} finally {
			savingProfile = false;
		}
	}

	async function uploadAvatar(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
		if (!allowedTypes.includes(file.type)) {
			toasts.add({
				title: 'Invalid file type',
				description: 'Use a JPEG, PNG, GIF or WebP image',
				color: 'error'
			});
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			toasts.add({
				title: 'File too large',
				description: 'Use a file under 5 MB',
				color: 'error'
			});
			return;
		}
		uploadingAvatar = true;
		try {
			const formData = new FormData();
			formData.append('file', file);
			const response = await apiFetch('/apiv1/auth/me/avatar', { method: 'POST', body: formData });
			if (!response.ok) throw new Error("Couldn't upload avatar");
			const updated = await response.json();
			user.set({ ...$user, ...updated });
			toasts.add({ title: 'Avatar updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't upload avatar",
				description: e instanceof Error ? e.message : "Couldn't upload avatar",
				color: 'error'
			});
		} finally {
			uploadingAvatar = false;
		}
	}
	async function deleteAvatar() {
		deletingAvatar = true;
		try {
			const response = await apiFetch('/apiv1/auth/me/avatar', { method: 'DELETE' });
			if (!response.ok) throw new Error("Couldn't remove avatar");
			const updated = await response.json();
			user.set({ ...$user, ...updated });
			toasts.add({ title: 'Avatar removed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't remove avatar",
				description: e instanceof Error ? e.message : "Couldn't remove avatar",
				color: 'error'
			});
		} finally {
			deletingAvatar = false;
		}
	}

	async function handleAcceptInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		acceptingInvitation = invitation.id;
		try {
			await pendingInvitations.accept(invitation.id, true);
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);
				organizations.initializeSelected();
			}
			toasts.add({
				title: 'Welcome',
				description: `You've joined ${invitation.organization.name}`,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't accept invitation",
				description: e instanceof Error ? e.message : "Couldn't accept invitation",
				color: 'error'
			});
		} finally {
			acceptingInvitation = null;
		}
	}
	async function handleDeclineInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		decliningInvitation = invitation.id;
		try {
			await pendingInvitations.decline(invitation.id);
			toasts.add({ title: 'Invitation declined', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't decline invitation",
				description: e instanceof Error ? e.message : "Couldn't decline invitation",
				color: 'error'
			});
		} finally {
			decliningInvitation = null;
		}
	}

	async function checkGitHubStatus() {
		loading = true;
		try {
			const response = await apiFetch('/apiv1/github/status');
			if (response.ok) {
				const data = await response.json();
				githubLinked = data.linked;
				githubUsername = data.username || null;
				githubInstallations = data.installations ?? [];
				githubTokenExpired = data.tokenExpired ?? false;
				githubAppConfigured = data.appConfigured ?? true;
			} else {
				console.error('[GitHub status]', response.status, await response.text().catch(() => ''));
			}
			const installRes = await apiFetch('/apiv1/github/app/install');
			if (installRes.ok) {
				const data = await installRes.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
		} finally {
			loading = false;
		}
	}
	function linkGitHub() {
		window.location.href = '/apiv1/github/link';
	}
	async function unlinkGitHub() {
		unlinking = true;
		try {
			const response = await apiFetch('/apiv1/github/unlink', { method: 'DELETE' });
			if (!response.ok) throw new Error("Couldn't unlink GitHub account");
			githubLinked = false;
			githubUsername = null;
			toasts.add({
				title: 'GitHub unlinked',
				description: 'Your GitHub account is disconnected',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't unlink GitHub",
				description: e instanceof Error ? e.message : "Couldn't unlink GitHub",
				color: 'error'
			});
		} finally {
			unlinking = false;
		}
	}

	async function checkTailscaleStatus() {
		tailscaleLoading = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/status');
			if (response.ok) {
				const data = await response.json();
				tailscaleLinked = data.linked;
				tailscaleTailnet = data.tailnet || null;
			}
		} catch (e) {
			console.error('Failed to check Tailscale status:', e);
		} finally {
			tailscaleLoading = false;
		}
	}
	async function linkTailscale() {
		if (!tailscaleApiKey.trim()) return;
		linkingTailscale = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/link', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: tailscaleApiKey.trim(),
					...(tailscaleLoginServer.trim() ? { loginServer: tailscaleLoginServer.trim() } : {})
				})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't connect Tailscale");
			}
			const data = await response.json();
			tailscaleLinked = true;
			tailscaleTailnet = data.tailnet;
			tailscaleApiKey = '';
			tailscaleLoginServer = '';
			showTailscaleForm = false;
			toasts.add({
				title: 'Tailscale connected',
				description: `Linked to ${data.tailnet}`,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't connect Tailscale",
				description: e instanceof Error ? e.message : "Couldn't connect Tailscale",
				color: 'error'
			});
		} finally {
			linkingTailscale = false;
		}
	}
	async function unlinkTailscale() {
		unlinkingTailscale = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/unlink', { method: 'DELETE' });
			if (!response.ok) throw new Error("Couldn't unlink Tailscale account");
			tailscaleLinked = false;
			tailscaleTailnet = null;
			toasts.add({
				title: 'Tailscale disconnected',
				description: 'Your Tailscale account is disconnected',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: "Couldn't unlink Tailscale",
				description: e instanceof Error ? e.message : "Couldn't unlink Tailscale",
				color: 'error'
			});
		} finally {
			unlinkingTailscale = false;
		}
	}

	async function fetchSessions() {
		sessionsLoading = true;
		sessionsError = null;
		try {
			const response = await apiFetch('/apiv1/auth/sessions');
			if (!response.ok) throw new Error("Couldn't load sessions");
			const data = await response.json();
			sessions = data.sessions ?? [];
		} catch (err) {
			sessionsError = err instanceof Error ? err.message : "Couldn't load sessions";
		} finally {
			sessionsLoading = false;
		}
	}
	function confirmRevokeSession(session: SessionRecord) {
		sessionToRevoke = session;
		showRevokeSessionModal = true;
	}
	async function revokeSession(session: SessionRecord) {
		if (revokingSessionId) return;
		revokingSessionId = session.id;
		try {
			const response = await apiFetch(`/apiv1/auth/sessions/${session.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't revoke session");
			}
			toasts.add({ title: 'Session revoked', color: 'success' });
			await fetchSessions();
		} catch (err) {
			toasts.add({
				title: "Couldn't revoke session",
				description: err instanceof Error ? err.message : "Couldn't revoke session",
				color: 'error'
			});
		} finally {
			revokingSessionId = null;
		}
	}
	async function revokeAllSessions() {
		if (revokingAll) return;
		revokingAll = true;
		try {
			const response = await apiFetch('/apiv1/auth/sessions/revoke-all', { method: 'POST' });
			if (!response.ok) throw new Error("Couldn't revoke sessions");
			const data = await response.json();
			toasts.add({
				title: 'Sessions revoked',
				description: `${data.revokedCount} session${data.revokedCount === 1 ? '' : 's'} signed out`,
				color: 'success'
			});
			await fetchSessions();
		} catch (err) {
			toasts.add({
				title: "Couldn't revoke sessions",
				description: err instanceof Error ? err.message : "Couldn't revoke sessions",
				color: 'error'
			});
		} finally {
			revokingAll = false;
			showRevokeAllModal = false;
		}
	}

	async function fetchPasskeys() {
		passkeysLoading = true;
		passkeyListError = null;
		try {
			const response = await apiFetch('/apiv1/auth/passkeys');
			if (!response.ok) throw new Error("Couldn't load passkeys");
			const data = await response.json();
			passkeys = data.passkeys ?? [];
		} catch (err) {
			passkeyListError = err instanceof Error ? err.message : "Couldn't load passkeys";
		} finally {
			passkeysLoading = false;
		}
	}
	async function registerPasskey() {
		if (registerLoading) return;
		if (!browser || typeof window === 'undefined') {
			toasts.add({
				title: 'Unsupported',
				description: "Passkeys aren't available in this environment.",
				color: 'error'
			});
			return;
		}
		if (!window.isSecureContext) {
			toasts.add({
				title: 'Use a secure origin',
				description: 'Passkeys require https:// or http://localhost.',
				color: 'error'
			});
			return;
		}
		if (!window.PublicKeyCredential) {
			toasts.add({
				title: 'Unsupported',
				description: "Passkeys aren't available on this device.",
				color: 'error'
			});
			return;
		}
		registerLoading = true;
		try {
			await createPasskey(newPasskeyName, passkeyNeedsCurrent ? passkeyCurrentPassword : undefined);
			passkeyCurrentPassword = '';
			toasts.add({
				title: 'Passkey added',
				description: 'You can now sign in with this device.',
				color: 'success'
			});
			newPasskeyName = '';
			showAddPasskey = false;
			await fetchPasskeys();
		} catch (err) {
			if (err instanceof StepUpError && err.needsCurrentPassword) passkeyNeedsCurrent = true;
			passkeyStale = err instanceof StepUpError && err.needsSignIn;
			toasts.add({
				title: "Couldn't register passkey",
				description: passkeyErrorMessage(err),
				color: 'error'
			});
		} finally {
			registerLoading = false;
		}
	}
	function signInAgain() {
		rememberReturnTo(window.location.pathname + window.location.search);
		user.signOut();
	}
	function startRenaming(passkey: PasskeyRecord) {
		editingPasskeyId = passkey.id;
		renameValue = passkey.friendlyName || '';
	}
	function cancelRenaming() {
		editingPasskeyId = null;
		renameValue = '';
	}
	async function savePasskeyName() {
		if (!editingPasskeyId) return;
		const friendlyName = renameValue.trim();
		if (!friendlyName) {
			toasts.add({
				title: 'Name required',
				description: 'Give this passkey a short name.',
				color: 'error'
			});
			return;
		}
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${editingPasskeyId}/rename`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ friendlyName })
			});
			if (!response.ok) throw new Error("Couldn't rename passkey");
			toasts.add({ title: 'Passkey renamed', color: 'success' });
			cancelRenaming();
			await fetchPasskeys();
		} catch (err) {
			toasts.add({
				title: 'Rename failed',
				description: err instanceof Error ? err.message : "Couldn't update name",
				color: 'error'
			});
		} finally {
			renaming = false;
		}
	}
	function confirmDeletePasskey(passkey: PasskeyRecord) {
		passkeyToDelete = passkey;
		showDeletePasskeyModal = true;
	}
	async function deletePasskey(passkey: PasskeyRecord) {
		if (deletingPasskeyId) return;
		deletingPasskeyId = passkey.id;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${passkey.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || "Couldn't delete passkey");
			}
			toasts.add({ title: 'Passkey removed', color: 'success' });
			if (editingPasskeyId === passkey.id) cancelRenaming();
			await fetchPasskeys();
		} catch (err) {
			toasts.add({
				title: "Couldn't remove passkey",
				description: err instanceof Error ? err.message : 'Try again.',
				color: 'error'
			});
		} finally {
			deletingPasskeyId = null;
		}
	}
	function formatTimestamp(value?: string | null) {
		if (!value) return 'Never';
		return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	async function fetchEarlyAccessFeatures() {
		earlyAccessLoading = true;
		try {
			const features = await loadEarlyAccessFeatures();
			earlyAccessFeatures = features;
			const next: Record<string, boolean> = {};
			for (const f of features) next[f.flagKey] = isFeatureEnabledNow(f.flagKey);
			earlyAccessEnrollment = next;
		} finally {
			earlyAccessLoading = false;
		}
	}
	async function toggleEarlyAccessFeature(feature: EarlyAccessFeature) {
		if (togglingFeature) return;
		togglingFeature = feature.flagKey;
		const next = !earlyAccessEnrollment[feature.flagKey];
		earlyAccessEnrollment = { ...earlyAccessEnrollment, [feature.flagKey]: next };
		try {
			setEarlyAccessFeatureEnrollment(feature.flagKey, next);
			toasts.add({
				title: next ? 'Enrolled' : 'Unenrolled',
				description: `${next ? 'Enrolled in' : 'Left'} "${feature.name}"`,
				color: 'success'
			});
		} catch (err) {
			earlyAccessEnrollment = { ...earlyAccessEnrollment, [feature.flagKey]: !next };
			toasts.add({
				title: "Couldn't update enrollment",
				description: err instanceof Error ? err.message : "Couldn't update enrollment",
				color: 'error'
			});
		} finally {
			togglingFeature = null;
		}
	}

	onMount(() => {
		if (browser && typeof window !== 'undefined' && !window.isSecureContext) {
			passkeyEnvWarning = `Passkeys require a secure origin. You're on ${window.location.origin}.`;
		}

		if (browser) {
			const params = new URLSearchParams(window.location.search);
			const ghError = params.get('error');
			const ghLinked = params.get('github');
			if (ghError) {
				toasts.add({ title: 'GitHub linking failed', description: ghError, color: 'error' });
				console.error('[GitHub OAuth]', ghError);
			} else if (ghLinked === 'linked') {
				toasts.add({
					title: 'GitHub linked',
					description: 'Your GitHub account is connected',
					color: 'success'
				});
			}
			if (ghError || ghLinked) {
				const url = new URL(window.location.href);
				url.searchParams.delete('error');
				url.searchParams.delete('github');
				goto(url, { replaceState: true, keepFocus: true, noScroll: true });
			}
		}

		checkGitHubStatus();
		instanceFeatures.load();
		fetchPasskeys();
		fetchSessions();
		fetchEarlyAccessFeatures();
		apiFetch('/apiv1/health')
			.then((r) => r.json())
			.then((d) => (backendVersion = d.version))
			.catch(() => {});
		if (browser && window.location.hash === '#invitations') {
			goto('/user/settings?tab=profile', { replaceState: true });
		}
	});
</script>

<SettingsShell
	crumbs={[{ label: 'Home', href: '/' }, { label: 'Account' }]}
	groups={RAIL_GROUPS}
	activeId={activeTab}
	label="Account settings sections"
>
	{#snippet header()}
		<UserIdentityHero
			user={$user}
			{displayEmail}
			bind:emailRevealed
			bind:isEditing={isEditingProfile}
			bind:editFirstName
			bind:editLastName
			bind:editUsername
			saving={savingProfile}
			{uploadingAvatar}
			{deletingAvatar}
			onStartEditing={startEditProfile}
			onCancelEditing={cancelEditProfile}
			onSave={saveProfile}
			onUploadAvatar={uploadAvatar}
			onDeleteAvatar={deleteAvatar}
			passkeyCount={passkeysLoading ? null : passkeys.length}
			sessionCount={sessionsLoading ? null : sessions.length}
			{githubLinked}
		/>

		{#if invitations.length}
			<UserInvitations
				index={0}
				{invitations}
				{acceptingInvitation}
				{decliningInvitation}
				onAccept={handleAcceptInvitation}
				onDecline={handleDeclineInvitation}
			/>
		{/if}
	{/snippet}
	{#snippet footer()}
		{frontendVersion}{backendVersion ? `+${backendVersion}` : ''}
	{/snippet}

	{#if activeTab === 'connections'}
		{#if !$user?.homeOrganizationId && !$user?.sessionOrganizationId}
			<UserLinkedOrganizations />
		{/if}
		<UserGitHub
			index={0}
			{loading}
			{githubLinked}
			{githubUsername}
			{githubInstallations}
			{githubAppInstallUrl}
			{githubTokenExpired}
			appConfigured={githubAppConfigured}
			{unlinking}
			onLink={linkGitHub}
			onUnlink={unlinkGitHub}
		/>
		<UserGitProviders index={1} />
		{#if $tailscaleEnabled}
			<UserTailscale
				index={1}
				{tailscaleLoading}
				{tailscaleLinked}
				{tailscaleTailnet}
				{unlinkingTailscale}
				bind:showTailscaleForm
				bind:tailscaleApiKey
				bind:tailscaleLoginServer
				{linkingTailscale}
				onLink={linkTailscale}
				onUnlink={unlinkTailscale}
			/>
		{/if}
	{/if}

	{#if activeTab === 'tokens'}
		<UserApiTokens />
	{/if}

	{#if activeTab === 'mcp' && $instanceFeatures.mcp}
		<UserMcp />
	{/if}

	{#if activeTab === 'security'}
		{#if !$user?.homeOrganizationId && !$user?.sessionOrganizationId && (passkeys.length > 0 || $user?.passkeyOnly || $user?.emailDomainOwner)}
			<UserSignInSafety passkeyCount={passkeys.length} />
		{/if}
		<UserPasskeys
			index={0}
			{passkeys}
			{passkeysLoading}
			{passkeyListError}
			{passkeyEnvWarning}
			{registerLoading}
			bind:showAddPasskey
			bind:newPasskeyName
			bind:currentPassword={passkeyCurrentPassword}
			needsCurrent={passkeyNeedsCurrent}
			stale={passkeyStale}
			onSignInAgain={signInAgain}
			bind:editingPasskeyId
			bind:renameValue
			{renaming}
			{deletingPasskeyId}
			onRegister={registerPasskey}
			onStartRenaming={startRenaming}
			onCancelRenaming={cancelRenaming}
			onSavePasskeyName={savePasskeyName}
			onConfirmDelete={confirmDeletePasskey}
			{formatTimestamp}
		/>
		<UserSessions
			index={1}
			{sessions}
			{sessionsLoading}
			{sessionsError}
			{revokingSessionId}
			onConfirmRevokeSession={confirmRevokeSession}
			onShowRevokeAll={() => (showRevokeAllModal = true)}
		/>
	{/if}

	{#if activeTab === 'notifications' && $notificationsEnabled}
		<UserNotifications index={0} />
	{/if}

	{#if activeTab === 'appearance'}
		<UserAppearance />
	{/if}

	{#if activeTab === 'accessibility'}
		<UserAccessibility index={0} />
	{/if}

	{#if activeTab === 'logs'}
		<UserLogs index={0} />
	{/if}

	{#if activeGraftTab}
		{#key activeGraftTab.key}
			<GraftMount
				graftId={activeGraftTab.graftId}
				mount={activeGraftTab.mount}
				props={{}}
				host={activeGraftTab.host}
			/>
		{/key}
	{/if}
	{#if activeTab === 'early-access'}
		<UserEarlyAccess
			index={0}
			{earlyAccessFeatures}
			{earlyAccessLoading}
			{earlyAccessEnrollment}
			{togglingFeature}
			onToggleFeature={toggleEarlyAccessFeature}
		/>
	{/if}
</SettingsShell>

{#if sessionToRevoke}
	<ConfirmModal
		bind:open={showRevokeSessionModal}
		title="Sign out this device?"
		description="This immediately ends the session on {sessionToRevoke.deviceName ||
			'this device'}. That device must sign in again."
		confirmLabel="Sign out"
		danger
		onconfirm={() => revokeSession(sessionToRevoke!)}
		oncancel={() => {
			sessionToRevoke = null;
		}}
	/>
{/if}
<ConfirmModal
	bind:open={showRevokeAllModal}
	title="Sign out all other devices?"
	description="This ends every session except this one and deletes all your API tokens. Other devices must sign in again, and anything using a token stops working until you create a new one."
	confirmLabel="Sign out all"
	danger
	onconfirm={revokeAllSessions}
	oncancel={() => {
		showRevokeAllModal = false;
	}}
/>
{#if passkeyToDelete}
	<ConfirmModal
		bind:open={showDeletePasskeyModal}
		title={`Remove "${passkeyToDelete.friendlyName || 'this passkey'}"?`}
		description="This permanently removes the passkey. You can't use it to sign in again."
		confirmLabel="Remove passkey"
		danger
		onconfirm={() => deletePasskey(passkeyToDelete!)}
		oncancel={() => {
			passkeyToDelete = null;
		}}
	/>
{/if}
