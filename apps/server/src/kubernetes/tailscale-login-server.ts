import { BadRequestException } from '@nestjs/common';

const MAX_LENGTH = 255;

export function normalizeLoginServer(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new BadRequestException('Login server must be a URL.');
  }
  const value = raw.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(
      'Login server must be a URL, such as https://headscale.example.com.'
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('Login server must start with https:// or http://.');
  }
  if (url.username || url.password) {
    throw new BadRequestException("Login server can't include a username or password.");
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new BadRequestException(
      'Login server must be the base URL of the server, with no path or query.'
    );
  }
  if (url.port === '0') {
    throw new BadRequestException('Login server port must be between 1 and 65535.');
  }
  if (url.origin.length > MAX_LENGTH) {
    throw new BadRequestException('Login server is too long.');
  }
  return url.origin;
}

export function loginServerHost(loginServer: string): string {
  return new URL(loginServer).host;
}

export function loginServerPort(loginServer: string): number {
  const url = new URL(loginServer);
  if (url.port) return Number(url.port);
  return url.protocol === 'http:' ? 80 : 443;
}

export function loginServerArgs(loginServer: string): string {
  return `--login-server=${loginServer}`;
}
