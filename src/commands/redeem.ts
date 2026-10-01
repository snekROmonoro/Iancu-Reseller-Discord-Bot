import { ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder, type RepliableInteraction } from "discord.js";
import { api, type Order } from "../api.ts";
import {
	code,
	done,
	embed,
	EPHEMERAL,
	field,
	forAccount,
	orderNo,
	progress,
	refused,
	staffLog,
	warning,
} from "../discord.ts";
import { describeRemoval, removeOrder } from "../refunds.ts";
import { idData, idempotencyKey, orderChoices, tokenFrom, tokenModal, type Command } from "./shared.ts";

export const redeem: Command = {
	data: new SlashCommandBuilder()
		.setName("redeem")
		.setDescription("Spend your credits: queue an account for claims")
		.addIntegerOption((o) =>
			o
				.setName("claims")
				.setDescription("How many claims (1 credit each)")
				.setMinValue(1)
				.setMaxValue(1000)
				.setRequired(true),
		),

	async run(inter) {
		const claims = inter.options.getInteger("claims", true);
		// A form is the one reply that cannot be deferred, so this check gets 1.5 seconds at most.
		// If the API is slow, the form opens anyway: the order is checked again when it is placed.
		const customer = await api.customer(inter.user.id, { timeoutMs: 1500, retry: false }).catch(() => null);
		if (customer && customer.credits < claims) {
			return inter.reply({
				embeds: [refused("⛔ Not enough credits", `You have ${code(customer.credits)} credits.`)],
				...EPHEMERAL,
			});
		}
		await inter.showModal(tokenModal(`redeem.form:${claims}`, `Redeem ${claims} claims`));
	},

	async modal(inter) {
		await inter.deferReply(EPHEMERAL);
		const claims = idData(inter.customId);
		const order = await api.createOrder(
			{ token: tokenFrom(inter), claims, customer: inter.user.id, paidFrom: "customer" },
			idempotencyKey(inter),
		);
		await inter.editReply({
			embeds: [
				done(
					"✅ Order placed",
					`Your account is in the queue${forAccount(order)}. Use \`/queue position\` to see your place.`,
					[field("Order", orderNo(order.id)), field("Claims", code(order.claims))],
				),
			],
		});
	},
};

/** Their waiting orders, or a reply saying there are none. */
async function myWaitingOrders(inter: RepliableInteraction) {
	const orders = await api.allOrders({ customer: inter.user.id, state: "pending" });
	if (!orders.length) {
		await inter.editReply({ embeds: [refused("⛔ Nothing waiting", "You have no orders waiting in the queue.")] });
	}
	return orders;
}

const orderPicker = (customId: string, orders: Order[]) =>
	new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder("Choose an order")
			.addOptions(
				orders.slice(0, 25).map((o) => ({
					label: `#${o.id} · ${o.received}/${o.claims} claims`,
					description: `Place ${o.place ?? "-"} in the queue`,
					value: String(o.id),
				})),
			),
	);

/** The order, if it is theirs and still waiting; otherwise a reply saying why not. */
async function ownWaitingOrder(inter: RepliableInteraction, id: number) {
	const order = await api.order(id);
	if (order.customer !== inter.user.id) {
		await inter.editReply({ embeds: [refused("⛔ Not your order", `${orderNo(id)} is not one of your orders.`)] });
		return null;
	}
	if (order.state !== "pending") {
		await inter.editReply({
			embeds: [refused("⛔ Not in the queue", `${orderNo(id)} has already left the queue.`)],
			components: [],
		});
		return null;
	}
	return order;
}

