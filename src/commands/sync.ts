import { SlashCommandBuilder } from "discord.js";
import { api } from "../api.ts";
import { settings } from "../db.ts";
import { code, done, EPHEMERAL, field, guild, isDiscordId, refused, staffLog } from "../discord.ts";
import { allowed, Level } from "../permissions.ts";
import type { Command } from "./shared.ts";

export const sync: Command = {
	data: new SlashCommandBuilder()
		.setName("sync")
		.setDescription("Sync Discord roles with the bank")
		.addSubcommand((s) =>
			s.setName("roles").setDescription("Give the customer role to every customer who lacks it (staff)"),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Moderator))) return;

		const roleId = settings().roleCustomer;
		const server = guild();
		if (!roleId || !server) {
			return inter.editReply({
				embeds: [refused("⛔ No customer role", "Set one first with `/settings bot role`.")],
			});
		}

		// Customers holding credits, and customers with a waiting order.
		const ids = new Set<string>();
		for (let offset = 0; ; offset += 100) {
			const page = await api.customers(100, offset);
			page.customers.forEach((c) => ids.add(c.id));
			if (offset + 100 >= page.total.customers) break;
		}
		for (const o of await api.allOrders({ state: "pending" })) if (o.customer) ids.add(o.customer);

		let given = 0;
		let had = 0;
		let away = 0;
		let failed = 0;
		// ponytail: one member fetch per customer; fine for hundreds, batch by guild.members.fetch({ user: [...] }) for thousands.
		for (const id of [...ids].filter(isDiscordId)) {
			const member = await server.members.fetch(id).catch(() => null);
			if (!member) away++;
			else if (member.roles.cache.has(roleId)) had++;
			else
				await member.roles
					.add(roleId)
					.then(() => given++)
					.catch(() => failed++);
		}

		const fields = [
			field("Given", code(given)),
			field("Already had it", code(had)),
			field("Not in the server", code(away)),
			field("Failed", code(failed)),
		];
		await inter.editReply({ embeds: [done("✅ Roles synced", `The customer role is <@&${roleId}>.`, fields)] });
		await staffLog(inter.user.id, "🔄 Roles synced", undefined, fields);
	},
};
