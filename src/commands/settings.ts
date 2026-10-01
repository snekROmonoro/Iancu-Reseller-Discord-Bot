import {
	ChannelType,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type SlashCommandChannelOption,
	type TextChannel,
} from "discord.js";
import { updateSettings } from "../db.ts";
import { code, done, EPHEMERAL, refused, staffLog, warning } from "../discord.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { allowed, Level } from "../permissions.ts";
import { post, refresh } from "../views.ts";
import type { Command } from "./shared.ts";

const channelOption = (o: SlashCommandChannelOption, description: string) =>
	o.setName("channel").setDescription(description).addChannelTypes(ChannelType.GuildText).setRequired(true);

const emojiSettings = {
	queue_active: { label: "Queue Active", column: "emojiQueueActive" },
	queue_waiting: { label: "Queue Waiting", column: "emojiQueueWaiting" },
	nitro: { label: "Nitro", column: "emojiNitro" },
	nitro_classic: { label: "Nitro Classic", column: "emojiNitroClassic" },
	nitro_basic: { label: "Nitro Basic", column: "emojiNitroBasic" },
	claims_reaction: { label: "Claims Reaction", column: "emojiClaimsReaction" },
} as const;

/** Channels and roles can only be picked inside the server. Replies and returns false in a DM. */
export async function inServer(inter: ChatInputCommandInteraction) {
	if (inter.inGuild()) return true;
	await inter.editReply({
		embeds: [refused("🏠 Run it in the server", "Channels and roles can only be picked inside the server.")],
	});
	return false;
}

/** The `channel` option, if it is a text channel the bot can post embeds in; otherwise replies why not. */
export async function checkChannel(inter: ChatInputCommandInteraction): Promise<TextChannel | null> {
	const channel = inter.guild?.channels.cache.get(inter.options.getChannel("channel", true).id);
	if (channel?.type !== ChannelType.GuildText) {
		await inter.editReply({ embeds: [refused("⛔ Not a text channel", "Please pick a text channel.")] });
		return null;
	}
	const me = inter.guild!.members.me;
	const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
	if (!me || !channel.permissionsFor(me).has(needed)) {
		await inter.editReply({
			embeds: [
				refused(
					"⛔ Can't post there",
					`I need View Channel, Send Messages and Embed Links in <#${channel.id}>.`,
				),
			],
		});
		return null;
	}
	return channel;
}

