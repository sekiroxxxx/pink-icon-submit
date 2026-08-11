import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { AppError } from './errors.js';
import { BatchDatabase } from './database.js';
import type { AuthenticatedUser, BootstrapUserCredentials } from './types.js';

const scrypt = promisify(scryptCallback);
const scryptKeyLength = 64;
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

export const sessionCookieName = 'pink_icon_submit_session';
export const sessionMaxAgeSeconds = Math.floor(sessionLifetimeMs / 1_000);

interface PasswordHash {
  salt: Buffer;
  derivedKey: Buffer;
}

function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function encodedPasswordHash(salt: Buffer, derivedKey: Buffer): string {
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function parsePasswordHash(value: string): PasswordHash | undefined {
  const [algorithm, salt, derivedKey, extra] = value.split('$');
  if (algorithm !== 'scrypt' || !salt || !derivedKey || extra !== undefined) return undefined;
  try {
    const parsed = { salt: Buffer.from(salt, 'base64url'), derivedKey: Buffer.from(derivedKey, 'base64url') };
    return parsed.salt.length > 0 && parsed.derivedKey.length === scryptKeyLength ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function passwordHash(password: string, salt = randomBytes(16)): Promise<string> {
  const derivedKey = await scrypt(password, salt, scryptKeyLength) as Buffer;
  return encodedPasswordHash(salt, derivedKey);
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const derivedKey = await scrypt(password, parsed.salt, scryptKeyLength) as Buffer;
  return timingSafeEqual(derivedKey, parsed.derivedKey);
}

function usernameFrom(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('LOGIN_INVALID', '账号或密码不正确。', 401);
  const username = value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(username) || username.length > 320) {
    throw new AppError('LOGIN_INVALID', '账号或密码不正确。', 401);
  }
  return username;
}

function passwordFrom(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw new AppError('LOGIN_INVALID', '账号或密码不正确。', 401);
  }
  return value;
}

function expiresAt(): string {
  return new Date(Date.now() + sessionLifetimeMs).toISOString();
}

/**
 * Authentication owns password derivation and browser-session token handling.
 * The database only receives password hashes and SHA-256 session-token hashes.
 */
export class AuthService {
  constructor(private readonly database: BatchDatabase) {}

  async provisionBootstrapUser(credentials: BootstrapUserCredentials): Promise<AuthenticatedUser> {
    const username = usernameFrom(credentials.username);
    const password = passwordFrom(credentials.password);
    const existing = this.database.findUserByUsername(username);
    if (existing) {
      // Migration 5 intentionally creates the retained legacy owner as disabled.
      // It can only become sign-in capable through an explicit bootstrap secret.
      if (existing.passwordHash === 'disabled') {
        this.database.updateUserPasswordHash(existing.id, await passwordHash(password));
      }
      return { id: existing.id, username: existing.username };
    }
    return this.database.createUser({ id: randomUUID(), username, passwordHash: await passwordHash(password) });
  }

  async login(input: unknown): Promise<{ user: AuthenticatedUser; token: string }> {
    const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const username = usernameFrom(record.username);
    const password = passwordFrom(record.password);
    const user = this.database.findUserByUsername(username);
    if (!user || !await passwordMatches(password, user.passwordHash)) {
      throw new AppError('LOGIN_INVALID', '账号或密码不正确。', 401);
    }
    const token = randomBytes(32).toString('base64url');
    this.database.createSession({ tokenHash: sessionTokenHash(token), userId: user.id, expiresAt: expiresAt() });
    return { user: { id: user.id, username: user.username }, token };
  }

  authenticate(token: string | undefined): AuthenticatedUser | undefined {
    if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return undefined;
    return this.database.findSessionUser(sessionTokenHash(token), new Date().toISOString()) ?? undefined;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.database.deleteSession(sessionTokenHash(token));
  }
}
