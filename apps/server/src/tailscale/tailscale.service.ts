import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { loginServerHost, normalizeLoginServer } from '../kubernetes/tailscale-login-server';

@Injectable()
export class TailscaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly crypto: SecretCryptoService
  ) {}

  /**
   * Link a user's Tailscale account using their reusable auth key.
   * Auth keys start with "tskey-auth-".
   */
  async linkAccount(
    userId: string,
    authKey: string,
    loginServerInput?: unknown
  ): Promise<{ tailnet: string; loginServer: string | null }> {
    const loginServer = normalizeLoginServer(loginServerInput);

    if (!loginServer && !authKey.startsWith('tskey-auth-')) {
      throw new BadRequestException(
        'Invalid key. Enter a Tailscale auth key (starts with tskey-auth-).'
      );
    }

    // We can't easily discover the tailnet from an auth key without registering a device,
    // so we store it and resolve the tailnet when the first sidecar comes online.
    // For display, extract the key ID portion.
    const tailnet = loginServer ? loginServerHost(loginServer) : `${authKey.slice(0, 20)}...`;

    await this.prisma.tailscaleConnection.upsert({
      where: { userId },
      create: {
        userId,
        accessToken: this.crypto.seal(authKey),
        tailnet,
        loginServer
      },
      update: {
        accessToken: this.crypto.seal(authKey),
        tailnet,
        loginServer
      }
    });

    return { tailnet, loginServer };
  }

  async unlinkAccount(userId: string): Promise<void> {
    // Remove all Tailscale sidecars for deployments this user exposed
    const exposedDeployments = await this.prisma.deployment.findMany({
      where: { tailscaleExposedBy: userId, tailscaleExposed: true },
      include: { services: true }
    });

    for (const deployment of exposedDeployments) {
      try {
        await this.k8sWorkload.removeTailscaleSidecar(deployment.namespace, deployment.name);
      } catch (error) {
        console.error(`[Tailscale] Failed to remove sidecar from ${deployment.name}:`, error);
      }
    }

    await this.prisma.deployment.updateMany({
      where: { tailscaleExposedBy: userId },
      data: {
        tailscaleExposed: false,
        tailscaleHostname: null,
        tailscaleExposedBy: null
      }
    });

    await this.prisma.tailscaleConnection.deleteMany({
      where: { userId }
    });
  }

  async getStatus(
    userId: string
  ): Promise<{ linked: boolean; tailnet?: string; loginServer?: string | null }> {
    const connection = await this.prisma.tailscaleConnection.findUnique({
      where: { userId }
    });

    if (!connection) {
      return { linked: false };
    }

    return {
      linked: true,
      tailnet: connection.tailnet,
      loginServer: connection.loginServer
    };
  }

  async getDeploymentTailscaleStatus(
    deploymentId: string
  ): Promise<{ exposed: boolean; ip: string | null; dns: string | null; hostname: string | null }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });

    if (!deployment || !deployment.tailscaleExposed) {
      return { exposed: false, ip: null, dns: null, hostname: null };
    }

    const status = await this.k8sWorkload.getTailscaleStatus(deployment.namespace, deployment.name);

    return {
      exposed: true,
      ip: status.ip,
      dns: status.dns,
      hostname: deployment.tailscaleHostname
    };
  }

  async exposeDeployment(deploymentId: string, userId: string): Promise<{ hostname: string }> {
    const connection = await this.prisma.tailscaleConnection.findUnique({
      where: { userId }
    });

    if (!connection) {
      throw new BadRequestException(
        'Tailscale account not connected. Connect it in Account settings first.'
      );
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: { organization: true }
        },
        services: true
      }
    });

    if (!deployment) {
      throw new NotFoundException('Deployment not found');
    }

    if (deployment.tailscaleExposed) {
      throw new BadRequestException('This app is already on Tailscale');
    }

    const hostname = `${deployment.name}-${deployment.namespace}`;

    const servicePorts = deployment.services.map((svc) => ({
      port: svc.port,
      targetPort: svc.targetPort,
      protocol: svc.protocol
    }));

    // Pass the user's auth key directly to the sidecar: it registers itself on their tailnet
    await this.k8sWorkload.addTailscaleSidecar(
      deployment.namespace,
      deployment.name,
      this.crypto.open(connection.accessToken),
      hostname,
      servicePorts,
      connection.loginServer
    );

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        tailscaleExposed: true,
        tailscaleHostname: hostname,
        tailscaleExposedBy: userId
      }
    });

    return { hostname };
  }

  async unexposeDeployment(deploymentId: string, _userId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });

    if (!deployment) {
      throw new NotFoundException('Deployment not found');
    }

    if (!deployment.tailscaleExposed) {
      throw new BadRequestException("This app isn't on Tailscale");
    }

    await this.k8sWorkload.removeTailscaleSidecar(deployment.namespace, deployment.name);

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        tailscaleExposed: false,
        tailscaleHostname: null,
        tailscaleExposedBy: null
      }
    });
  }

  async cleanupNamespace(namespace: string): Promise<void> {
    const deployments = await this.prisma.deployment.findMany({
      where: { namespace, tailscaleExposed: true }
    });

    for (const deployment of deployments) {
      try {
        await this.k8sWorkload.removeTailscaleSidecar(namespace, deployment.name);
      } catch (error) {
        console.error(`[Tailscale] Failed to remove sidecar for ${deployment.name}:`, error);
      }
    }

    await this.prisma.deployment.updateMany({
      where: { namespace, tailscaleExposed: true },
      data: {
        tailscaleExposed: false,
        tailscaleHostname: null,
        tailscaleExposedBy: null
      }
    });
  }

  async cleanupDeployment(deployment: {
    id: string;
    name: string;
    namespace: string;
    tailscaleExposed: boolean;
  }): Promise<void> {
    if (!deployment.tailscaleExposed) return;

    try {
      await this.k8sWorkload.removeTailscaleSidecar(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`[Tailscale] Failed to remove sidecar for ${deployment.name}:`, error);
    }
  }
}
