/** The JSON-schema builders the tools need: `Type.Object({ q: Type.String() })`. */
export interface TSchema {
	type: string;
	[k: string]: unknown;
}
export type Static<S> = S extends { _static: infer T } ? T : unknown;
type TString = TSchema & { type: "string"; _static: string };
interface TObject<P extends Record<string, TSchema>> extends TSchema {
	type: "object";
	properties: P;
	required: string[];
	_static: { [K in keyof P]: Static<P[K]> };
}
export const Type = {
	String: (): TString => ({ type: "string" }) as TString,
	Object: <P extends Record<string, TSchema>>(properties: P): TObject<P> =>
		({ type: "object", properties, required: Object.keys(properties) }) as TObject<P>,
};
