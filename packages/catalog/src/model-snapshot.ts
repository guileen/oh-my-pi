import type { Api, Model } from "./types";

/** Clone request/catalog data without resolving the opaque request-time credential capability. */
export function cloneModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const { resolveHeaders, ...data } = model;
	const snapshot: Model<TApi> = structuredClone(data);
	if (resolveHeaders !== undefined) snapshot.resolveHeaders = resolveHeaders;
	return snapshot;
}
