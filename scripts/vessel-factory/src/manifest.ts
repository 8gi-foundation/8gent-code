/**
 * Vessel manifest - identity + capabilities sent to control plane on registration.
 */

export interface VesselManifest {
  id: string;
  code: string;
  name: string;
  title: string;
  catchphrase: string;
  public_url: string;
  tools: string[];
  version: string;
}

export function buildManifest(): VesselManifest {
  const code     = process.env.VESSEL_CODE       ?? "???";
  const name     = process.env.VESSEL_NAME       ?? "Unknown";
  const title    = process.env.VESSEL_TITLE      ?? "Officer";
  const phrase   = process.env.VESSEL_CATCHPHRASE ?? "";
  const flyApp   = process.env.FLY_APP_NAME      ?? `${code.toLowerCase()}-vessel`;
  const publicUrl = `https://${flyApp}.fly.dev`;
  const tools    = (process.env.VESSEL_TOOLS ?? "").split(",").filter(Boolean);

  return {
    id: `${flyApp}-ams`,
    code,
    name,
    title,
    catchphrase: phrase,
    public_url: publicUrl,
    tools,
    version: "2.0.0",
  };
}
