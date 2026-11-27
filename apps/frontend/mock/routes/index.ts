import type { MockContext } from '../plugin.ts';
import type { Router } from '../router.ts';
import { adminOrgRoutes } from './admin-orgs.ts';
import { adminPeopleRoutes } from './admin-people.ts';
import { adminSystemRoutes } from './admin-system.ts';
import { databaseRoutes } from './databases.ts';
import { deploymentRoutes } from './deployments.ts';
import { fastBuilderRoutes } from './fast-builder.ts';
import { gitRoutes } from './git.ts';
import { podFileRoutes } from './pod-files.ts';
import { jobRoutes } from './jobs.ts';
import { projectRoutes } from './projects.ts';
import { recoveryRoutes } from './recovery.ts';
import { versionRoutes } from './versions.ts';
import { securityRoutes } from './security.ts';
import { settingsRoutes } from './settings.ts';
import { shellRoutes } from './shell.ts';

export function registerRoutes(router: Router, ctx: MockContext) {
	adminSystemRoutes(router, ctx);
	shellRoutes(router, ctx);
	adminOrgRoutes(router, ctx);
	deploymentRoutes(router, ctx);
	podFileRoutes(router, ctx);
	projectRoutes(router, ctx);
	databaseRoutes(router, ctx);
	recoveryRoutes(router, ctx);
	versionRoutes(router, ctx);
	jobRoutes(router, ctx);
	securityRoutes(router, ctx);
	settingsRoutes(router, ctx);
	fastBuilderRoutes(router, ctx);
	gitRoutes(router, ctx);
	adminPeopleRoutes(router, ctx);
}
