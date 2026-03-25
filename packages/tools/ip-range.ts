/**
 * IP address range operations.
 * Supports CIDR notation and start/end ranges.
 * IPv4 only.
 */

function ipToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function numToIp(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join(".");
}

export class IpRange {
  private readonly startNum: number;
  private readonly endNum: number;

  constructor(startNum: number, endNum: number) {
    if (startNum > endNum) {
      throw new Error(`Start IP must be <= end IP`);
    }
    this.startNum = startNum >>> 0;
    this.endNum = endNum >>> 0;
  }

  /** First IP in range */
  first(): string {
    return numToIp(this.startNum);
  }

  /** Last IP in range */
  last(): string {
    return numToIp(this.endNum);
  }

  /** Number of IPs in range */
  count(): number {
    return this.endNum - this.startNum + 1;
  }

  /** Check if a given IP is within this range */
  contains(ip: string): boolean {
    const n = ipToNum(ip);
    return n >= this.startNum && n <= this.endNum;
  }

  /**
   * Expand all IPs in range into an array.
   * Capped at 65536 to avoid accidental memory exhaustion.
   */
  expand(limit = 65536): string[] {
    const total = this.count();
    const cap = Math.min(total, limit);
    const result: string[] = [];
    for (let i = 0; i < cap; i++) {
      result.push(numToIp(this.startNum + i));
    }
    return result;
  }

  /** Check whether this range overlaps with another */
  overlap(other: IpRange): boolean {
    return this.startNum <= other.endNum && this.endNum >= other.startNum;
  }

  /**
   * Merge this range with another, returning the union.
   * Throws if the ranges do not overlap or are not adjacent.
   */
  merge(other: IpRange): IpRange {
    if (!this.overlap(other) && Math.abs(this.endNum - other.startNum) > 1 && Math.abs(other.endNum - this.startNum) > 1) {
      throw new Error(`Ranges do not overlap or are not adjacent - cannot merge`);
    }
    const start = Math.min(this.startNum, other.startNum);
    const end = Math.max(this.endNum, other.endNum);
    return new IpRange(start, end);
  }

  toString(): string {
    return `${this.first()}-${this.last()} (${this.count()} IPs)`;
  }
}

/**
 * Create an IpRange from CIDR notation, e.g. "192.168.1.0/24".
 */
export function fromCIDR(cidr: string): IpRange {
  const [ip, prefixStr] = cidr.split("/");
  if (!ip || prefixStr === undefined) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix length: ${prefixStr}`);
  }
  const baseNum = ipToNum(ip);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const startNum = (baseNum & mask) >>> 0;
  const endNum = (startNum | ~mask) >>> 0;
  return new IpRange(startNum, endNum);
}

/**
 * Create an IpRange from a start and end IP address string.
 */
export function fromRange(start: string, end: string): IpRange {
  return new IpRange(ipToNum(start), ipToNum(end));
}
