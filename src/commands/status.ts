import { ActivityType, SlashCommandBuilder, type PresenceStatusData } from "discord.js";
import { prisma, settings, updateSettings } from "../db.ts";
import { client, code, done, EPHEMERAL, refused, staffLog } from "../discord.ts";
import { allowed, atLeast, Level, levelOf } from "../permissions.ts";
import type { Command } from "./shared.ts";

const typeNames: Record<number, string> = {
	[ActivityType.Playing]: "Playing",
	[ActivityType.Streaming]: "Streaming",
	[ActivityType.Listening]: "Listening to",
	[ActivityType.Watching]: "Watching",
	[ActivityType.Competing]: "Competing in",
};

let index = 0;

/** Shows the next status text. Runs every minute, and after every change. */
export async function rotateStatus() {
	const statuses = await prisma.status.findMany({ orderBy: { id: "asc" } });
	const status = statuses.length ? statuses[index++ % statuses.length]! : null;
	client.user?.setPresence({
		status: settings().presence as PresenceStatusData,
		activities: status
			? [
					{
						name: status.name,
						type: status.type,
						// Discord only shows "Streaming" with a Twitch or YouTube link.
						url: status.type === ActivityType.Streaming ? "https://twitch.tv/discord" : undefined,
					},
				]
			: [],
	});
}

export const status: Command = {
	data: new SlashCommandBuilder()
		.setName("status")
		.setDescription("The bot's rotating status texts (admins)")
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription("Add a status text")
				.addStringOption((o) =>
					o.setName("name").setDescription("The text").setRequired(true).setMaxLength(128),
				)
				.addIntegerOption((o) =>
					o
						.setName("type")
						.setDescription("Playing, Listening, ... (Playing if not set)")
						.addChoices(
							...Object.entries(typeNames).map(([value, name]) => ({ name, value: Number(value) })),
						),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("remove")
				.setDescription("Remove a status text")
				.addIntegerOption((o) =>
					o.setName("id").setDescription("Which one").setRequired(true).setAutocomplete(true),
				),
		)
		.addSubcommand((s) => s.setName("rotate").setDescription("Show the next status text now"))
		.addSubcommand((s) =>
			s
				.setName("presence")
				.setDescription("Online, idle, do not disturb or invisible")
				.addStringOption((o) =>
					o
						.setName("status")
						.setDescription("The presence")
						.setRequired(true)
						.addChoices(
							{ name: "Online", value: "online" },
							{ name: "Idle", value: "idle" },
							{ name: "Do not disturb", value: "dnd" },
							{ name: "Invisible", value: "invisible" },
						),
				),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Administrator))) return;

		let what: string;
		switch (inter.options.getSubcommand()) {
			case "add": {
				const name = inter.options.getString("name", true);
				const type = inter.options.getInteger("type") ?? ActivityType.Playing;
				await prisma.status.create({ data: { name, type } });
				what = `Status added: ${typeNames[type]} ${code(name)}`;
				break;
			}
			case "remove": {
				const removed = await prisma.status.deleteMany({ where: { id: inter.options.getInteger("id", true) } });
				if (!removed.count) {
					return inter.editReply({ embeds: [refused("⛔ Not found", "Pick a status text from the list.")] });
				}
				what = "Status text removed";
				break;
			}
			case "rotate":
				await rotateStatus();
				return inter.editReply({ embeds: [done("✅ Rotated")] });
			default: {
				const presence = inter.options.getString("status", true);
				await updateSettings({ presence });
				what = `Presence: ${code(presence)}`;
			}
		}

		await rotateStatus();
		await staffLog(inter.user.id, "🟢 Status changed", what);
		return inter.editReply({ embeds: [done("✅ Saved", what)] });
	},

	async autocomplete(inter) {
		if (!atLeast(await levelOf(inter.user.id), Level.Administrator)) return inter.respond([]);
		const statuses = await prisma.status.findMany({ orderBy: { id: "asc" } });
		return inter.respond(
			statuses
				.slice(0, 25)
				.map((s) => ({ name: `${typeNames[s.type] ?? ""} ${s.name}`.slice(0, 100), value: s.id })),
		);
	},
};
