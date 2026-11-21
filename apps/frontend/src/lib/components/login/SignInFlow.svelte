<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
	import { ChevronLeft, ChevronRight, KeyRound, Lock, Mail, Check, Sprout } from 'lucide-svelte';
	import {
		Alert,
		Button,
		CodeInput,
		Divider,
		Field,
		Input,
		Skeleton,
		ToneTile
	} from '$lib/components/ui';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Turnstile from '$lib/components/Turnstile.svelte';
	import { apiBase, apiFetch, authConfig } from '$lib/stores';
	import type { User } from '$lib/stores';
	import {
		FADE,
		decorativeMotion,
		springTiming,
		fade as fadeTiming
	} from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';
	import ProviderIcon, { hasProviderMark } from './ProviderIcon.svelte';
	import { signingIn } from './signing-in';
	import type { LoginProvider } from './types';

	type Step = 'start' | 'choose' | 'passkey' | 'password' | 'code' | 'blocked' | 'done';
	type EmailAccess = 'open' | 'tucked' | 'none' | 'loading';

	let {
		title,
		subtitle = undefined,
		mark = undefined,
		providers = [],
		providersLoaded = true,
		emailAccess = 'open',
		revealLabel = 'Sign in with email instead',
		policy = undefined,
		returnTo = undefined,
		error = null,
		email = $bindable(''),
		initialCode = '',
		bloom = $bindable(false),
		landed = $bindable(false),
		aside = undefined,
		onAuthenticated,
		onSsoRedirect = undefined
	}: {
		title: string;
		subtitle?: string | Snippet;
		mark?: Snippet;
		providers?: LoginProvider[];
		providersLoaded?: boolean;
		emailAccess?: EmailAccess;
		revealLabel?: string;
		policy?: string;
		returnTo?: string;
		error?: string | null;
		email?: string;
		initialCode?: string;
		bloom?: boolean;
		landed?: boolean;
		aside?: Snippet;
		onAuthenticated: (message: string, user: User | undefined, landing: Promise<void>) => unknown;
		onSsoRedirect?: (email: string) => Promise<boolean>;
	} = $props();

	const ORDER: Step[] = ['start', 'choose', 'passkey', 'password', 'code', 'blocked', 'done'];
	const LANDING_MS = 620;

	let step = $state<Step>('start');
	let forward = true;
	let revealed = $state(false);
	let code = $state('');
	let password = $state('');
	let fault = $state<string | null>(null);
	let codeFault = $state(false);
	let busy = $state<null | 'check' | 'send' | 'verify' | 'passkey' | 'provider'>(null);
	let starting = $state<string | null>(null);
	let resent = $state(false);
	let blocked = $state<'private_beta' | 'signups_disabled' | null>(null);
	let passkeySupported = $state(false);
	let hasPassword = $state(false);
	let hasPasskey = $state(false);
	let chooser = $state(false);
	let siteKey = $state<string | null>(null);
	let emailCodes = $state(true);
	let widget = $state<{ execute: () => Promise<string> } | null>(null);
	let configLoaded = false;
	let pendingAutoVerify = false;

	const emailOpen = $derived(emailAccess === 'open' || revealed);
	const address = $derived(email.trim().toLowerCase());

	function go(next: Step) {
		forward = ORDER.indexOf(next) >= ORDER.indexOf(step);
		fault = null;
		codeFault = false;
		step = next;
	}

	onMount(() => {
		passkeySupported =
			browser && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
		authConfig
			.load()
			.then((config) => {
				siteKey = config.turnstileSiteKey;
				emailCodes = config.emailCodes !== false;
			})
			.catch(() => (siteKey = null))
			.finally(() => {
				configLoaded = true;
				maybeAutoVerify();
			});
	});

	$effect(() => {
		const linked = initialCode;
		if (!linked) return;
		untrack(() => {
			if (!email) return;
			code = linked;
			go('code');
			pendingAutoVerify = true;
			maybeAutoVerify();
		});
	});

	function maybeAutoVerify() {
		if (!pendingAutoVerify || !configLoaded) return;
		pendingAutoVerify = false;
		verifyCode();
	}

	async function botHeaders(): Promise<Record<string, string>> {
		if (!siteKey || !widget) return {};
		return { 'x-turnstile-token': await widget.execute() };
	}

	function blockedBy(status: number, data: { message?: string }) {
		if (status !== 403) return false;
		if (data?.message !== 'private_beta' && data?.message !== 'signups_disabled') return false;
		blocked = data.message;
		go('blocked');
		return true;
	}

	onDestroy(() => signingIn.set(false));

	async function land(message: string, user?: User) {
		go('done');
		bloom = true;
		landed = true;
		signingIn.set(true);
		const landing = new Promise<void>((resolve) =>
			setTimeout(resolve, decorativeMotion() ? LANDING_MS : 0)
		);
		try {
			await onAuthenticated(message, user, landing);
		} catch {
			signingIn.set(false);
			bloom = false;
			landed = false;
			go('start');
			fault = 'Signed in, but loading your account failed. Try again.';
		}
	}

	function startProvider(provider: LoginProvider) {
		starting = provider.id;
		const url = new URL(`${$apiBase}${provider.startUrl}`, window.location.origin);
		if (returnTo && provider.startUrl.includes('/sso/start/')) {
			url.searchParams.set('returnTo', returnTo);
		}
		window.location.href = url.toString();
	}

	async function sendCode(again = false) {
		if (busy === 'send') return;
		if (!address) {
			fault = 'Enter the email address you use with Orchard.';
			return;
		}
		busy = 'send';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/otp/request', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.message || "Couldn't send the code.");
			code = '';
			if (again) {
				resent = true;
				setTimeout(() => (resent = false), 4000);
			} else {
				go('code');
			}
		} catch (err) {
			fault = err instanceof Error ? err.message : "Couldn't send the code.";
		} finally {
			busy = null;
		}
	}

	async function continueWithEmail() {
		if (busy) return;
		if (!address || !address.includes('@')) {
			fault = 'Enter the email address you use with Orchard.';
			return;
		}
		busy = 'check';
		fault = null;
		try {
			if (onSsoRedirect && (await onSsoRedirect(address))) return;
			let methods = { passkey: false, password: false };
			try {
				const response = await apiFetch(`/apiv1/auth/methods?email=${encodeURIComponent(address)}`);
				const data = await response.json().catch(() => ({}));
				methods = {
					passkey: Boolean(data?.passkey),
					password: Boolean(data?.password)
				};
			} catch {
				methods = { passkey: false, password: false };
			}
			hasPassword = methods.password;
			hasPasskey = methods.passkey && passkeySupported;
			chooser = hasPasskey || hasPassword;
			busy = null;
			if (chooser) go('choose');
			else if (hasPasskey) {
				go('passkey');
				await signInWithPasskey();
			} else if (hasPassword) go('password');
			else if (emailCodes) await sendCode();
			else fault = "This instance can't send email, so this address has no way to sign in here.";
		} finally {
			if (busy === 'check') busy = null;
		}
	}

	async function verifyCode() {
		if (busy === 'verify') return;
		if (code.length !== 6) {
			codeFault = true;
			fault = 'Enter all 6 digits.';
			return;
		}
		busy = 'verify';
		fault = null;
		codeFault = false;
		try {
			const response = await apiFetch('/apiv1/auth/otp/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address, code })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				if (blockedBy(response.status, data)) return;
				if (data?.message === 'passkey_only' || data?.message === 'email_domain_changed_hands') {
					throw new Error(data.detail || 'Sign in with a passkey instead.');
				}
				if (data?.message === 'account_disabled') {
					throw new Error('This account is turned off. Ask your Orchard admin.');
				}
				throw new Error(data?.message || 'That code is wrong or expired.');
			}
			busy = null;
			await land('Signed in with your email', data?.user);
		} catch (err) {
			codeFault = true;
			fault = err instanceof Error ? err.message : 'That code is wrong or expired.';
		} finally {
			if (busy === 'verify') busy = null;
		}
	}

	async function signInWithPassword() {
		if (busy === 'verify') return;
		if (!password) {
			fault = 'Enter your password.';
			return;
		}
		busy = 'verify';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(await botHeaders()) },
				body: JSON.stringify({ email: address, password })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				if (blockedBy(response.status, data)) return;
				throw new Error(data?.message || 'That password is incorrect.');
			}
			password = '';
			busy = null;
			await land('Signed in', data?.user);
		} catch (err) {
			fault = err instanceof Error ? err.message : "Couldn't sign in.";
		} finally {
			if (busy === 'verify') busy = null;
		}
	}

	async function signInWithPasskey() {
		if (busy === 'passkey') return;
		if (!passkeySupported) {
			fault = "This browser doesn't support passkeys.";
			return;
		}
		busy = 'passkey';
		fault = null;
		try {
			const response = await apiFetch('/apiv1/auth/passkey/authenticate/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: address || undefined })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't start passkey sign-in.");
			}
			const options = await response.json();
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const credential = await startAuthentication({ optionsJSON: options });
			const verify = await apiFetch('/apiv1/auth/passkey/authenticate/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: credential })
			});
			const data = await verify.json().catch(() => ({}));
			if (!verify.ok) {
				if (blockedBy(verify.status, data)) return;
				throw new Error(data?.message || 'Passkey sign-in failed.');
			}
			busy = null;
			await land('Signed in with your passkey', data?.user);
		} catch (err) {
			fault =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'Passkey request canceled.'
					: err instanceof Error
						? err.message
						: 'Passkey sign-in failed.';
		} finally {
			if (busy === 'passkey') busy = null;
		}
	}

	function back() {
		password = '';
		code = '';
		if (chooser && step !== 'choose') go('choose');
		else go('start');
	}

	function enter(el: HTMLElement) {
		if (!decorativeMotion()) return;
		const dx = forward ? 14 : -14;
		el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], springTiming('snap'));
		el.animate([{ opacity: 0 }, { opacity: 1 }], { ...fadeTiming('in', 0.04), fill: 'backwards' });
	}
