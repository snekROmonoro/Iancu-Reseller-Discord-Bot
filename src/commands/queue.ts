import {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type RepliableInteraction,
	type User,
} from "discord.js";
import { api } from "../api.ts";
import { code, done, embed, EPHEMERAL, field, forAccount, orderNo, progress, refused, staffLog } from "../discord.ts";
import { allowed, atLeast, Level, levelOf } from "../permissions.ts";
import { describeRemoval, removeOrder } from "../refunds.ts";
import { pageButton, queuePage, waitingOrders } from "../views.ts";
import { idempotencyKey, orderChoices, tokenFrom, tokenModal, type Command } from "./shared.ts";

export const queue: Command = {
	data: new SlashCommandBuilder()
		.setName("queue")
		.setDescription("The claim queue")
		.addSubcommand((s) =>
			s
				.setName("view")
				.setDescription("The shop's waiting orders, in queue order")
				.addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)),
		)
		.addSubcommand((s) =>
			s
				.setName("position")
				.setDescription("Where your (or someone's) waiting orders stand")
				.addUserOption((o) => o.setName("user").setDescription("Whose orders to show"))
				.addBooleanOption((o) => o.setName("order").setDescription("Show order ids too (only you see it)")),
		)
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription("Queue a customer's account, paid from the shop's balance (staff)")
				.addUserOption((o) => o.setName("user").setDescription("Who the order is for").setRequired(true))
				.addIntegerOption((o) =>
					o
						.setName("claims")
						.setDescription("How many claims")
						.setMinValue(1)
						.setMaxValue(1000)
						.setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("remove")
				.setDescription("Take an order out of the queue (staff)")
				.addIntegerOption((o) =>
					o.setName("order").setDescription("Which order").setRequired(true).setAutocomplete(true),
				)
				.addBooleanOption((o) =>
					o
						.setName("refund")
						.setDescription("Give the customer what the order did not receive (no: the shop keeps it)")
						.setRequired(true),
				)
				.addBooleanOption((o) =>
					o.setName("message").setDescription("Tell the customer by DM").setRequired(true),
				),
		),

	async run(inter) {
		switch (inter.options.getSubcommand()) {
			case "view":
				await inter.deferReply(EPHEMERAL);
				return inter.editReply(await queuePage(inter.options.getInteger("page") ?? 1));
			case "position":
				return position(
					inter,
					inter.options.getUser("user") ?? inter.user,
					!!inter.options.getBoolean("order"),
				);
			case "add":
				return add(inter);
			case "remove":
				return remove(inter);
		}
	},

	button: (inter) => pageButton(inter, queuePage),

	async autocomplete(inter) {
		if (!atLeast(await levelOf(inter.user.id), Level.Moderator)) return inter.respond([]);
		return orderChoices(inter);
	},

	async modal(inter) {
		// queue.add:<user id>:<claims>
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Moderator))) return;
		const [, userId, claims] = inter.customId.split(":") as [string, string, string];
		const order = await api.createOrder(
			{ token: tokenFrom(inter), claims: Number(claims), customer: userId, paidFrom: "balance" },
			idempotencyKey(inter),
		);
		const fields = [
			field("Order", orderNo(order.id)),
			field("Customer", `<@${userId}>${forAccount(order)}`),
			field("Claims", code(order.claims)),
			field("Paid from", "shop's balance"),
		];
		await inter.editReply({ embeds: [done("✅ Order placed", undefined, fields)] });
		await staffLog(inter.user.id, "📝 Order placed", undefined, fields);
	},
};

export const queuePosition: Command = {
	data: new ContextMenuCommandBuilder().setName("Queue Position").setType(ApplicationCommandType.User),
	menu: (inter) => position(inter, inter.targetUser, false, true),
};

async function position(inter: RepliableInteraction, user: User, showIds: boolean, contextMenu = false) {
	const self = user.id === inter.user.id;
	// Public, unless order ids are shown (or it came from the user menu).
	await inter.deferReply(showIds || contextMenu ? EPHEMERAL : {});
	if (showIds && !self && !(await allowed(inter, Level.Moderator, "Only staff can see other people's order ids.")))
		return;

	const { orders, place } = await waitingOrders();
	const lines = orders
		.filter((o) => o.customer === user.id)
		.map((o) => `> ${code(place(o))} · ${progress(o)}${showIds ? ` · ${orderNo(o.id)}${forAccount(o)}` : ""}`);

	await inter.editReply({
		embeds: [
			embed({
				title: "📍 Place in the queue",
				description:
					lines.join("\n") || `${self ? "You have" : `<@${user.id}> has`} no orders waiting in the queue.`,
				thumbnail: user.displayAvatarURL(),
			}),
		],
	});
}

async function add(inter: ChatInputCommandInteraction) {
	if (!(await allowed(inter, Level.Moderator))) return;
	const user = inter.options.getUser("user", true);
	if (user.bot) return inter.reply({ embeds: [refused("⛔ Not a customer", "Bots can't be queued.")], ...EPHEMERAL });
	const claims = inter.options.getInteger("claims", true);
	await inter.showModal(tokenModal(`queue.add:${user.id}:${claims}`, `Queue ${claims} claims for ${user.username}`));
}

async function remove(inter: ChatInputCommandInteraction) {
	await inter.deferReply(EPHEMERAL);
	if (!(await allowed(inter, Level.Moderator))) return;

	const id = inter.options.getInteger("order", true);
	const refund = inter.options.getBoolean("refund", true);
	const message = inter.options.getBoolean("message", true);

	const removed = await removeOrder(id, refund ? "remove-refund" : "remove-keep", message, inter.user.id);
	const summary = describeRemoval(removed);
	await inter.editReply({ embeds: [summary] });
	await staffLog(
		inter.user.id,
		summary.title ?? "Order removed",
		`${summary.description}\nRefund to customer: ${code(refund ? "yes" : "no")} · DM: ${code(message ? "yes" : "no")}`,
		summary.fields,
	);
}
