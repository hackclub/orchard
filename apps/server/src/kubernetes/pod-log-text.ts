export function podLogText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  try {
    return JSON.stringify(body) ?? '';
  } catch {
    return String(body);
  }
}
