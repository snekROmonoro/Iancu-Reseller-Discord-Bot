import { SlashCommandBuilder } from "discord.js";
import { prisma } from "../db.ts";
import { code, done, embed, EPHEMERAL, refused, staffLog } from "../discord.ts";
import { env } from "../env.ts";
import { allowed, Level, levelNames } from "../permissions.ts";
import type { Command } from "./shared.ts";

export const staff: Command = {
	data: new SlashCommandBuilder()
		.setName("staff")
		.setDescription("The bot's staff and their levels")
		.addSubcommand((s) => s.setName("list").setDescription("Staff and their levels (staff)"))
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription("Add a staff member, or change their level (Super Administrator)")
				.addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
				.addIntegerOption((o) =>
					o
						.setName("level")
						.setDescription("Their level")
						.setRequired(true)
						.addChoices(
							{ name: "Moderator", value: Level.Moderator },
							{ name: "Administrator", value: Level.Administrator },
							{ name: "Super Administrator", value: Level.SuperAdministrator },
						),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("remove")
				.setDescription("Remove a staff member (Super Administrator)")
				.addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true)),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		const sub = inter.options.getSubcommand();

		if (sub === "list") {
			if (!(await allowed(inter, Level.Moderator))) return;
			const rows = await prisma.staff.findMany({ orderBy: { level: "desc" } });
			const lines = [
				`> <@${env.superAdministrator}> · **Super Administrator** (from .env)`,
				...rows.map((s) => `> <@${s.userId}> · **${levelNames[s.level]}**`),
			];
			return inter.editReply({ embeds: [embed({ title: "👥 Staff", description: lines.join("\n") })] });
		}

		if (!(await allowed(inter, Level.SuperAdministrator))) return;
		const user = inter.options.getUser("user", true);
		if (user.id === env.superAdministrator) {
			return inter.editReply({
				embeds: [refused("⛔ Set in .env", "That person is the Super Administrator from `.env`.")],
			});
		}

		if (sub === "add") {
			if (user.bot) return inter.editReply({ embeds: [refused("⛔ Not a person", "Bots can't be staff.")] });
			const level = inter.options.getInteger("level", true);
			await prisma.staff.upsert({
				where: { userId: user.id },
				create: { userId: user.id, level },
				update: { level },
			});
			const what = `<@${user.id}> is now ${code(levelNames[level]!)}.`;
			await staffLog(inter.user.id, "👥 Staff changed", what);
			return inter.editReply({ embeds: [done("✅ Staff saved", what)] });
		}

		const removed = await prisma.staff.deleteMany({ where: { userId: user.id } });
		if (!removed.count)
			return inter.editReply({ embeds: [refused("⛔ Not staff", `<@${user.id}> is not staff.`)] });
		const what = `<@${user.id}> is no longer staff.`;
		await staffLog(inter.user.id, "👥 Staff changed", what);
		return inter.editReply({ embeds: [done("✅ Staff removed", what)] });
	},
};