export const settingsCommand: Command = {
	data: new SlashCommandBuilder()
		.setName("settings")
		.setDescription("The bot's settings (admins)")
		.addSubcommandGroup((g) =>
			g
				.setName("bot")
				.setDescription("Server, logs, emojis and roles")
				.addSubcommand((s) =>
					s.setName("guild").setDescription("Serve this server (clears every channel and role setting)"),
				)
				.addSubcommand((s) =>
					s
						.setName("logs")
						.setDescription("The staff logs channel")
						.addChannelOption((o) => channelOption(o, "Where staff actions and events are logged")),
				)
				.addSubcommand((s) =>
					s
						.setName("emoji")
						.setDescription("Set one of the bot's emojis")
						.addStringOption((o) =>
							o
								.setName("which")
								.setDescription("Which emoji")
								.setRequired(true)
								.addChoices(
									...Object.entries(emojiSettings).map(([value, { label }]) => ({
										name: label,
										value,
									})),
								),
						)
						.addStringOption((o) => o.setName("emoji").setDescription("The emoji").setRequired(true)),
				)
				.addSubcommand((s) =>
					s
						.setName("role")
						.setDescription("Set the customer role or the claim-ping role")
						.addStringOption((o) =>
							o
								.setName("which")
								.setDescription("Which role")
								.setRequired(true)
								.addChoices(
									{ name: "Customer", value: "customer" },
									{ name: "Claim Ping", value: "claim_ping" },
								),
						)
						.addRoleOption((o) => o.setName("role").setDescription("The role").setRequired(true)),
				),
		)
		.addSubcommandGroup((g) =>
			g
				.setName("claims")
				.setDescription("How claims are announced")
				.addSubcommand((s) =>
					s
						.setName("style")
						.setDescription("As an embed, or as one line of text")
						.addStringOption((o) =>
							o
								.setName("style")
								.setDescription("The style")
								.setRequired(true)
								.addChoices({ name: "Embed", value: "card" }, { name: "Text", value: "line" }),
						),
				)
				.addSubcommand((s) =>
					s
						.setName("channel")
						.setDescription("The public claims channel")
						.addChannelOption((o) => channelOption(o, "Where claims are announced")),
				),
		)
		.addSubcommandGroup((g) =>
			g
				.setName("queue")
				.setDescription("The queue message")
				.addSubcommand((s) =>
					s
						.setName("channel")
						.setDescription("Post the queue message in a channel, replacing the old one")
						.addChannelOption((o) => channelOption(o, "Where to post it")),
				)
				.addSubcommand((s) =>
					s
						.setName("show-names")
						.setDescription("Show display names in the queue (otherwise mentions)")
						.addBooleanOption((o) => o.setName("show").setDescription("Show names").setRequired(true)),
				)
				.addSubcommand((s) =>
					s
						.setName("count")
						.setDescription("How queue places are numbered")
						.addStringOption((o) =>
							o
								.setName("mode")
								.setDescription("Out of the whole queue, or out of this shop's orders")
								.setRequired(true)
								.addChoices({ name: "Global", value: "all" }, { name: "Local", value: "shop" }),
						),
				),
		)
		.addSubcommandGroup((g) =>
			g
				.setName("bank")
				.setDescription("The bank leaderboard message")
				.addSubcommand((s) =>
					s
						.setName("leaderboard")
						.setDescription("Post the leaderboard message in a channel, replacing the old one")
						.addChannelOption((o) => channelOption(o, "Where to post it")),
				),
		),

	async run(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Administrator))) return;

		const group = inter.options.getSubcommandGroup(true);
		const sub = inter.options.getSubcommand(true);

		const save = async (data: Prisma.SettingsUpdateInput, what: string) => {
			await updateSettings(data);
			await staffLog(inter.user.id, "⚙️ Settings changed", what);
			await inter.editReply({ embeds: [done("✅ Saved", what)] });
		};

		switch (`${group} ${sub}`) {
			case "bot guild": {
				if (!(await inServer(inter))) return;
				await updateSettings({
					guildId: inter.guildId!,
					logsChannel: "",
					roleCustomer: "",
					roleClaimPing: "",
					claimsChannel: "",
					queueChannel: "",
					queueMessage: "",
					leaderboardChannel: "",
					leaderboardMessage: "",
					faqChannel: "",
					faqMessage: "",
				});
				return inter.editReply({
					embeds: [
						done(
							"✅ Server set",
							`This bot now serves **${inter.guild?.name}**, here and in DMs.\nChannel and role settings were cleared: set them with the rest of \`/settings\`.`,
						),
					],
				});
			}

			case "bot logs": {
				if (!(await inServer(inter))) return;
				const channel = await checkChannel(inter);
				if (!channel) return;
				return save({ logsChannel: channel.id }, `Logs channel: <#${channel.id}>`);
			}

			case "bot emoji": {
				const which = inter.options.getString("which", true) as keyof typeof emojiSettings;
				const emoji = inter.options.getString("emoji", true).trim();
				if (!(await canReact(inter, emoji))) return;
				await save(
					{ [emojiSettings[which].column]: emoji },
					`Emoji **${emojiSettings[which].label}**: ${emoji}`,
				);
				if (which.startsWith("queue_")) await refresh("queue");
				return;
			}

			case "bot role": {
				if (!(await inServer(inter))) return;
				const which = inter.options.getString("which", true);
				const role = inter.options.getRole("role", true);
				const field = which === "customer" ? "roleCustomer" : "roleClaimPing";
				await save(
					{ [field]: role.id },
					`Role **${which === "customer" ? "Customer" : "Claim Ping"}**: <@&${role.id}>`,
				);
				const me = inter.guild!.members.me;
				const editable =
					!!me &&
					me.roles.highest.position > role.position &&
					me.permissions.has(PermissionFlagsBits.ManageRoles);
				const mentionable = role.mentionable || !!me?.permissions.has(PermissionFlagsBits.MentionEveryone);
				if (which === "customer" && !editable)
					return warn(
						inter,
						"I can't give that role yet: I need Manage Roles, and my own role must be above it.",
					);
				if (which === "claim_ping" && !mentionable)
					return warn(inter, "I can't ping that role yet: make it mentionable, or give me Mention Everyone.");
				return;
			}

			case "claims style": {
				const style = inter.options.getString("style", true);
				return save({ claimsStyle: style }, `Claims style: ${code(style === "line" ? "Text" : "Embed")}`);
			}

			case "claims channel": {
				if (!(await inServer(inter))) return;
				const channel = await checkChannel(inter);
				if (!channel) return;
				return save({ claimsChannel: channel.id }, `Claims channel: <#${channel.id}>`);
			}

			case "queue channel":
			case "bank leaderboard": {
				if (!(await inServer(inter))) return;
				const channel = await checkChannel(inter);
				if (!channel) return;
				const kind = group === "queue" ? "queue" : "leaderboard";
				await post(kind, channel);
				const what = `${kind === "queue" ? "Queue" : "Bank leaderboard"} message posted in <#${channel.id}>`;
				await staffLog(inter.user.id, "⚙️ Settings changed", what);
				return inter.editReply({ embeds: [done("✅ Saved", what)] });
			}

			case "queue show-names": {
				const show = inter.options.getBoolean("show", true);
				await save({ queueShowNames: show }, `Show names in the queue: ${code(show ? "yes" : "no")}`);
				return refresh("queue");
			}

			case "queue count": {
				const mode = inter.options.getString("mode", true);
				await save({ queueCount: mode }, `Queue places: ${code(mode === "shop" ? "Local" : "Global")}`);
				return refresh("queue");
			}
		}
	},
};

async function warn(inter: ChatInputCommandInteraction, text: string) {
	await inter.followUp({ embeds: [warning("⚠️ Saved, but", text)], ...EPHEMERAL });
}

/** Checked by reacting with it once, on a short message deleted straight after. */
async function canReact(inter: ChatInputCommandInteraction, emoji: string) {
	const channel = inter.channel?.isSendable() ? inter.channel : await inter.user.createDM();
	let ok = false;
	const message = await channel.send({ content: "Testing emoji…" }).catch(() => null);
	if (message) {
		ok = await message
			.react(emoji)
			.then(() => true)
			.catch(() => false);
		await message.delete().catch(() => {});
	}
	if (!ok) {
		await inter.editReply({
			embeds: [
				refused(
					"⛔ Unknown emoji",
					"I couldn't react with that emoji. Use one from a server I'm in, or a normal emoji.",
				),
			],
		});
	}
	return ok;
}
