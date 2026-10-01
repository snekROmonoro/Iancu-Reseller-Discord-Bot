import { SlashCommandBuilder, type BaseMessageOptions } from "discord.js";
import { api } from "../api.ts";
import {
	claimsByType,
	code,
	embed,
	EPHEMERAL,
	field,
	forAccount,
	orderNo,
	pageButtons,
	paidFromText,
	progress,
	when,
	who,
} from "../discord.ts";
import { allowed, Level } from "../permissions.ts";
import type { Command } from "./shared.ts";

const PAGE_SIZE = 10;

export const order: Command = {
	data: new SlashCommandBuilder()
		.setName("order")
		.setDescription("Your orders")
		.addSubcommand((s) =>
			s
				.setName("list")
				.setDescription("Your (or, for staff, someone's) orders, newest first")
				.addUserOption((o) => o.setName("user").setDescription("Whose orders (staff)"))
				.addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)),
		)
		.addSubcommand((s) =>
			s
				.setName("info")
				.setDescription("One order, with the claims that landed")
				.addIntegerOption((o) => o.setName("id").setDescription("Order id").setRequired(true)),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);

		if (inter.options.getSubcommand() === "list") {
			const user = inter.options.getUser("user") ?? inter.user;
			if (
				user.id !== inter.user.id &&
				!(await allowed(inter, Level.Moderator, "Only staff can see other people's orders."))
			)
				return;
			return inter.editReply(await listPage(user.id, inter.options.getInteger("page") ?? 1));
		}

		const o = await api.order(inter.options.getInteger("id", true));
		if (
			o.customer !== inter.user.id &&
			!(await allowed(inter, Level.Moderator, `${orderNo(o.id)} is not one of your orders.`))
		)
			return;

		const fields = [
			field("Customer", who(o.customer)),
			field("Account", `<@${o.account}>`),
			field("Placed", when(o.createdAt)),
			field("Claims", code(o.claims)),
			field("Received", code(o.received)),
			field("State", code(o.state)),
			field("Paid from", paidFromText(o.paidFrom)),
		];
		if (o.place) fields.push(field("Place in the whole queue", code(o.place)));
		if (o.reason) fields.push(field("Why it left early", o.reason, false));
		fields.push(field("Claims landed", claimsByType(o.claimsLanded), false));

		await inter.editReply({
			embeds: [
				embed({
					title: `📃 Order #${o.id}`,
					description: forAccount(o) ? `Bought by ${who(o.customer)}${forAccount(o)}.` : undefined,
					fields,
				}),
			],
		});
	},

	async button(inter) {
		// order.list:<user id>:<page>
		const [, userId, page] = inter.customId.split(":") as [string, string, string];
		await inter.deferUpdate();
		if (userId !== inter.user.id && !(await allowed(inter, Level.Moderator))) return;
		await inter.editReply(await listPage(userId, Number(page)));
	},
};

async function listPage(customerId: string, page: number): Promise<BaseMessageOptions> {
	const orders = await api.allOrders({ customer: customerId });
	const pages = Math.ceil(orders.length / PAGE_SIZE);
	page = Math.min(Math.max(1, page), Math.max(1, pages));
	const lines = orders
		.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
		.map((o) => `> ${orderNo(o.id)} · ${when(o.createdAt)} · ${code(o.state)} · ${progress(o)}${forAccount(o)}`);

	return {
		embeds: [
			embed({
				title: "📃 Orders",
				description: `Orders for ${who(customerId)}\n${lines.join("\n") || "No orders yet."}`,
				footer: pages > 1 ? `page ${page} of ${pages}` : undefined,
			}),
		],
		components: pageButtons(`order.list:${customerId}`, page, pages),
	};
}
