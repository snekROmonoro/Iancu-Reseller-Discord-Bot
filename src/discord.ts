import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	GatewayIntentBits,
	MessageFlags,
	Partials,
	type APIEmbed,
	type APIEmbedField,
	type BaseMessageOptions,
	type RepliableInteraction,
} from "discord.js";
import type { Claim, Order } from "./api.ts";
import { settings } from "./db.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";

// Guilds is the only intent: nothing privileged. Mentions never ping unless a message says so.
export const client = new Client({
	intents: [GatewayIntentBits.Guilds],
	partials: [Partials.Channel],
	allowedMentions: { parse: [] },
});

export const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;

export const Colors = {
	done: 0x57f287,
	refused: 0xed4245,
	warning: 0xfee75c,
	claim: 0xf47fff,
	staffLog: 0x5865f2,
	eventLog: 0x99aab5,
};

// ---- The configured server ----

export const guild = () => client.guilds.cache.get(settings().guildId);

export const shopName = () => env.shopName;

/** The member's name in the configured server, or their Discord name. */
export async function displayName(userId: string) {
	const member = await guild()
		?.members.fetch(userId)
		.catch(() => null);
	const name = member?.displayName ?? (await client.users.fetch(userId).catch(() => null))?.displayName ?? userId;
	return name.replaceAll("`", "'");
}

export async function addCustomerRole(customerId: string | null | undefined) {
	const roleId = settings().roleCustomer;
	if (!roleId || !customerId || !isDiscordId(customerId)) return;
	const member = await guild()
		?.members.fetch(customerId)
		.catch(() => null);
	if (member && !member.roles.cache.has(roleId)) {
		await member.roles.add(roleId).catch((e) => log.warn(`Could not give the customer role to ${customerId}:`, e));
	}
}

/** Messages a customer; somebody who does not accept DMs (or a website customer) is skipped quietly. */
export async function dm(customerId: string | null | undefined, embed: APIEmbed) {
	if (!customerId || !isDiscordId(customerId)) return;
	await client.users.send(customerId, { embeds: [embed] }).catch(() => {});
}

// ---- Embeds ----

type EmbedInput = {
	title: string;
	description?: string;
	fields?: APIEmbedField[];
	color?: number;
	thumbnail?: string;
	footer?: string;
};

export function embed(e: EmbedInput): APIEmbed {
	return {
		title: e.title,
		description: e.description,
		fields: e.fields,
		color: e.color ?? env.embedColor,
		thumbnail: e.thumbnail ? { url: e.thumbnail } : undefined,
		footer: {
			text: e.footer ? `${e.footer} · ${shopName()}` : shopName(),
			icon_url: guild()?.iconURL() ?? undefined,
		},
		timestamp: new Date().toISOString(),
	};
}

export const done = (title: string, description?: string, fields?: APIEmbedField[]) =>
	embed({ title, description, fields, color: Colors.done });
export const refused = (title: string, description?: string, fields?: APIEmbedField[]) =>
	embed({ title, description, fields, color: Colors.refused });
export const warning = (title: string, description?: string, fields?: APIEmbedField[]) =>
	embed({ title, description, fields, color: Colors.warning });

export const field = (name: string, value: string | number, inline = true): APIEmbedField => ({
	name,
	value: String(value),
	inline,
});

/** Replies, or edits the reply when the interaction was already deferred or answered. */
export async function respond(inter: RepliableInteraction, payload: BaseMessageOptions) {
	if (inter.deferred || inter.replied) await inter.editReply(payload);
	else await inter.reply({ ...payload, ...EPHEMERAL });
}

// ---- Formatting ----

export const code = (value: string | number) => `\`${value}\``;
export const orderNo = (id: number) => code(`#${id}`);
export const progress = (o: Pick<Order, "received" | "claims">) => code(`${o.received}/${o.claims}`);
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export const when = (iso?: string) => (iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:f>` : "-");

/** Discord ids are all digits; anything else is the shop's own id for a website customer. */
export const isDiscordId = (id: string) => /^\d+$/.test(id);

/** A mention for a Discord user, the id as text for a website customer. Never put a mention in code. */
export const who = (customerId: string | null | undefined) =>
	!customerId ? "nobody" : isDiscordId(customerId) ? `<@${customerId}>` : code(customerId);

/** " for account @x" when the order was bought for somebody else's account. */
export const forAccount = (o: Pick<Order, "account" | "customer">) =>
	o.customer && o.account !== o.customer ? ` for account <@${o.account}>` : "";

/** NITRO_CLASSIC_MONTHLY -> Nitro Classic Monthly */
export const claimName = (type: string) =>
	type
		.split("_")
		.map((word) => word.charAt(0) + word.slice(1).toLowerCase())
		.join(" ");

export function claimEmoji(type: string) {
	const s = settings();
	if (type === "NITRO_MONTHLY" || type === "NITRO_YEARLY") return s.emojiNitro || "💎";
	if (type.startsWith("NITRO_CLASSIC_")) return s.emojiNitroClassic || "💎";
	if (type.startsWith("NITRO_BASIC_")) return s.emojiNitroBasic || "💎";
	return "✨";
}

/** "`2x Nitro Monthly`" lines, one per type. */
export function claimsByType(claims: Claim[]) {
	const counts = new Map<string, number>();
	for (const claim of claims) counts.set(claim.type, (counts.get(claim.type) ?? 0) + 1);
	return [...counts].map(([type, count]) => code(`${count}x ${claimName(type)}`)).join("\n") || "none yet";
}

export const paidFromText = (paidFrom: Order["paidFrom"]) =>
	paidFrom === "customer" ? "customer's credits" : "shop's balance";

/** Splits lines into pages of at most `max` characters. */
export function paginate(lines: string[], max: number) {
	const pages: string[] = [];
	let page = "";
	for (const line of lines) {
		if (page && page.length + line.length + 1 > max) {
			pages.push(page);
			page = "";
		}
		page = page ? `${page}\n${line}` : line;
	}
	if (page) pages.push(page);
	return pages;
}

/** ◀ ▶ buttons whose ids carry the page they open (`queue.page:3`), so they work after a restart. */
export function pageButtons(prefix: string, page: number, pages: number) {
	if (pages <= 1) return [];
	return [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${prefix}:${page - 1}`)
				.setLabel("◀")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(page <= 1),
			new ButtonBuilder()
				.setCustomId(`${prefix}:${page + 1}`)
				.setLabel("▶")
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(page >= pages),
		),
	];
}

// ---- Logs channel ----

async function sendLog(e: APIEmbed) {
	const channelId = settings().logsChannel;
	if (!channelId) return;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!channel?.isSendable()) return;
	await channel.send({ embeds: [e] }).catch((err) => log.warn("Could not write to the logs channel:", err));
}

/** A staff action, naming who took it. */
export const staffLog = (actorId: string, title: string, description?: string, fields?: APIEmbedField[]) =>
	sendLog(
		embed({
			title,
			description: `By <@${actorId}>${description ? `\n${description}` : ""}`,
			fields,
			color: Colors.staffLog,
		}),
	);

/** Something that happened on its own (an event from the feed). */
export const eventLog = (title: string, description?: string, fields?: APIEmbedField[]) =>
	sendLog(embed({ title, description, fields, color: Colors.eventLog }));
