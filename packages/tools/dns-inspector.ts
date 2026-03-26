import * as dns from 'dns/promises';

/**
 * DNS record with type, TTL, and data
 */
type DNSRecord = {
  type: string;
  ttl: number;
  data: string;
};

/**
 * Fetch DNS records of a specific type
 * @param domain Domain name
 * @param type Record type (A, AAAA, MX, etc.)
 * @returns Array of DNS records
 */
export async function lookup(domain: string, type: string): Promise<DNSRecord[]> {
  try {
    const records = await dns.resolve(domain, type);
    return records.map((r) => ({
      type,
      ttl: 0,
      data: typeof r === 'string' ? r : JSON.stringify(r),
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch all common DNS records in parallel
 * @param domain Domain name
 * @returns Object mapping record types to arrays of DNS records
 */
export async function lookupAll(domain: string): Promise<Record<string, DNSRecord[]>> {
  const types = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'];
  const results = await Promise.all(types.map((t) => lookup(domain, t)));
  return types.reduce((acc, t, i) => {
    acc[t] = results[i];
    return acc;
  }, {} as Record<string, DNSRecord[]>);
}

/**
 * Parse SPF policy from TXT records
 * @param domain Domain name
 * @returns SPF policy string or null
 */
export async function checkSPF(domain: string): Promise<string | null> {
  const txtRecords = await lookup(domain, 'TXT');
  return txtRecords.find((r) => r.data.startsWith('v=spf1'))?.data || null;
}

/**
 * Parse DMARC policy from _dmarc TXT record
 * @param domain Domain name
 * @returns DMARC policy string or null
 */
export async function checkDMARC(domain: string): Promise<string | null> {
  const dmarcDomain = `_dmarc.${domain}`;
  const txtRecords = await lookup(dmarcDomain, 'TXT');
  return txtRecords.find((r) => r.data.startsWith('v=DMARC1'))?.data || null;
}

/**
 * Generate formatted DNS audit table
 * @param results DNS record lookup results
 * @returns Formatted audit report as string
 */
export function renderReport(results: Record<string, DNSRecord[]>): string {
  let report = 'DNS Audit Report\nType | TTL | Data\n--- | --- | ---\n';
  for (const [type, records] of Object.entries(results)) {
    for (const record of records) {
      report += `${record.type} | ${record.ttl} | ${record.data}\n`;
    }
  }
  const spf = results['TXT'].find((r) => r.data.startsWith('v=spf1'))?.data || 'N/A';
  const dmarc = results['_dmarc.' + Object.keys(results)[0]]?.['TXT']?.find((r) => r.data.startsWith('v=DMARC1'))?.data || 'N/A';
  report += `SPF | - | ${spf}\nDMARC | - | ${dmarc}`;
  return report;
}