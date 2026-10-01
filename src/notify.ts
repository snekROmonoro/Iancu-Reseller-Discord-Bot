// What happens on its own, for each event from the feed: DMs, the claims channel, the logs.
import { api, type Claim, type FeedEvent, type Order } from "./api.ts";
import { settings } from "./db.ts";
import {
	addCustomerRole,
	claimEmoji,
	claimName,
	claimsByType,
	client,
	code,
	Colors,
	dm,
	done,
	embed,
	eventLog,
	field,
	forAccount,
	orderNo,
	paidFromText,
	progress,
	seconds,
	shopName,
	warning,
	who,
} from "./discord.ts";
import { customerCauses, describe, recordCreditChange } from "./history.ts";
import { log } from "./log.ts";
import { releasing } from "./refunds.ts";
import { soon } from "./views.ts";

const releaseCauses: Record<string, string> = {
	left: "cancelled",
	removed: "removed by the supplier",
	suspended: "reseller account suspended",
	token_invalid: "token stopped working",
	token_locked: "account needs verifying",
	captcha: "kept getting a captcha",
};

const balanceCauses: Record<string, string> = {
	purchased: "credits bought",
	spent: "spent on an order",
	refunded: "refunded from an order",
	adjusted: "adjusted by the supplier",
	given: "given to a customer",
	taken_back: "taken back from a customer",
};

