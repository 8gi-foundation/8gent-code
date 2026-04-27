/**
 * Handle validation. A tenant handle becomes a subdomain, a Clerk slug,
 * a bucket name, and a row key. Anything that breaks any of those four is rejected.
 */

const HANDLE_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function validateHandle(raw: string): string {
	const handle = raw.trim().toLowerCase();
	if (!HANDLE_RE.test(handle)) {
		throw new Error(
			`Invalid handle "${raw}". Must be 2-32 chars, lowercase alphanumeric or dash, start with a letter, end with letter or digit.`,
		);
	}
	return handle;
}

export function tenantId(handle: string): string {
	return `tenant_${handle}`;
}

export function subdomain(handle: string): string {
	return `${handle}.8gentos.com`;
}

export function bucketName(handle: string): string {
	return `tenant-${handle}`;
}
