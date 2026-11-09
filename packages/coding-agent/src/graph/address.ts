/**
 * Routing address carried by `report_to`.
 *
 * A routable address names a Bot mailbox: `bot:<name>`, matching the OMH mailbox
 * Bot-name rule. Other values stay accepted as opaque labels for observers, but
 * only the `bot:` form can be delivered by `omh mailbox`.
 */
export const BOT_ADDRESS = /^bot:([a-z0-9][a-z0-9._-]{0,63})$/;

export function reportAddressProblem(value: string): string | null {
	if (!value.startsWith("bot:")) return null;
	if (BOT_ADDRESS.test(value)) return null;
	return "A Bot address is bot:<name>, with the name matching [a-z0-9][a-z0-9._-]{0,63}";
}
