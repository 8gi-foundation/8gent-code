/**
 * Validate and classify IP addresses (IPv4 and IPv6)
 */
export class IPValidator {
  /**
   * Check if string is valid IPv4
   * @param str - Input string
   * @returns True if valid IPv4
   */
  static isIPv4(str: string): boolean {
    const parts = str.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
      const n = parseInt(p, 10);
      return !isNaN(n) && n >= 0 && n <= 255 && p === n.toString();
    });
  }

  /**
   * Check if string is valid IPv6
   * @param str - Input string
   * @returns True if valid IPv6
   */
  static isIPv6(str: string): boolean {
    const segs = str.split(':');
    if (segs.length > 8) return false;
    if (str.includes('::')) {
      const gaps = str.split('::').length - 1;
      const expanded = segs.map(s => s || '0').join(':');
      return expanded.split(':').length === 8;
    }
    return segs.every(s => /^[0-9a-fA-F]{1,4}$/.test(s));
  }

  /**
   * Check if IP is private (RFC 1918 or fc00::/7)
   * @param ip - IP address
   * @returns True if private
   */
  static isPrivate(ip: string): boolean {
    if (this.isIPv4(ip)) {
      const [a] = ip.split('.').map(Number);
      return [10, 172].includes(a) || (a === 192 && parseInt(ip.split('.')[1], 10) >= 16);
    }
    if (this.isIPv6(ip)) {
      const normalized = this.normalize(ip);
      return normalized.startsWith('fc00') && normalized.split(':').length === 8;
    }
    return false;
  }

  /**
   * Expand IPv6 shorthand
   * @param ip - IPv6 address
   * @returns Normalized IPv6
   */
  static normalize(ip: string): string {
    if (this.isIPv4(ip)) return ip;
    let [left, right] = ip.split('::');
    const gaps = left ? left.split(':').length : 0;
    const zeros = Array(8 - gaps).fill('0').join(':');
    return left ? `${left}:${zeros}${right ? `:${right}` : ''}` : zeros;
  }

  /**
   * Check if IP is loopback (127.x.x.x or ::1)
   * @param ip - IP address
   * @returns True if loopback
   */
  static isLoopback(ip: string): boolean {
    if (this.isIPv4(ip)) {
      const [a] = ip.split('.').map(Number);
      return a === 127;
    }
    if (this.isIPv6(ip)) {
      const normalized = this.normalize(ip);
      return normalized === '::1';
    }
    return false;
  }
}