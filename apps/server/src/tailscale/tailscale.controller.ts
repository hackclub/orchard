import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  Body,
  NotFoundException,
  ForbiddenException
} from '@nestjs/common';
import { TailscaleService } from './tailscale.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('tailscale')
export class TailscaleController {
  constructor(
    private readonly tailscaleService: TailscaleService,
    private readonly usersService: UsersService,
    private readonly authz: AuthorizationService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService
  ) {}

  private async requireTailscaleFeature(userId: string): Promise<void> {
    const enabled = await this.analytics.isEarlyAccessEnabled('tailscale-integration', userId);
    if (!enabled) {
      throw new ForbiddenException(
        "Tailscale isn't on for your account. Turn it on in Early access."
      );
    }
  }

  private async resolveDeploymentForEdit(deploymentId: string, userId: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true }
    });
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    return this.authz.requireProjectEdit(dep.projectId, userId, 'manage tailscale exposure');
  }

  private async resolveDeploymentForView(deploymentId: string, userId: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true }
    });
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    return this.authz.requireProjectView(dep.projectId, userId);
  }

  @Get('status')
  async getStatus(@Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    return this.tailscaleService.getStatus(user.id);
  }

  @Post('link')
  async linkAccount(@Req() req: any, @Body() body: { apiKey: string; loginServer?: string }) {
    if (!body.apiKey || typeof body.apiKey !== 'string') {
      throw new Error('API key is required');
    }
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    return this.tailscaleService.linkAccount(user.id, body.apiKey.trim(), body.loginServer);
  }

  @Delete('unlink')
  async unlinkAccount(@Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    await this.tailscaleService.unlinkAccount(user.id);
    return { success: true };
  }

  @Get('deployment/:deploymentId')
  async getDeploymentStatus(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    await this.resolveDeploymentForView(deploymentId, user.id);
    return this.tailscaleService.getDeploymentTailscaleStatus(deploymentId);
  }

  @Post('expose/:deploymentId')
  async exposeDeployment(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    await this.resolveDeploymentForEdit(deploymentId, user.id);
    return this.tailscaleService.exposeDeployment(deploymentId, user.id);
  }

  @Post('unexpose/:deploymentId')
  async unexposeDeployment(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email
    });
    await this.requireTailscaleFeature(user.id);
    await this.resolveDeploymentForEdit(deploymentId, user.id);
    await this.tailscaleService.unexposeDeployment(deploymentId, user.id);
    return { success: true };
  }
}
