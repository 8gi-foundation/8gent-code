import { bucketName } from "./handle.ts";
/**
 * Hetzner Object Storage bucket adapter. Hetzner Object Storage is S3-compatible.
 * Bucket name = "tenant-<handle>" in the configured region (default fsn1).
 *
 * The adapter uses HEAD bucket to detect existence and PUT bucket to create.
 * AWS SigV4 is implemented inline via Bun's native crypto so we don't pull a
 * heavy SDK into a script. Region defaults to fsn1; endpoint pattern follows
 * Hetzner's documented form: https://<region>.your-objectstorage.com.
 */
import type { Adapter, Ctx, PlanStep } from "./types.ts";

interface SigV4Inputs {
	method: "HEAD" | "PUT" | "GET";
	host: string;
	path: string;
	region: string;
	accessKey: string;
	secretKey: string;
	now: Date;
	body: string;
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
	const enc = new TextEncoder();
	const k = typeof key === "string" ? enc.encode(key) : key;
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		k,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signRequest(
	inp: SigV4Inputs,
): Promise<{ url: string; headers: Record<string, string> }> {
	const service = "s3";
	const amzDate = inp.now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = await sha256Hex(inp.body);

	const canonicalHeaders = `host:${inp.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = `${inp.method}\n${inp.path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
	const credentialScope = `${dateStamp}/${inp.region}/${service}/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

	const kDate = await hmac(`AWS4${inp.secretKey}`, dateStamp);
	const kRegion = await hmac(kDate, inp.region);
	const kService = await hmac(kRegion, service);
	const kSigning = await hmac(kService, "aws4_request");
	const signature = hex(await hmac(kSigning, stringToSign));

	const authorization = `AWS4-HMAC-SHA256 Credential=${inp.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return {
		url: `https://${inp.host}${inp.path}`,
		headers: {
			Authorization: authorization,
			"x-amz-date": amzDate,
			"x-amz-content-sha256": payloadHash,
		},
	};
}

export const storageAdapter: Adapter = {
	name: "hetzner-bucket",
	async plan(handle, ctx): Promise<PlanStep> {
		const accessKey = ctx.env.HETZNER_S3_ACCESS_KEY;
		const secretKey = ctx.env.HETZNER_S3_SECRET_KEY;
		const region = ctx.env.HETZNER_S3_REGION ?? "fsn1";
		const bucket = bucketName(handle);
		const host = `${region}.your-objectstorage.com`;
		const path = `/${bucket}`;

		if (!accessKey || !secretKey) {
			return ctx.apply
				? err(bucket, "HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY required for --apply")
				: {
						resource: `bucket:${bucket}`,
						status: "create",
						detail: `would create bucket ${bucket} in ${region} (dry-run, no API call)`,
					};
		}

		try {
			const head = await signRequest({
				method: "HEAD",
				host,
				path,
				region,
				accessKey,
				secretKey,
				now: ctx.now(),
				body: "",
			});
			const headRes = await ctx.fetch(head.url, { method: "HEAD", headers: head.headers });
			if (headRes.status === 200) {
				return {
					resource: `bucket:${bucket}`,
					status: "exists",
					detail: `bucket ${bucket} already present in ${region}`,
				};
			}
			if (headRes.status !== 404) {
				return err(bucket, `HEAD bucket returned ${headRes.status}`);
			}

			if (!ctx.apply) {
				return {
					resource: `bucket:${bucket}`,
					status: "create",
					detail: `would create bucket ${bucket} in ${region}`,
				};
			}

			const put = await signRequest({
				method: "PUT",
				host,
				path,
				region,
				accessKey,
				secretKey,
				now: ctx.now(),
				body: "",
			});
			const putRes = await ctx.fetch(put.url, { method: "PUT", headers: put.headers });
			if (!putRes.ok) {
				const body = await putRes.text();
				return err(bucket, `PUT bucket failed: ${putRes.status} ${body}`);
			}
			return {
				resource: `bucket:${bucket}`,
				status: "create",
				detail: `created bucket ${bucket} in ${region}`,
			};
		} catch (e) {
			return err(bucket, (e as Error).message);
		}
	},
};

function err(bucket: string, msg: string): PlanStep {
	return {
		resource: `bucket:${bucket}`,
		status: "error",
		detail: "storage step failed",
		error: msg,
	};
}
