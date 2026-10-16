
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SALT_ROUNDS = 12;
const AUTH_COOKIE_NAME = 'BillMint_token';
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export interface JwtPayload {
  userId: string;
  businessId: string;
  memberId: string;
  role: string;
  isOwner: boolean;
}

/**
 * Retrieve the JWT secret safely.
 *
 * Production must never use a hardcoded fallback secret.
 * Development may use the fallback for local work only.
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FATAL: JWT_SECRET must be configured in production.',
      );
    }

    return 'dev-secret-change-in-production';
  }

  if (
    process.env.NODE_ENV === 'production' &&
    secret.length < 32
  ) {
    throw new Error(
      'FATAL: JWT_SECRET must be at least 32 characters in production.',
    );
  }

  return secret;
}

/**
 * Hash a password before storing it.
 */
export async function hashPassword(
  password: string,
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password is required.');
  }

  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a supplied password with its stored hash.
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    typeof hash !== 'string' ||
    password.length === 0 ||
    hash.length === 0
  ) {
    return false;
  }

  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * Sign a JWT using the configured secret.
 */
export function signToken(payload: JwtPayload): string {
  if (
    !payload ||
    !payload.userId ||
    !payload.businessId ||
    !payload.memberId ||
    !payload.role ||
    typeof payload.isOwner !== 'boolean'
  ) {
    throw new Error('Invalid authentication payload.');
  }

  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Verify a JWT signature and expiry.
 *
 * jsonwebtoken throws for invalid, expired, or malformed tokens.
 * The authentication middleware should handle those errors and
 * return HTTP 401 without exposing internal error details.
 */
export function verifyToken(token: string): JwtPayload {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Authentication token is required.');
  }

  const decoded = jwt.verify(token, getJwtSecret());

  if (
    typeof decoded === 'string' ||
    !decoded ||
    typeof decoded !== 'object' ||
    typeof decoded.userId !== 'string' ||
    typeof decoded.businessId !== 'string' ||
    typeof decoded.memberId !== 'string' ||
    typeof decoded.role !== 'string' ||
    typeof decoded.isOwner !== 'boolean'
  ) {
    throw new Error('Invalid authentication token payload.');
  }

  return {
    userId: decoded.userId,
    businessId: decoded.businessId,
    memberId: decoded.memberId,
    role: decoded.role,
    isOwner: decoded.isOwner,
  };
}

/**
 * Set the HTTP-only authentication cookie.
 */
export function setAuthCookie(
  res: Response,
  token: string,
): void {
  const isProd = process.env.NODE_ENV === 'production';

  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: AUTH_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * Clear the authentication cookie.
 *
 * Cookie path and relevant attributes must match those used
 * when the cookie was originally set.
 */
export function clearAuthCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';

  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/',
  });
}

/**
 * Validate password complexity.
 */
export function validatePasswordStrength(
  password: string,
): { valid: boolean; message?: string } {
  if (typeof password !== 'string' || password.length < 8) {
    return {
      valid: false,
      message: 'Password must be at least 8 characters',
    };
  }

  if (!/[A-Z]/.test(password)) {
    return {
      valid: false,
      message: 'Password must contain at least one uppercase letter',
    };
  }

  if (!/[a-z]/.test(password)) {
    return {
      valid: false,
      message: 'Password must contain at least one lowercase letter',
    };
  }

  if (!/[0-9]/.test(password)) {
    return {
      valid: false,
      message: 'Password must contain at least one number',
    };
  }

  return { valid: true };
}

/**
 * Validate a user ID.
 */
export function validateUserId(
  userId: string,
): { valid: boolean; message?: string } {
  if (typeof userId !== 'string' || userId.length < 3) {
    return {
      valid: false,
      message: 'User ID must be at least 3 characters',
    };
  }

  if (!/^[a-zA-Z0-9_]+$/.test(userId)) {
    return {
      valid: false,
      message:
        'User ID can only contain letters, numbers and underscore',
    };
  }

  return { valid: true };
}
