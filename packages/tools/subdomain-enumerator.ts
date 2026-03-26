import * as dns from 'dns';

/**
 * Returns a built-in list of common subdomain words.
 * @returns {string[]} Array of 50 common subdomain words.
 */
export function defaultWordlist(): string[] {
  return [
    'www', 'mail', 'ftp', 'test', 'dev', 'staging', 'prod', 'app', 'api', 'dashboard',
    'admin', 'blog', 'docs', 'support', 'help', 'login', 'signup', 'demo', 'secure', 'portal',
    'client', 'server', 'internal', 'external', 'intranet', 'extranet', 'vpn', 'backup', 'mirror',
    'archive', 'old', 'new', 'beta', 'alpha', 'gamma', 'delta', 'omega', 'theta', 'phi', 'psi',
    'sigma', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'upsilon', 'zeta', 'eta', 'iota', 'kappa',
    'rho', 'tau', 'chi', 'upsilon', 'zeta', 'eta', 'iota', 'kappa', 'rho', 'tau', 'chi'
  ];
}

/**
 * Enumerates subdomains by resolving each candidate.
 * @param domain - Target domain to check.
 * @param wordlist - List of subdomain words to test.
 * @returns {Promise<{ subdomain: string; resolved: boolean; ip?: string[] }[]>} Resolved subdomains with IPs.
 */
export async function enumerate(domain: string, wordlist: string[]): Promise<{ subdomain: string; resolved: boolean; ip?: string[] }[]> {
  const results: { subdomain: string; resolved: boolean; ip?: string[] }[] = [];
  for (const word of wordlist) {
    const subdomain = `${word}.${domain}`;
    try {
      const ips = await dns.promises.resolve(subdomain);
      results.push({ subdomain, resolved: true, ip: ips });
    } catch (err) {
      results.push({ subdomain, resolved: false });
    }
  }
  return results;
}

/**
 * Filters resolved subdomains from enumeration results.
 * @param results - Results from enumerate function.
 * @returns {Object[]} List of subdomains with resolved IPs.
 */
export function filterAlive(results: { subdomain: string; resolved: boolean; ip?: string[] }[]): { subdomain: string; ip: string[] }[] {
  return results
    .filter(r => r.resolved)
    .map(r => ({ subdomain: r.subdomain, ip: r.ip! }));
}

/**
 * Renders a report of discovered subdomains with their IP addresses.
 * @param results - Filtered alive subdomains from filterAlive.
 * @returns {string[]} Formatted report lines.
 */
export function renderReport(results: { subdomain: string; ip: string[] }[]): string[] {
  return results.map(entry => `${entry.subdomain}: ${entry.ip.join(', ')}`);
}