</script>

{#snippet botCheck()}
	{#if siteKey}<Turnstile bind:this={widget} {siteKey} action="signin" />{/if}
{/snippet}

{#snippet head(heading: string, sub: string | Snippet | undefined, withBack: boolean)}
	<header class="head">
		{#if withBack}
			<div class="lead">
				<Button variant="ghost" size="sm" icon={ChevronLeft} class="back" onclick={back}
					>Back</Button
				>
			</div>
		{:else if mark}
			<div class="lead">{@render mark()}</div>
		{/if}
		<h1 class="title">{heading}</h1>
		{#if sub}
			<p class="sub">
				{#if typeof sub === 'string'}{sub}{:else}{@render sub()}{/if}
			</p>
		{/if}
	</header>
{/snippet}

{#snippet who()}
	<span class="who">{address}</span>
{/snippet}

{#snippet faultLine()}
	{#if fault}<Alert tone="error">{fault}</Alert>{/if}
{/snippet}

<div class="steps">
	{#key step}
		<div class="step" {@attach enter} out:fade={{ duration: FADE.out }}>
			{#if step === 'start'}
				{@render head(title, subtitle, false)}
				{#if error}<Alert tone="error">{error}</Alert>{/if}
				{#if providers.length}
					<div class="stack">
						{#each providers as provider, i (provider.id)}
							<Button
								variant={i === 0 ? 'primary' : 'secondary'}
								size="lg"
								class="wide"
								loading={starting === provider.id}
								onclick={() => startProvider(provider)}
							>
								{#if starting !== provider.id && hasProviderMark(provider.preset, provider.iconUrl)}
									<ProviderIcon preset={provider.preset} iconUrl={provider.iconUrl} size={18} />
								{/if}
								{provider.label}
							</Button>
						{/each}
					</div>
				{:else if !providersLoaded}
					<Skeleton height="2.5rem" />
				{/if}
				{#if (providers.length || !providersLoaded) && emailAccess !== 'none'}
					<Divider label="or" />
				{/if}
				{#if emailAccess === 'loading'}
					<Skeleton height="2.5rem" />
				{:else if emailOpen}
					<form
						class="stack"
						novalidate
						onsubmit={(e) => {
							e.preventDefault();
							continueWithEmail();
						}}
					>
						<Field label="Email" for="signin-email" error={fault}>
							<Input
								id="signin-email"
								type="email"
								name="email"
								size="lg"
								placeholder="you@example.com"
								autocomplete="email webauthn"
								autofocus={revealed}
								error={!!fault}
								bind:value={email}
								oninput={() => (fault = null)}
							/>
						</Field>
						{@render botCheck()}
						<Button
							type="submit"
							size="lg"
							variant={providers.length ? 'secondary' : 'primary'}
							class="wide"
							loading={busy === 'check' || busy === 'send'}
						>
							Continue
						</Button>
					</form>
				{:else if emailAccess === 'tucked'}
					<Button variant="ghost" size="lg" class="wide" onclick={() => (revealed = true)}>
						{revealLabel}
					</Button>
				{/if}
				{#if policy && !emailOpen}<p class="text-center text-callout text-muted">{policy}</p>{/if}
			{:else if step === 'choose'}
				{@render head('Choose how to sign in', who, true)}
				<List label="Sign-in methods">
					{#if hasPasskey}
						<ListRow
							title="Passkey"
							subtitle="Touch ID, Windows Hello or a security key"
							onclick={() => {
								go('passkey');
								signInWithPasskey();
							}}
						>
							{#snippet leading()}<ToneTile tone="accent" size={32}><KeyRound size={16} /></ToneTile
								>{/snippet}
							{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
						</ListRow>
					{/if}
					{#if hasPassword}
						<ListRow title="Password" onclick={() => go('password')}>
							{#snippet leading()}<ToneTile tone="accent" size={32}><Lock size={16} /></ToneTile
								>{/snippet}
							{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
						</ListRow>
					{/if}
					{#if emailCodes}
						<ListRow
							title="Email me a code"
							subtitle="A 6-digit code, valid for 10 minutes"
							onclick={() => sendCode()}
						>
							{#snippet leading()}<ToneTile tone="accent" size={32}><Mail size={16} /></ToneTile
								>{/snippet}
							{#snippet trailing()}<ChevronRight size={16} class="chev" />{/snippet}
						</ListRow>
					{/if}
				</List>
				{@render faultLine()}
				{@render botCheck()}
			{:else if step === 'passkey'}
				{@render head('Use your passkey', who, true)}
				<Button
					variant="primary"
					size="lg"
					class="wide"
					icon={KeyRound}
					loading={busy === 'passkey'}
					onclick={signInWithPasskey}
				>
					Sign in with passkey
				</Button>
				{@render faultLine()}
				{@render botCheck()}
				<div class="-mt-1 flex flex-wrap justify-center gap-1">
					{#if hasPassword}
						<Button variant="ghost" size="sm" onclick={() => go('password')}>Use password</Button>
					{/if}
					{#if emailCodes}
						<Button variant="ghost" size="sm" loading={busy === 'send'} onclick={() => sendCode()}>
							Email me a code
						</Button>
					{/if}
				</div>
			{:else if step === 'password'}
				{@render head('Enter your password', who, true)}
				<form
					class="stack"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						signInWithPassword();
					}}
				>
					<input
						type="email"
						class="sr-only"
						autocomplete="username"
						value={address}
						readonly
						tabindex="-1"
						aria-hidden="true"
					/>
					<Field label="Password" for="signin-password" error={fault}>
						<Input
							id="signin-password"
							type="password"
							name="password"
							size="lg"
							autocomplete="current-password"
							autofocus
							error={!!fault}
							bind:value={password}
							oninput={() => (fault = null)}
						/>
					</Field>
					{@render botCheck()}
					<Button
						type="submit"
						variant="primary"
						size="lg"
						class="wide"
						loading={busy === 'verify'}
					>
						Sign in
					</Button>
				</form>
				<div class="-mt-1 flex flex-wrap justify-center gap-1">
					{#if hasPasskey}
						<Button variant="ghost" size="sm" onclick={() => go('passkey')}>Use passkey</Button>
					{/if}
					{#if emailCodes}
						<Button variant="ghost" size="sm" loading={busy === 'send'} onclick={() => sendCode()}>
							Email me a code
						</Button>
					{/if}
				</div>
			{:else if step === 'code'}
				{#snippet sentTo()}Enter the code we sent to <span class="who">{address}</span>{/snippet}
				{@render head('Check your email', sentTo, true)}
				<form
					class="stack"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						verifyCode();
					}}
				>
					<Field for="signin-code" error={fault}>
						<CodeInput
							id="signin-code"
							bind:value={code}
							error={codeFault}
							autofocus
							disabled={busy === 'verify'}
							oncomplete={() => verifyCode()}
						/>
					</Field>
					{@render botCheck()}
					<Button
						type="submit"
						variant="primary"
						size="lg"
						class="wide"
						disabled={code.length < 6}
						loading={busy === 'verify'}
					>
						Continue
					</Button>
				</form>
				<div class="-mt-1 flex flex-wrap justify-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						loading={busy === 'send'}
						disabled={resent}
						onclick={() => sendCode(true)}
					>
						{resent ? 'New code sent' : 'Send a new code'}
					</Button>
				</div>
			{:else if step === 'blocked'}
				<header class="head">
					<div class="lead"><ToneTile tone="accent" size={40}><Sprout size={18} /></ToneTile></div>
					<h1 class="title">
						{blocked === 'signups_disabled' ? 'Sign-ups are closed' : 'Orchard is invite-only'}
					</h1>
					<p class="sub">
						{blocked === 'signups_disabled'
							? "This instance isn't taking new accounts. Ask an administrator to add you."
							: 'Ask someone in an organization on this instance to invite you, then sign in with the email they used.'}
					</p>
				</header>
				<Button variant="secondary" size="lg" class="wide" onclick={() => go('start')}>
					Back to sign in
				</Button>
			{:else}
				<header class="head head--done">
					<div class="lead">
						<span class="pop"
							><ToneTile tone="success" solid size={40} label="Signed in"
								><Check size={18} strokeWidth={2.5} /></ToneTile
							></span
						>
					</div>
					<h1 class="title">You're in</h1>
					<p class="sub">Opening Orchard</p>
				</header>
			{/if}
			{#if aside && step !== 'done' && step !== 'blocked'}
				<div class="aside">{@render aside()}</div>
			{/if}
		</div>
	{/key}
</div>

<style>
	.steps {
		display: grid;
	}
	.step {
		grid-area: 1 / 1;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-direction: column;
		margin-bottom: 0.5rem;
	}
	.lead {
		display: flex;
		align-items: center;
		height: 2.5rem;
		margin-bottom: 1.25rem;
	}
	.lead :global(.back) {
		margin-left: -0.5rem;
	}
	.title {
		margin: 0;
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.015em;
		text-wrap: balance;
	}
	.sub {
		margin: 0.25rem 0 0;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--text-muted);
		text-wrap: pretty;
		overflow-wrap: anywhere;
	}
	.who {
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.stack :global(.wide),
	.step > :global(.wide) {
		width: 100%;
	}
	.step :global(.chev) {
		color: var(--text-faint);
	}
	.head--done {
		align-items: center;
		margin-bottom: 0;
		text-align: center;
	}
	.head--done .lead {
		margin-bottom: 1rem;
	}
	.aside {
		display: flex;
		justify-content: center;
	}
	.pop {
		display: inline-flex;
		animation: badge-in var(--spring-bouncy-duration) var(--spring-bouncy);
	}
	@keyframes badge-in {
		from {
			transform: scale(0.4);
			opacity: 0;
		}
	}
</style>
