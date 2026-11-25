import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseInterceptors
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth } from '../auth/decorators';
import { ImageUpdatesService } from './image-updates.service';
import { ProjectAccessService } from './project-access.service';
import { RolloutPinInterceptor } from './rollout.controller';

function userData(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl
  };
}

@Auth()
@Controller('deployments')
export class ImageUpdatesController {
  constructor(
    private readonly projectAccess: ProjectAccessService,
    private readonly imageUpdates: ImageUpdatesService
  ) {}

  private async editor(id: string, req: any, action: string): Promise<string> {
    const { user, access } = await this.projectAccess.assertDeploymentView(
      id,
      req.user.sub,
      userData(req)
    );
    if (!access.canEdit) throw new ForbiddenException(`Your role doesn't allow you to ${action}`);
    return user.id;
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get(':id/image-update')
  async status(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, userData(req));
    return this.imageUpdates.status(id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(':id/image-update/check')
  async check(@Param('id') id: string, @Request() req) {
    await this.editor(id, req, 'check for image updates');
    return this.imageUpdates.checkNow(id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(':id/image-update')
  @UseInterceptors(RolloutPinInterceptor)
  async update(@Param('id') id: string, @Request() req) {
    const userId = await this.editor(id, req, 'update the image');
    return this.imageUpdates.updateNow(id, userId);
  }

  @Patch(':id/image-update')
  async setAutoUpdate(
    @Param('id') id: string,
    @Body() body: { autoUpdate: boolean },
    @Request() req
  ) {
    const userId = await this.editor(id, req, 'change image auto-update');
    return this.imageUpdates.setAutoUpdate(id, body?.autoUpdate, userId);
  }
}