export async function handleEvent(event: FeedEvent) {
	const d = event.data;
	const order = d.order;

	switch (event.type) {
		case "order.created": {
			if (!order) return;
			soon("queue");
			await addCustomerRole(order.customer);
			await dm(
				order.customer,
				embed({
					title: "📝 Order placed",
					description: `Your order at **${shopName()}** is in the queue${forAccount(order)}. Use \`/queue position\` to see your place.`,
					fields: [field("Order", orderNo(order.id)), field("Claims", code(order.claims))],
				}),
			);
			return eventLog(
				"📝 Order placed",
				`For ${who(order.customer)}${forAccount(order)}`,
				orderFields(order, field("Paid from", paidFromText(order.paidFrom))),
			);
		}

		case "claim.landed": {
			if (!order || !d.claim) return;
			soon("queue");
			const claim = d.claim;
			await dm(
				order.customer,
				embed({
					title: "🎉 New claim!",
					description: `A claim landed${forAccount(order)}.`,
					color: Colors.claim,
					fields: [
						field("Type", code(claimName(claim.type))),
						field("Received", progress(order)),
						field("Order", orderNo(order.id)),
					],
				}),
			);
			await announceClaim(order, claim);
			return eventLog(
				"🎉 Claim landed",
				`${code(claimName(claim.type))} for ${who(order.customer)}${forAccount(order)}`,
				orderFields(order, field("Speed", claim.delayMs != null ? code(seconds(claim.delayMs)) : "-")),
			);
		}

		case "order.completed": {
			if (!order) return;
			soon("queue");
			const detail = await api.order(order.id).catch(() => null);
			const byType = detail ? claimsByType(detail.claimsLanded) : "-";
			await dm(
				order.customer,
				done("🤝 Order completed", `Every claim of your order has landed${forAccount(order)}. Thank you!`, [
					field("Order", orderNo(order.id)),
					field("Claims received", byType, false),
				]),
			);
			return eventLog(
				"🤝 Order completed",
				`For ${who(order.customer)}${forAccount(order)}`,
				orderFields(order, field("Claims received", byType, false)),
			);
		}

		case "order.released": {
			if (!order) return;
			soon("queue");
			const refunded = d.refunded ?? 0;
			// When this bot took the order out, it knows who keeps the refund and whether to DM.
			const ours = releasing.get(order.id);
			releasing.delete(order.id);
			const credited = ours ? (ours.customerGets ? refunded : 0) : order.paidFrom === "customer" ? refunded : 0;

			if (ours?.dm ?? true) {
				await dm(
					order.customer,
					warning("🚪 Order ended early", order.reason ?? "Your order left the queue.", [
						field("Order", orderNo(order.id)),
						field("Received", progress(order)),
						field("Credits back", code(credited)),
						field("Queue again", "Use `/redeem` with a working token.", false),
					]),
				);
			}
			return eventLog(
				"🚪 Order released",
				`For ${who(order.customer)}${forAccount(order)}: ${describe(releaseCauses, d.cause)}`,
				orderFields(order, field("Refunded", `${code(refunded)} to ${paidFromText(order.paidFrom)}`)),
			);
		}

		case "order.token_updated":
			if (!order) return;
			return eventLog("🔑 Token replaced", `For ${who(order.customer)}${forAccount(order)}`, orderFields(order));

		case "balance.changed": {
			const b = d.balance;
			if (!b) return;
			return eventLog("💰 Balance changed", `The shop's credits changed: ${describe(balanceCauses, b.cause)}`, [
				field("Change", code(signed(b.change))),
				field("Now", `${code(b.credits)} credits`),
				...(b.orderId ? [field("Order", orderNo(b.orderId))] : []),
			]);
		}

		case "customer.credits_changed": {
			const customer = d.customer;
			if (!customer) return;
			await recordCreditChange(event).catch((e) =>
				log.error(`Credit history: event ${event.seq} not recorded:`, e),
			);
			soon("leaderboard");
			const change = d.change ?? 0;
			if (d.cause === "given" || d.cause === "transferred_in") {
				await addCustomerRole(customer.id);
				await dm(
					customer.id,
					done("🏦 Credits received", `You got ${code(change)} credits at **${shopName()}**.`, [
						field("You now hold", `${code(customer.credits)} credits`),
						...(d.cause === "transferred_in" ? [field("From", who(d.counterpart))] : []),
						field("Spend them", "Use `/redeem` to queue your account.", false),
					]),
				);
			}
			return eventLog("🏦 Credits changed", `${who(customer.id)}: ${describe(customerCauses, d.cause)}`, [
				field("Change", code(signed(change))),
				field("Now holds", `${code(customer.credits)} credits`),
				...(d.orderId ? [field("Order", orderNo(d.orderId))] : []),
				...(d.counterpart ? [field(change < 0 ? "To" : "From", who(d.counterpart))] : []),
			]);
		}
	}
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

const orderFields = (order: Order, ...extra: ReturnType<typeof field>[]) => [
	field("Order", orderNo(order.id)),
	field("Received", progress(order)),
	...extra,
];

/** The public claims channel, as an embed or as one line of text, then the reaction. */
async function announceClaim(order: Order, claim: Claim) {
	const s = settings();
	if (!s.claimsChannel) return;
	const channel = await client.channels.fetch(s.claimsChannel).catch(() => null);
	if (!channel?.isSendable()) return log.warn("The claims channel is missing or the bot cannot post there");

	const emoji = claimEmoji(claim.type);
	const name = claimName(claim.type);
	const ping = s.roleClaimPing ? `<@&${s.roleClaimPing}>` : "";
	// The claim-ping role is the only mention that ever pings.
	const allowedMentions = { parse: [], roles: s.roleClaimPing ? [s.roleClaimPing] : [] };

	let message;
	if (s.claimsStyle === "line") {
		let text = `${emoji} Successfully claimed \`\`${name}\`\``;
		if (claim.delayMs != null) text += ` in \`\`${seconds(claim.delayMs)}\`\``;
		if (order.customer) text += ` for ${who(order.customer)}`;
		text += ` (\`\`${order.received}/${order.claims}\`\`)`;
		if (ping) text += ` ${ping}`;
		message = await channel.send({ content: text, allowedMentions }).catch((e) => log.warn("Claims channel:", e));
	} else {
		const fields = [];
		if (order.customer) fields.push(field("For", who(order.customer)));
		if (claim.delayMs != null) fields.push(field("Speed", code(seconds(claim.delayMs))));
		fields.push(field("Progress", progress(order)));
		message = await channel
			.send({
				content: ping || undefined,
				embeds: [embed({ title: `${emoji} \`${name}\` claimed`, color: Colors.claim, fields })],
				allowedMentions,
			})
			.catch((e) => log.warn("Claims channel:", e));
	}

	if (message && s.emojiClaimsReaction) await message.react(s.emojiClaimsReaction).catch(() => {});
}

/** The bot was away longer than the feed keeps events: list what changed, without messaging anyone. */
export async function reportMissed(since: Date | null) {
	const orders = since ? await api.allOrders({ updatedSince: since.toISOString() }).catch(() => []) : [];
	const intro =
		"The bot was away longer than the events feed keeps (30 days), so these orders changed without anyone being told:";
	let description = intro;
	let shown = 0;
	for (const o of orders) {
		const line = `\n> ${orderNo(o.id)} · ${code(o.state)} · ${progress(o)} · ${who(o.customer)}${forAccount(o)}`;
		if (description.length + line.length > 3900) break;
		description += line;
		shown++;
	}
	if (shown < orders.length) description += `\n…and ${orders.length - shown} more.`;
	if (!orders.length) description = "The bot was away longer than the events feed keeps (30 days).";
	await eventLog("⏰ Missed events", description);
}
