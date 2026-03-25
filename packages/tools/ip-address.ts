/**
 * Parse an IPv4 address string into octets.
 * @param str - IPv4 address string
 * @returns Object with valid flag and octets array
 */
function parseIPv4(str: string): { valid: boolean; octets: number[] } {
  const parts = str.split('.');
  if (parts.length !== 4) return { valid: false, octets: [] };
  const octets: number[] = [];
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return { valid: false, octets: [] };
    if (part.length > 1 && part.startsWith('0')) return { valid: false, octets: [] };
    octets.push(num);
  }
  return { valid: true, octets };
}

/**
 * Check if a string is a valid IPv4 address.
 * @param str - IPv4 address string
 * @returns True if valid
 */
function isValidIPv4(str: string): boolean {
  return parseIPv4(str).valid;
}

/**
 * Check if a string is a valid IPv6 address.
 * @param str - IPv6 address string
 * @returns True if valid
 */
function isValidIPv6(str: string): boolean {
  const groups = str.split(':');
  const compressed = str.includes(':');
  if (compressed) {
    const compressedGroups = groups.filter(g => g !== '');
    if (compressedGroups.length > 8) return false;
  } else {
    if (groups.length !== 8) return false;
  }
  for (const group of groups) {
    if (group && !/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
  }
  return true;
}

/**
 * Convert IPv4 address to a 32-bit integer.
 * @param ip - IPv4 address string
 * @returns 32-bit integer
 */
function ipToLong(ip: string): number {
  const { octets } = parseIPv4(ip);
  if (!octets.length) return 0;
  return (
    (octets[0] << 24) |
    (octets[1] << 16) |
    (octets[2] << 8) |
    octets[3]
  );
}

/**
 * Convert a 32-bit integer back to an IPv4 address.
 * @param n - 32-bit integer
 * @returns IPv4 address string
 */
function longToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join('.');
}

/**
 * Expand IPv6 shorthand to full form.
 * @param str - IPv6 address string
 * @returns Expanded IPv6 address
 */
function expandIPv6(str: string): string {
  const groups = str.split(':');
  const compressedIndex = groups.indexOf('');
  if (compressedIndex === -1) return str;
  const totalGroups = groups.filter(g => g !== '').length;
  const missingGroups = 8 - totalGroups;
  const expandedGroups = [];
  for (let i = 0; i < 8; i++) {
    if (i === compressedIndex) {
      for (let j = 0; j < missingGroups; j++) expandedGroups.push('0');
    } else {
      expandedGroups.push(groups[i] || '0');
    }
  }
  return expandedGroups.join(':');
}

/**
 * Check if an IP address is within a CIDR range.
 * @param ip - IP address string
 * @param cidr - CIDR notation (e.g., '192.168.1.0/24')
 * @returns True if IP is within CIDR
 */
function inCIDR(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
  if (network.includes('.')) {
    const ipLong = ipToLong(ip);
    const networkLong = ipToLong(network);
    const mask = (~0 << (32 - prefix)) >>> 0;
    return (ipLong & mask) === (networkLong & mask);
  } else {
    const expandedNetwork = expandIPv6(network);
    const expandedIP = expandIPv6(ip);
    const networkBigInt = ipv6ToBigInt(expandedNetwork);
    const ipBigInt = ipv6ToBigInt(expandedIP);
    const maskBigInt = (BigInt(0xFFFFFFFFFFFFFFFF) << (128 - prefix)) >>> 0;
    return (ipBigInt & maskBigInt) === (networkBigInt & maskBigInt);
  }
}

/**
 * Convert expanded IPv6 address to BigInt.
 * @param ip - Expanded IPv6 address string
 * @returns BigInt representation
 */
function ipv6ToBigInt(ip: string): bigint {
  const groups = ip.split(':');
  let result = BigInt(0);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group) continue;
    const num = BigInt(parseInt(group, 16));
    result |= (num << BigInt(16 * (7 - i))) & BigInt(0xFFFFFFFFFFFF);
  }
  return result;
}

export {
  parseIPv4,
  isValidIPv4,
  isValidIPv6,
  ipToLong,
  longToIp,
  inCIDR,
  expandIPv6,
};