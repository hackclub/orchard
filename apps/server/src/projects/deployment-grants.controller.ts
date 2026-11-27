import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Request
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { UsersService } from '../users/users.service';
import { DeploymentGrantsService } from './deployment-grants.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Auth()
@Controller('deployments')
export class DeploymentGrantsController {
  constructor(
    private readonly grants: DeploymentGrantsService,
    private readonly users: UsersService
  ) {}

  private async actor(req: any) {
    const user = await this.users.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return user;
  }

  @Get(':id/access')
  async list(@Param('id') id: string, @Request() req) {
    const user = await this.actor(req);
    return this.grants.list(id, user.id);
  }

  @Post(':id/access')
  async grant(
    @Param('id') id: string,
    @Body() body: { email?: string; role?: string },
    @Request() req
  ) {
    const user = await this.actor(req);
    return this.grants.upsert(id, body?.email, body?.role, user.id, user.email ?? null);
  }

  @Delete(':id/access/:userId')
  async revoke(@Param('id') id: string, @Param('userId') userId: string, @Request() req) {
    if (!UUID_RE.test(userId)) throw new NotFoundException('Access not found');
    const user = await this.actor(req);
    await this.grants.remove(id, userId, user.id);
    return { ok: true };
  }
}
