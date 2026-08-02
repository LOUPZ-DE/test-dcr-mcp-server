import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';

const COOKIE_NAME = 'mcp_session';

function sign(payload: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(payload).digest('base64url');
}

/**
 * Dependency-free signiertes Session-Cookie:
 * Wert = base64url(email) + '.' + exp + '.' + HMAC(email + '.' + exp)
 */
export function setSession(res: Response, email: string): void {
  const exp = Math.floor(Date.now() / 1000) + config.REFRESH_TOKEN_TTL;
  const payload = `${Buffer.from(email, 'utf8').toString('base64url')}.${exp}`;
  const value = `${payload}.${sign(payload)}`;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${config.REFRESH_TOKEN_TTL}`,
  ];
  // Secure nur bei HTTPS — sonst würde der Browser das Cookie im lokalen HTTP-Dev verwerfen.
  if (config.isHttps) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function getSession(req: Request): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    const lastDot = value.lastIndexOf('.');
    if (lastDot === -1) return undefined;
    const payload = value.slice(0, lastDot);
    const sig = value.slice(lastDot + 1);
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    const [emailB64, expStr] = payload.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return undefined;
    try {
      return Buffer.from(emailB64, 'base64url').toString('utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}
