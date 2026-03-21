/**
 * Evidence Vault - AES-256-GCM encryption for sensitive data at rest.
 *
 * Key derived from machine ID + user identity.
 * Used for tool results, conversation logs, and memory entries with sensitive data.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { homedir, hostname } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

function deriveKey(salt: Buffer, passphrase?: string): Buffer {
  // Derive from machine identity if no passphrase provided
  const identity = passphrase ?? `${hostname()}:${homedir()}:8gent-vault`;
  return scryptSync(identity, salt, KEY_LENGTH);
}

export interface EncryptedBlob {
  /** Base64-encoded encrypted data */
  data: string;
  /** Base64-encoded IV */
  iv: string;
  /** Base64-encoded auth tag */
  tag: string;
  /** Base64-encoded salt for key derivation */
  salt: string;
  /** Algorithm identifier */
  alg: 'aes-256-gcm';
}

export class EvidenceVault {
  private passphrase?: string;

  constructor(passphrase?: string) {
    this.passphrase = passphrase;
  }

  /**
   * Encrypt a string to an EncryptedBlob.
   */
  encrypt(data: string): EncryptedBlob {
    const salt = randomBytes(SALT_LENGTH);
    const key = deriveKey(salt, this.passphrase);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(data, 'utf-8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      data: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      salt: salt.toString('base64'),
      alg: ALGORITHM,
    };
  }

  /**
   * Decrypt an EncryptedBlob back to a string.
   */
  decrypt(blob: EncryptedBlob): string {
    const salt = Buffer.from(blob.salt, 'base64');
    const key = deriveKey(salt, this.passphrase);
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const encrypted = Buffer.from(blob.data, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  }

  /**
   * Encrypt and return as a single base64 string (for storage in JSONL, etc.)
   */
  encryptToString(data: string): string {
    const blob = this.encrypt(data);
    return Buffer.from(JSON.stringify(blob)).toString('base64');
  }

  /**
   * Decrypt from a single base64 string.
   */
  decryptFromString(encoded: string): string {
    const blob = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) as EncryptedBlob;
    return this.decrypt(blob);
  }
}
