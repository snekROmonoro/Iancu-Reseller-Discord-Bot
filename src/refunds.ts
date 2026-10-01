// Who keeps what an order did not receive when the bot takes it out of the queue.
// The API always refunds whoever paid; the bot then settles it with one follow-up credit change.
import type { APIEmbed } from "discord.js";
import { api, ApiError, type Order, type PaidFrom } from "./api.ts";
import { code, done, field, orderNo, warning, who } from "./discord.ts";
import { expecting } from "./history.ts";

/** leave: the customer's own /leave. remove-refund / remove-keep: staff's /queue remove refund:true / false. */
export type Removal = "leave" | "remove-refund" | "remove-keep";

export const customerKeepsRefund = (removal: Removal) => removal !== "remove-keep";

/** The credit change for the order's customer after the API refunded `refunded` to whoever paid. */
export function followUpChange(removal: Removal, paidFrom: PaidFrom, refunded: number) {
	if (customerKeepsRefund(removal)) return paidFrom === "balance" ? refunded : 0;
	return paidFrom === "customer" && refunded ? -refunded : 0;
}

/** Orders this bot is taking out right now, so the feed words the customer's DM to match (or skips it). */
export const releasing = new Map<number, { dm: boolean; customerGets: boolean }>();

export interface Removed {
	order: Order;
	refunded: number;
	/** The follow-up change made (or tried) for the customer. */
	change: number;
	/** What the customer holds after the follow-up, when one was made. */
	holds?: number;
	/** The follow-up was refused: staff must fix it by hand. */
	failure?: ApiError;
}

/** `actorId`: who took it out, for the credit history. */
export async function removeOrder(orderId: number, removal: Removal, dm: boolean, actorId: string): Promise<Removed> {
	releasing.set(orderId, { dm, customerGets: customerKeepsRefund(removal) });
	let result: { order: Order; refunded: number };
	try {
		// The API refunds whoever paid; when that is the customer, the history names who took the order out.
		result = await expecting({ actorId, cause: "refunded", orderId }, () => api.cancelOrder(orderId));
	} catch (e) {
		// A DELETE that got no answer may still have gone through. It can't be resent, so look at the order.
		const unanswered = e instanceof ApiError && (e.code === "timeout" || e.code === "network_error");
		const recovered = unanswered ? await cancelledAnyway(orderId) : null;
		if (!recovered) {
			releasing.delete(orderId);
			throw e;
		}
		result = recovered;
	}

	const { order, refunded } = result;
	const change = order.customer ? followUpChange(removal, order.paidFrom, refunded) : 0;
	if (change === 0) return { order, refunded, change };

	try {
		// Derived from the order, so a retry never moves it twice.
		const after = await expecting(
			{ actorId, customerId: order.customer!, cause: change > 0 ? "given" : "taken_back", change },
			() => api.changeCredits(order.customer!, change, `refund-${orderId}`),
		);
		return { order, refunded, change, holds: after.customer.credits };
	} catch (e) {
		if (e instanceof ApiError) return { order, refunded, change, failure: e };
		throw e;
	}
}

/** The order, if it left the queue early after all; null if it is still waiting (or completed). */
async function cancelledAnyway(orderId: number) {
	const order = await api.order(orderId).catch(() => null);
	if (order?.state !== "refunded" && order?.state !== "removed") return null;
	// A refunded order got back every claim it had not received; a removed one got nothing back.
	return { order, refunded: order.state === "refunded" ? order.claims - order.received : 0 };
}

/** How the refund went, for the reply and the logs. */
export function describeRemoval(r: Removed): APIEmbed {
	const { order, refunded, change } = r;
	const fields = [field("Order", orderNo(order.id)), field("Customer", who(order.customer))];
	const toWhom = order.paidFrom === "customer" ? `${who(order.customer)}'s credits` : "the shop's balance";
	const lines = [`The API refunded ${code(refunded)} credits to ${toWhom}.`];

	if (r.failure) {
		const what =
			change > 0
				? `giving ${code(change)} credits to ${who(order.customer)}`
				: `taking ${code(-change)} credits back from ${who(order.customer)}`;
		lines.push(
			`But ${what} was refused: ${r.failure.message}`,
			`Fix it by hand with \`/bank ${change > 0 ? "add" : "remove"}\`.`,
		);
		return warning("⚠️ Refund not settled", lines.join("\n"), fields);
	}

	if (change > 0) lines.push(`Then ${who(order.customer)} was given those ${code(change)} credits.`);
	if (change < 0) lines.push(`Then those ${code(-change)} credits were taken back from ${who(order.customer)}.`);
	if (r.holds !== undefined) fields.push(field("They now hold", `${code(r.holds)} credits`));
	return done("✅ Order removed", lines.join("\n"), fields);
}
