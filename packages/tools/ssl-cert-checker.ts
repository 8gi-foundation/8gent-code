import * as crypto from 'crypto';

/**
 * Parses certificate info from PEM string.
 * @param pemString - PEM encoded certificate
 * @returns Certificate details
 */
export function parseCertInfo(pemString: string): { subject: string; issuer: string; validFrom: string; validTo: string; sans: string[]; serial: string } {
  const pem = pemString.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '');
  const cert = crypto.createCertificate().update(Buffer.from(pem, 'base64')).final();
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    sans: cert.sans || [],
    serial: cert.serial
  };
}

/**
 * Calculates days until certificate expiry.
 * @param cert - Certificate object
 * @returns Days remaining
 */
export function daysUntilExpiry(cert: { validTo: string }): number {
  const validToDate = new Date(cert.validTo.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  const now = new Date();
  const diffTime = validToDate.getTime() - now.getTime();
  return diffTime < 0 ? 0 : Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Checks if certificate is expired.
 * @param cert - Certificate object
 * @returns True if expired
 */
export function isExpired(cert: { validTo: string }): boolean {
  return daysUntilExpiry(cert) <= 0;
}

/**
 * Validates certificate chain is unbroken.
 * @param certs - Array of certificate objects
 * @returns True if chain is valid
 */
export function checkChain(certs: { issuer: string; subject: string }[]): boolean {
  for (let i = 0; i < certs.length - 1; i++) {
    if (certs[i].issuer !== certs[i + 1].subject) {
      return false;
    }
  }
  return true;
}

/**
 * Renders formatted certificate summary.
 * @param cert - Certificate object
 * @returns Formatted summary
 */
export function renderSummary(cert: { subject: string; issuer: string; validFrom: string; validTo: string; sans: string[]; serial: string }): string {
  return `Subject: ${cert.subject}\nIssuer: ${cert.issuer}\nValid From: ${cert.validFrom}\nValid To: ${cert.validTo}\nSANs: ${cert.sans.join(', ')}\nSerial: ${cert.serial}`;
}