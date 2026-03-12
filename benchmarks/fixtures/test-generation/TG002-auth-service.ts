/**
 * Fixture: TG002 - Generate Tests for Auth Service
 *
 * Task: Generate comprehensive test suite for this authentication module
 * Requirements:
 * - Unit tests for all public methods
 * - Integration tests for auth flows
 * - Security-focused test cases
 * - Mock external dependencies
 * - Test error handling paths
 */

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  salt: string;
  roles: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  lastLogin?: Date;
  failedAttempts: number;
  lockedUntil?: Date;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  ipAddress: string;
  userAgent: string;
}

export interface AuthResult {
  success: boolean;
  user?: Omit<User, "passwordHash" | "salt" | "mfaSecret">;
  session?: Session;
  error?: string;
  requiresMfa?: boolean;
}

// Simulated database
const users = new Map<string, User>();
const sessions = new Map<string, Session>();

// Configuration
const config = {
  maxFailedAttempts: 5,
  lockoutDuration: 15 * 60 * 1000, // 15 minutes
  sessionDuration: 24 * 60 * 60 * 1000, // 24 hours
  tokenLength: 64,
};

// Utility functions
function hashPassword(password: string, salt: string): string {
  // Simulated hashing - in production use bcrypt/argon2
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(password + salt).digest("hex");
}

function generateToken(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function generateSalt(): string {
  return generateToken(16);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

// Auth Service
export function register(email: string, password: string): AuthResult {
  if (!isValidEmail(email)) {
    return { success: false, error: "Invalid email format" };
  }

  if (!isStrongPassword(password)) {
    return {
      success: false,
      error: "Password must be at least 8 characters with uppercase, lowercase, number, and special character",
    };
  }

  // Check if user exists
  for (const user of users.values()) {
    if (user.email.toLowerCase() === email.toLowerCase()) {
      return { success: false, error: "Email already registered" };
    }
  }

  const salt = generateSalt();
  const user: User = {
    id: generateToken(12),
    email: email.toLowerCase(),
    passwordHash: hashPassword(password, salt),
    salt,
    roles: ["user"],
    mfaEnabled: false,
    failedAttempts: 0,
  };

  users.set(user.id, user);

  return {
    success: true,
    user: {
      id: user.id,
      email: user.email,
      roles: user.roles,
      mfaEnabled: user.mfaEnabled,
      failedAttempts: user.failedAttempts,
    },
  };
}

export function login(email: string, password: string, ipAddress: string, userAgent: string): AuthResult {
  // Find user
  let foundUser: User | undefined;
  for (const user of users.values()) {
    if (user.email.toLowerCase() === email.toLowerCase()) {
      foundUser = user;
      break;
    }
  }

  if (!foundUser) {
    return { success: false, error: "Invalid email or password" };
  }

  // Check lockout
  if (foundUser.lockedUntil && foundUser.lockedUntil > new Date()) {
    const remainingMinutes = Math.ceil((foundUser.lockedUntil.getTime() - Date.now()) / 60000);
    return { success: false, error: `Account locked. Try again in ${remainingMinutes} minutes` };
  }

  // Verify password
  const passwordHash = hashPassword(password, foundUser.salt);
  if (passwordHash !== foundUser.passwordHash) {
    foundUser.failedAttempts++;

    if (foundUser.failedAttempts >= config.maxFailedAttempts) {
      foundUser.lockedUntil = new Date(Date.now() + config.lockoutDuration);
    }

    return { success: false, error: "Invalid email or password" };
  }

  // Reset failed attempts
  foundUser.failedAttempts = 0;
  foundUser.lockedUntil = undefined;

  // Check MFA
  if (foundUser.mfaEnabled) {
    return { success: false, requiresMfa: true };
  }

  // Create session
  const session: Session = {
    id: generateToken(12),
    userId: foundUser.id,
    token: generateToken(config.tokenLength),
    expiresAt: new Date(Date.now() + config.sessionDuration),
    createdAt: new Date(),
    ipAddress,
    userAgent,
  };

  sessions.set(session.token, session);
  foundUser.lastLogin = new Date();

  return {
    success: true,
    user: {
      id: foundUser.id,
      email: foundUser.email,
      roles: foundUser.roles,
      mfaEnabled: foundUser.mfaEnabled,
      lastLogin: foundUser.lastLogin,
      failedAttempts: foundUser.failedAttempts,
    },
    session,
  };
}

export function validateSession(token: string): AuthResult {
  const session = sessions.get(token);

  if (!session) {
    return { success: false, error: "Invalid session" };
  }

  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return { success: false, error: "Session expired" };
  }

  const user = users.get(session.userId);
  if (!user) {
    sessions.delete(token);
    return { success: false, error: "User not found" };
  }

  return {
    success: true,
    user: {
      id: user.id,
      email: user.email,
      roles: user.roles,
      mfaEnabled: user.mfaEnabled,
      lastLogin: user.lastLogin,
      failedAttempts: user.failedAttempts,
    },
    session,
  };
}

export function logout(token: string): boolean {
  return sessions.delete(token);
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): AuthResult {
  const user = users.get(userId);

  if (!user) {
    return { success: false, error: "User not found" };
  }

  const currentHash = hashPassword(currentPassword, user.salt);
  if (currentHash !== user.passwordHash) {
    return { success: false, error: "Current password is incorrect" };
  }

  if (!isStrongPassword(newPassword)) {
    return { success: false, error: "New password does not meet requirements" };
  }

  const newSalt = generateSalt();
  user.salt = newSalt;
  user.passwordHash = hashPassword(newPassword, newSalt);

  // Invalidate all sessions
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) {
      sessions.delete(token);
    }
  }

  return { success: true };
}

export function enableMfa(userId: string): { success: boolean; secret?: string; error?: string } {
  const user = users.get(userId);

  if (!user) {
    return { success: false, error: "User not found" };
  }

  if (user.mfaEnabled) {
    return { success: false, error: "MFA already enabled" };
  }

  const secret = generateToken(32);
  user.mfaSecret = secret;
  user.mfaEnabled = true;

  return { success: true, secret };
}

// Reset for testing
export function resetForTesting(): void {
  users.clear();
  sessions.clear();
}
