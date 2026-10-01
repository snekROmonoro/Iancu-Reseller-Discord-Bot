import { SlashCommandBuilder } from "discord.js";
import { api, keyKind, type SimulateResult } from "../api.ts";
import { code, done, EPHEMERAL, field, orderNo, progress, refused, warning } from "../discord.ts";
import { allowed, atLeast, Level, levelOf } from "../permissions.ts";
import { orderChoices, type Command } from "./shared.ts";

const results: Record<SimulateResult, { label: string; description: string }> = {
	claim: { label: "Claim landed", description: "A claim lands (the last one completes the order)" },
	captcha: { label: "Captcha", description: "The account keeps getting a captcha, so the order is released" },
	token_invalid: { label: "Token invalid", description: "The token stops working, so the order is released" },
	token_locked: { label: "Account locked", description: "The account needs verifying, so the order is released" },
};

const data = new SlashCommandBuilder()
	.setName("test")
	.setDescription("Move a test order on, to see every message without a real claim (admins, test key only)");
for (const [name, { description }] of Object.entries(results)) {
	data.addSubcommand((s) =>
		s
			.setName(name)
			.setDescription(description)
			.addIntegerOption((o) =>
				o
					.setName("order")
					.setDescription("Which test order (the first waiting one if not set)")
					.setAutocomplete(true),
			),
	);
}

export const test: Command = {
	data,

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Administrator))) return;

		if (keyKind() !== "test") {
			return inter.editReply({
				embeds: [
					warning("🧪 Live key", "`/test` only works while the bot runs with a test key. Nothing was done."),
				],
			});
		}

		const result = inter.options.getSubcommand() as SimulateResult;
		let id = inter.options.getInteger("order");
		if (!id) {
			const { places } = await api.queue();
			id = places.sort((a, b) => a.place - b.place)[0]?.orderId ?? null;
		}
		if (!id) {
			return inter.editReply({
				embeds: [
					refused("⛔ Nothing waiting", "There is no waiting test order. Place one with `/redeem` first."),
				],
			});
		}

		const { order, refunded } = await api.simulate(id, result);
		const fields = [
			field("Order", orderNo(order.id)),
			field("State", code(order.state)),
			field("Received", progress(order)),
		];
		if (refunded !== undefined) fields.push(field("Refunded", code(refunded)));
		return inter.editReply({
			embeds: [done(`🧪 Simulated: ${results[result].label}`, results[result].description, fields)],
		});
	},

	async autocomplete(inter) {
		if (!atLeast(await levelOf(inter.user.id), Level.Administrator)) return inter.respond([]);
		return orderChoices(inter);
	},
};
