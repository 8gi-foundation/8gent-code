/**
 * 8DK - the 8gent Device Kit (#3362).
 *
 * Give a vessel a device of any kind: declare typed capabilities, pair with
 * the person's consent, and each granted capability becomes a permission-gated
 * agent tool.
 */
export {
	type Capability,
	type CapabilityHandler,
	type CapabilityKind,
	type DeviceDefinition,
	type DeviceManifest,
	defineDevice,
	MANIFEST_LIMITS,
	ManifestError,
	manifestDigest,
	type ParamSpec,
	type ParamType,
	validateInput,
	validateManifest,
} from "./manifest";
export {
	type ConsentDecision,
	type ConsentRequest,
	DeviceRegistry,
	type PairedDevice,
	type PairOptions,
	type PairResult,
} from "./pairing";
export {
	CallCorrelator,
	type DeviceFrame,
	type DeviceLink,
	type InvokeResult,
	parseDeviceFrame,
	serveDevice,
	type VesselFrame,
} from "./link";
export {
	type AdapterOptions,
	DEVICE_POLICY_ACTION,
	type DeviceDecision,
	DeviceToolAdapter,
	type DeviceToolCtx,
	type DeviceToolResult,
	deviceToolName,
	parseDeviceToolName,
} from "./adapter";