export const updateToken: Command = {
	data: new SlashCommandBuilder()
		.setName("update-token")
		.setDescription("Give a new token for your waiting order (the same account only)")
		.addIntegerOption((o) =>
			o.setName("order").setDescription("Which order (if you have more than one)").setAutocomplete(true),
		),

	async run(inter) {
		const id = inter.options.getInteger("order");
		if (id) return inter.showModal(tokenModal(`update-token.form:${id}`, `New token for order #${id}`));

		// Same 1.5-second budget as /redeem: the form must open within Discord's 3 seconds.
		const mine = await api
			.orders({ customer: inter.user.id, state: "pending", limit: 25 }, { timeoutMs: 1500, retry: false })
			.catch(() => null);
		if (!mine) {
			return inter.reply({
				embeds: [
					warning("⏳ Try again", "The API is slow right now. Try again, or choose the `order` option."),
				],
				...EPHEMERAL,
			});
		}
		if (!mine.orders.length) {
			return inter.reply({
				embeds: [refused("⛔ Nothing waiting", "You have no orders waiting in the queue.")],
				...EPHEMERAL,
			});
		}
		if (mine.orders.length === 1) {
			const only = mine.orders[0]!.id;
			return inter.showModal(tokenModal(`update-token.form:${only}`, `New token for order #${only}`));
		}
		return inter.reply({
			embeds: [embed({ title: "🔑 Which order?", description: "Choose the order to give a new token for." })],
			components: [orderPicker("update-token.pick", mine.orders)],
			...EPHEMERAL,
		});
	},

	select: (inter) =>
		inter.showModal(tokenModal(`update-token.form:${inter.values[0]}`, `New token for order #${inter.values[0]}`)),

	autocomplete: (inter) => orderChoices(inter, inter.user.id),

	async modal(inter) {
		await inter.deferReply(EPHEMERAL);
		const id = idData(inter.customId);
		if (!(await ownWaitingOrder(inter, id))) return;
		const order = await api.updateToken(id, tokenFrom(inter));
		await inter.editReply({
			embeds: [
				done("✅ Token replaced", `Your order keeps its place in the queue${forAccount(order)}.`, [
					field("Order", orderNo(order.id)),
					field("Received", progress(order)),
				]),
			],
		});
	},
};

export const leave: Command = {
	data: new SlashCommandBuilder()
		.setName("leave")
		.setDescription("Take your order out of the queue; what it did not receive comes back as credits")
		.addIntegerOption((o) =>
			o.setName("order").setDescription("Which order (if you have more than one)").setAutocomplete(true),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		const id = inter.options.getInteger("order");
		if (id) return leaveOrder(inter, id);

		const orders = await myWaitingOrders(inter);
		if (orders.length === 1) return leaveOrder(inter, orders[0]!.id);
		if (orders.length > 1) {
			return inter.editReply({
				embeds: [
					embed({ title: "🚪 Which order?", description: "Choose the order to take out of the queue." }),
				],
				components: [orderPicker("leave.pick", orders)],
			});
		}
	},

	async select(inter) {
		await inter.deferUpdate();
		return leaveOrder(inter, Number(inter.values[0]));
	},

	autocomplete: (inter) => orderChoices(inter, inter.user.id),
};

async function leaveOrder(inter: RepliableInteraction, id: number) {
	if (!(await ownWaitingOrder(inter, id))) return;

	// The customer always gets the refund back as credits; the reply tells them, so no DM.
	const removed = await removeOrder(id, "leave", false, inter.user.id);
	const { order, refunded, change } = removed;
	const back = order.paidFrom === "customer" ? refunded : change;

	if (removed.failure) {
		await inter.editReply({
			embeds: [
				warning(
					"⚠️ Left the queue",
					`Your order left the queue, but your ${code(change)} credits could not be given back: ${removed.failure.message}\nPlease ask staff to add them.`,
					[field("Order", orderNo(id))],
				),
			],
			components: [],
		});
	} else {
		await inter.editReply({
			embeds: [
				done("✅ Left the queue", undefined, [
					field("Order", orderNo(id)),
					field("Received", progress(order)),
					field("Credits back", code(back)),
				]),
			],
			components: [],
		});
	}
	const summary = describeRemoval(removed);
	await staffLog(inter.user.id, "🚪 Left the queue", summary.description, summary.fields);
}
