<script lang="ts">
	import {
		ChevronDown,
		ChevronsUpDown,
		Link2,
		Mail,
		Unlink,
		UserCheck,
		UserPlus,
		UserX,
		X
	} from 'lucide-svelte';
	import {
		Avatar,
		ItemLabel,
		Badge,
		Button,
		Dropdown,
		Field,
		Input,
		List,
		ListRow,
		PopoverPanel,
		SearchField,
		SectionCard,
		SegmentedControl,
		Table
	} from '$lib/components/ui';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { TableColumn, TableSort } from '$lib/components/ui/Table.svelte';
	import { apiFetch, toasts, user } from '$lib/stores';

	interface MemberProject {
		projectMemberId: string;
		id: string;
		name: string;
		slug: string;
		role: string;
	}

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		status?: 'active' | 'disabled';
		source?: 'invite' | 'sso' | 'scim' | 'rule' | 'direct' | null;
		scimManaged?: boolean;
		projects?: MemberProject[];
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
			username?: string;
			homeOrganizationId?: string | null;
			linkedAccount?: { createdAt: string } | null;
		};
	}

	async function unlink(member: Member) {
		const res = await apiFetch(`/apiv1/organizations/${organizationId}/members/${member.id}/link`, {
			method: 'DELETE'
		}).catch(() => null);
		if (!res?.ok) {
			toasts.add({ title: "Couldn't unlink that account", color: 'error' });
			return;
		}
		member.user.linkedAccount = null;
		toasts.add({ title: 'Account unlinked', color: 'success' });
	}

	function memberDetail(member: Member): string {
		const parts = [member.user.email];
		if (member.user.homeOrganizationId) {
			parts.push(
				member.source === 'scim' || member.scimManaged ? 'From SCIM' : 'From single sign-on'
			);
			if (member.user.linkedAccount) parts.push('Linked to an Orchard account');
		}
		if (member.status === 'disabled') parts.push('Access turned off');
		return parts.join(' · ');
	}

	interface Invitation {
		delivery?: 'email' | 'link';
		id: string;
		email: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		createdAt: string;
		expiresAt: string;
		inviter: {
			firstName?: string;
			lastName?: string;
			username?: string;
			email: string;
		};
	}

	let {
		members,
		invitations,
		canInvite,
		isOwner,
		newMemberEmail = $bindable(''),
		newMemberRole = $bindable<'member' | 'admin' | 'owner'>('member'),
		addingMember,
		resendingInvitationId,
		cancellingInvitationId,
		removingMemberId = null,
		organizationSlug = '',
		organizationId = '',
		revokingAccessId = null,
		onRevokeProjectAccess = undefined,
		onAddMember,
		onRemoveMember,
		onUpdateMemberRole,
		onResendInvitation,
		onCancelInvitation
	}: {
		members: Member[];
		invitations: Invitation[];
		canInvite: boolean;
		isOwner: boolean;
		newMemberEmail: string;
		newMemberRole: 'member' | 'admin' | 'owner';
		addingMember: boolean;
		resendingInvitationId: string | null;
		cancellingInvitationId: string | null;
		removingMemberId?: string | null;
		organizationSlug?: string;
		organizationId?: string;
		revokingAccessId?: string | null;
		onRevokeProjectAccess?: (projectId: string, projectMemberId: string) => void;
		onAddMember: () => void;
		onRemoveMember: (memberId: string) => void;
		onUpdateMemberRole: (memberId: string, role: 'owner' | 'admin' | 'member' | 'guest') => void;
		onResendInvitation: (id: string, email: string) => void;
		onCancelInvitation: (id: string) => void;
	} = $props();

	type OrgRole = 'member' | 'admin' | 'owner';
	type RoleFilter = 'all' | 'owner' | 'admin' | 'member' | 'guest';

	const uid = $props.id();

	const roleOptions: Array<{ value: OrgRole; label: string }> = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'owner', label: 'Owner' }
	];

	const guestOption = {
		value: 'guest',
		label: 'Guest',
		description: 'Only opens the projects they are added to'
	};

	function roleOptionsFor(member: Member) {
		return member.role === 'guest' || member.projects?.length
			? [...roleOptions, guestOption]
			: roleOptions;
	}

	const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

	const ROLE_TABS: Array<{ value: RoleFilter; label: string }> = [
		{ value: 'all', label: 'All' },
		{ value: 'owner', label: 'Owners' },
		{ value: 'admin', label: 'Admins' },
		{ value: 'member', label: 'Members' },
		{ value: 'guest', label: 'Guests' }
	];

	const COLUMNS = {
		member: 'minmax(0, 1fr)',
		access: '9.5rem',
		role: '8rem',
		actions: '5.75rem'
	};

	const memberColumns: TableColumn<Member>[] = [
		{
			id: 'member',
			label: 'Member',
			width: COLUMNS.member,
			sortable: true,
			sortValue: (m) => (memberName(m) || m.user.email).toLowerCase()
		},
		{ id: 'access', label: 'Access', width: COLUMNS.access },
		{
			id: 'role',
			label: 'Role',
			width: COLUMNS.role,
			sortable: true,
			sortValue: (m) => ROLE_ORDER[m.role]
		},
		{ id: 'actions', width: COLUMNS.actions, align: 'end' }
	];

	const inviteColumns: TableColumn<Invitation>[] = [
		{ id: 'member', width: COLUMNS.member },
		{ id: 'access', width: COLUMNS.access },
		{ id: 'role', width: COLUMNS.role },
		{ id: 'actions', width: COLUMNS.actions, align: 'end' }
	];

	let search = $state('');
	let roleFilter = $state<RoleFilter>('all');
	let sort = $state<TableSort | null>(null);

	function setRole(member: Member, role: string) {
		if (role !== member.role) onUpdateMemberRole(member.id, role as Member['role']);
	}

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}

	function memberName(m: Member) {
		return `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim() || m.user.username || '';
	}

	function shortDate(value: string) {
		return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	const roleCounts = $derived.by(() => {
		const c: Record<string, number> = { all: members.length };
		for (const m of members) c[m.role] = (c[m.role] ?? 0) + 1;
		return c;
	});

	const filterOptions = $derived(
		ROLE_TABS.filter((t) => t.value === 'all' || t.value === roleFilter || roleCounts[t.value])
	);

	const visibleMembers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return members
			.filter((m) => {
				if (roleFilter !== 'all' && m.role !== roleFilter) return false;
				if (!q) return true;
				return (
					memberName(m).toLowerCase().includes(q) ||
					m.user.email.toLowerCase().includes(q) ||
					(m.user.username ?? '').toLowerCase().includes(q)
				);
			})
			.sort(
				(a, b) =>
					ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || memberName(a).localeCompare(memberName(b))
			);
	});

	const hasAccessColumn = $derived(members.some((m) => m.role === 'member' || m.role === 'guest'));
</script>

<SectionCard title="Members" flush>
	{#snippet actions()}
		<div class="filters">
			<SegmentedControl
				label="Filter by role"
				size="sm"
				shape="capsule"
				options={filterOptions}
				bind:value={() => roleFilter, (v) => (roleFilter = v as RoleFilter)}
			/>
		</div>
		<div class="search">
			<SearchField size="sm" placeholder="Search members" bind:value={search} />
		</div>
		{#if canInvite}
			<PopoverPanel placement="bottom-end">
				{#snippet trigger(attrs)}
					<Button {...attrs} size="sm" shape="capsule" icon={UserPlus}>Invite</Button>
				{/snippet}
				{#snippet children({ close })}
					<form
						class="invite"
						onsubmit={(e) => {
							e.preventDefault();
							if (!newMemberEmail) return;
							onAddMember();
							close();
						}}
					>
						<Field label="Email" for="{uid}-email">
							<Input
								id="{uid}-email"
								type="email"
								placeholder="name@company.com"
								autocomplete="off"
								bind:value={newMemberEmail}
							/>
						</Field>
						<div class="invite-row">
							<div class="invite-role">
								<Dropdown
									bind:value={() => newMemberRole, (v) => (newMemberRole = v as OrgRole)}
									options={roleOptions}
									size="sm"
									ariaLabel="Role for the invite"
								/>
							</div>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={addingMember}
								disabled={!newMemberEmail}
							>
								Send invite
							</Button>
						</div>
					</form>
				{/snippet}
			</PopoverPanel>
		{/if}
	{/snippet}

	<Table
		columns={memberColumns}
		rows={visibleMembers}
		rowKey={(m) => m.user.id}
		bind:sort
		inset={false}
		label="Members"
		emptyText={search ? `Nobody matches “${search}”` : 'Nobody has this role'}
	>
		{#snippet cell(member, col)}
			{#if col.id === 'member'}
				<ItemLabel title={memberName(member) || member.user.email} detail={memberDetail(member)}>
					{#snippet leading()}
						<Avatar
							user={member.user}
							alive
							mood={member.user.id === $user?.id ? 'wink' : 'idle'}
							size={32}
						/>
					{/snippet}
				</ItemLabel>
			{:else if col.id === 'access'}
				{@const projects = member.projects ?? []}
				{#if member.role === 'owner' || member.role === 'admin'}
					<Tooltip text="Owners and admins can open every project">
						<span class="quiet">All projects</span>
					</Tooltip>
				{:else if projects.length > 0}
					<span class="pull">
						<PopoverPanel placement="bottom-start">
							{#snippet trigger(attrs, open)}
								<Button
									{...attrs}
									variant="ghost"
									size="sm"
									iconRight={ChevronDown}
									aria-expanded={open}
								>
									{projects.length}
									{projects.length === 1 ? 'project' : 'projects'}
								</Button>
							{/snippet}
							{#snippet children()}
								<div class="access">
									<List
										inset={false}
										label="Projects {memberName(member) || member.user.email} can open"
									>
										{#each projects as proj (proj.projectMemberId)}
											{#snippet revoke()}
												{#if canInvite}
													<Button
														variant="ghost"
														size="sm"
														loading={revokingAccessId === proj.projectMemberId}
														onclick={() => onRevokeProjectAccess?.(proj.id, proj.projectMemberId)}
													>
														Revoke
													</Button>
												{/if}
											{/snippet}
											<ListRow
												flush
												pinned
												title={proj.name}
												subtitle={formatRole(proj.role)}
												href={`/${organizationSlug}/projects/${proj.slug}`}
												actions={canInvite ? revoke : undefined}
											/>
										{/each}
									</List>
								</div>
							{/snippet}
						</PopoverPanel>
					</span>
				{:else if hasAccessColumn}
					<span class="faint">No projects</span>
				{/if}
			{:else if col.id === 'role'}
				{#if isOwner}
					<span class="pull">
						<Dropdown
							bind:value={() => member.role, (v) => setRole(member, v)}
							options={roleOptionsFor(member)}
							placement="bottom-start"
							ariaLabel="Role for {memberName(member) || member.user.email}"
						>
							{#snippet trigger(attrs, _open, selected)}
								<Button
									{...attrs}
									variant="ghost"
									size="sm"
									iconRight={ChevronsUpDown}
									aria-label="Role for {memberName(member) ||
										member.user.email}: {selected?.label ?? formatRole(member.role)}"
								>
									{selected?.label ?? formatRole(member.role)}
								</Button>
							{/snippet}
						</Dropdown>
					</span>
				{:else if member.role === 'guest'}
					<Tooltip text="Guests only open the projects they are added to">
						<Badge tone="warning">Guest</Badge>
					</Tooltip>
				{:else}
					<span class="quiet">{formatRole(member.role)}</span>
				{/if}
			{:else if canInvite && member.role !== 'owner'}
				{#if member.user.homeOrganizationId && member.user.linkedAccount}
					<Button
						variant="ghost"
						size="sm"
						icon={Unlink}
						label="Unlink the Orchard account from {memberName(member) || member.user.email}"
						disabled={removingMemberId !== null}
						onclick={() => unlink(member)}
					/>
				{/if}
				<Button
					variant="ghost"
					size="sm"
					icon={member.status === 'disabled' ? UserCheck : UserX}
					label="{member.status === 'disabled' ? 'Turn on' : 'Turn off'} access for {memberName(
						member
					) || member.user.email}"
					loading={removingMemberId === member.id}
					disabled={removingMemberId !== null}
					onclick={() => onRemoveMember(member.id)}
				/>
			{/if}
		{/snippet}
	</Table>
</SectionCard>

{#if canInvite && invitations.length > 0}
	<SectionCard title="Pending invitations" flush>
		<Table
			columns={inviteColumns}
			rows={invitations}
			rowKey={(inv) => inv.id}
			inset={false}
			label="Pending invitations"
		>
			{#snippet cell(invitation, col)}
				{#if col.id === 'member'}
					<ItemLabel
						title={invitation.email}
						detail="Invited {shortDate(invitation.createdAt)} · expires {shortDate(
							invitation.expiresAt
						)}"
					>
						{#snippet leading()}<Avatar seed={invitation.email} mood="sleepy" size={32} />{/snippet}
					</ItemLabel>
				{:else if col.id === 'role'}
					<span class="quiet">{formatRole(invitation.role)}</span>
				{:else if col.id === 'actions'}
					<span class="icons">
						<Button
							variant="ghost"
							size="sm"
							icon={invitation.delivery === 'link' ? Link2 : Mail}
							label={invitation.delivery === 'link'
								? `Create a new link for ${invitation.email}. The old link stops working`
								: `Resend the invitation to ${invitation.email}`}
							loading={resendingInvitationId === invitation.id}
							disabled={resendingInvitationId === invitation.id}
							onclick={() => onResendInvitation(invitation.id, invitation.email)}
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={X}
							label="Cancel the invitation to {invitation.email}"
							loading={cancellingInvitationId === invitation.id}
							disabled={cancellingInvitationId === invitation.id}
							onclick={() => onCancelInvitation(invitation.id)}
						/>
					</span>
				{/if}
			{/snippet}
		</Table>
	</SectionCard>
{/if}

<style>
	.filters {
		display: flex;
	}
	.search {
		width: 13rem;
	}
	.invite {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: min(20rem, calc(100vw - 3rem));
		padding: 0.25rem;
	}
	.invite-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.invite-role {
		width: 7.5rem;
	}
	.name,
	.quiet,
	.faint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		white-space: nowrap;
	}
	.quiet {
		color: var(--text-muted);
	}
	.faint {
		color: var(--text-faint);
	}
	.pull {
		display: flex;
		margin-inline-start: -0.625rem;
	}
	.icons {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.access {
		width: min(20rem, calc(100vw - 3rem));
		padding: 0 0.5rem;
	}
	@media (max-width: 64rem) {
		.filters {
			display: none;
		}
	}
	@media (max-width: 40rem) {
		.search {
			width: 9rem;
		}
	}
</style>
