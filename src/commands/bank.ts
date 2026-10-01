import {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type RepliableInteraction,
	type SlashCommandIntegerOption,
	type User,
} from "discord.js";
import { api, keyKind } from "../api.ts";
import { code, done, embed, EPHEMERAL, field, refused, staffLog } from "../discord.ts";
import { expecting, historyPage } from "../history.ts";
import { allowed, Level } from "../permissions.ts";
import { leaderboardPage, pageButton } from "../views.ts";
import { idempotencyKey, type Command } from "./shared.ts";

const creditsOption = (o: SlashCommandIntegerOption, description: string) =>
	o.setName("credits").setDescription(description).setMinValue(1).setMaxValue(100_000).setRequired(true);

export const bank: Command = {
	data: new SlashCommandBuilder()
		.setName("bank")
		.setDescription("Customers' credits: 1 credit is 1 claim")
		.addSubcommand((s) =>
			s
				.setName("view")
				.setDescription("How many credits you or someone else holds")
				.addUserOption((o) => o.setName("user").setDescription("Whose credits to show")),
		)
		.addSubcommand((s) =>
			s
				.setName("leaderboard")
				.setDescription("Customers by credits, most first")
				.addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)),
		)
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription("Give a customer credits from the shop's balance (staff)")
				.addUserOption((o) => o.setName("user").setDescription("Who gets the credits").setRequired(true))
				.addIntegerOption((o) => creditsOption(o, "How many credits to give")),
		)
		.addSubcommand((s) =>
			s
				.setName("remove")
				.setDescription("Take credits back from a customer to the shop's balance (staff)")
				.addUserOption((o) => o.setName("user").setDescription("Who to take credits from").setRequired(true))
				.addIntegerOption((o) => creditsOption(o, "How many credits to take back")),
		)
		.addSubcommand((s) =>
			s
				.setName("transfer")
				.setDescription("Send some of your credits to someone else")
				.addUserOption((o) => o.setName("user").setDescription("Who gets the credits").setRequired(true))
				.addIntegerOption((o) => creditsOption(o, "How many credits to send"))
				.addUserOption((o) => o.setName("from").setDescription("Send from someone else instead (staff)")),
		)
		.addSubcommand((s) =>
			s
				.setName("history")
				.setDescription("Every change to your (or, for staff, someone's) credits, newest first")
				.addUserOption((o) => o.setName("user").setDescription("Whose history (staff)"))
				.addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)),
		),

	async run(inter) {
		switch (inter.options.getSubcommand()) {
			case "view":
				return view(inter, inter.options.getUser("user") ?? inter.user, false);
			case "leaderboard":
				await inter.deferReply(EPHEMERAL);
				return inter.editReply(await leaderboardPage(inter.options.getInteger("page") ?? 1));
			case "add":
				return change(inter, 1);
			case "remove":
				return change(inter, -1);
			case "transfer":
				return transfer(inter);
			case "history": {
				await inter.deferReply(EPHEMERAL);
				const user = inter.options.getUser("user") ?? inter.user;
				if (
					user.id !== inter.user.id &&
					!(await allowed(inter, Level.Moderator, "Only staff can see other people's credit history."))
				)
					return;
				return inter.editReply(await historyPage(keyKind(), user.id, inter.options.getInteger("page") ?? 1));
			}
		}
	},

	async button(inter) {
		if (!inter.customId.startsWith("bank.history:")) return pageButton(inter, leaderboardPage);
		// bank.history:<customer id>:<page>, always on an ephemeral reply
		const [, customerId, page] = inter.customId.split(":") as [string, string, string];
		await inter.deferUpdate();
		if (customerId !== inter.user.id && !(await allowed(inter, Level.Moderator))) return;
		await inter.editReply(await historyPage(keyKind(), customerId, Number(page)));
	},
};

export const bankView: Command = {
	data: new ContextMenuCommandBuilder().setName("Bank View").setType(ApplicationCommandType.User),
	menu: (inter) => view(inter, inter.targetUser, true),
};

async function view(inter: RepliableInteraction, user: User, ephemeral: boolean) {
	// Public for /bank view, as in the old bot.
	await inter.deferReply(ephemeral ? EPHEMERAL : {});
	const customer = await api.customer(user.id);
	const holder = user.id === inter.user.id ? "**You** have" : `<@${user.id}> has`;
	await inter.editReply({
		embeds: [
			embed({
				title: "🏦 Bank",
				description: `${holder} ${code(customer.credits)} credits.`,
				thumbnail: user.displayAvatarURL(),
			}),
		],
	});
}

async function change(inter: ChatInputCommandInteraction, sign: 1 | -1) {
	await inter.deferReply(EPHEMERAL);
	if (!(await allowed(inter, Level.Moderator))) return;

	const user = inter.options.getUser("user", true);
	const credits = inter.options.getInteger("credits", true);
	if (user.bot) return inter.editReply({ embeds: [refused("⛔ Not a customer", "Bots can't hold credits.")] });

	const { customer } = await expecting(
		{
			actorId: inter.user.id,
			customerId: user.id,
			cause: sign > 0 ? "given" : "taken_back",
			change: sign * credits,
		},
		() => api.changeCredits(user.id, sign * credits, idempotencyKey(inter)),
	);
	const title = sign > 0 ? "✅ Credits given" : "✅ Credits taken back";
	const fields = [
		field("Customer", `<@${user.id}>`),
		field(sign > 0 ? "Given" : "Taken back", `${code(credits)} credits`),
		field("They now hold", `${code(customer.credits)} credits`),
	];
	await inter.editReply({ embeds: [done(title, undefined, fields)] });
	await staffLog(inter.user.id, title, undefined, fields);
}

async function transfer(inter: ChatInputCommandInteraction) {
	await inter.deferReply(EPHEMERAL);
	const to = inter.options.getUser("user", true);
	const from = inter.options.getUser("from") ?? inter.user;
	const credits = inter.options.getInteger("credits", true);

	if (
		from.id !== inter.user.id &&
		!(await allowed(inter, Level.Moderator, "Only staff can send someone else's credits."))
	)
		return;
	if (from.id === to.id) {
		return inter.editReply({ embeds: [refused("⛔ Same person", "Credits can't be sent to the same person.")] });
	}
	if (to.bot) return inter.editReply({ embeds: [refused("⛔ Not a customer", "Bots can't hold credits.")] });

	const actorId = inter.user.id;
	const result = await expecting({ actorId, customerId: from.id, cause: "transferred_out", change: -credits }, () =>
		expecting({ actorId, customerId: to.id, cause: "transferred_in", change: credits }, () =>
			api.transfer(from.id, to.id, credits, idempotencyKey(inter)),
		),
	);
	const fields = [
		field("From", `<@${from.id}>, now ${code(result.from.credits)}`),
		field("To", `<@${to.id}>, now ${code(result.to.credits)}`),
		field("Credits", code(credits)),
	];
	await inter.editReply({ embeds: [done("✅ Credits transferred", undefined, fields)] });
	await staffLog(inter.user.id, "🔁 Credits transferred", undefined, fields);
}

export const balance: Command = {
	data: new SlashCommandBuilder().setName("balance").setDescription("Shop overview (staff)"),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Moderator))) return;
		const b = await api.balance();
		await inter.editReply({
			embeds: [
				embed({
					title: "💰 Balance",
					fields: [
						field("Shop's credits", code(b.credits)),
						field("Customers hold", code(b.customerCredits)),
						field("Orders in the queue", code(b.openOrders)),
						field("API key", code(keyKind())),
					],
				}),
			],
		});
	},
};
