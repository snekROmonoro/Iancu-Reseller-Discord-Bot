// The queue, leaderboard and FAQ pages, shared by the commands and by the messages kept up to date.
import {
	DiscordAPIError,
	MessageFlags,
	RESTJSONErrorCodes,
	type BaseMessageOptions,
	type ButtonInteraction,
	type SendableChannels,
} from "discord.js";
import { api, type Order } from "./api.ts";
import { prisma, settings, updateSettings } from "./db.ts";
import {
	client,
	code,
	displayName,
	embed,
	EPHEMERAL,
	eventLog,
	isDiscordId,
	pageButtons,
	paginate,
	progress,
	who,
} from "./discord.ts";
import { log } from "./log.ts";

const PAGE_SIZE = 20;

const clampPage = (page: number, pages: number) => Math.min(Math.max(1, page || 1), Math.max(1, pages));

// ---- Queue ----

/** The shop's waiting orders in queue order, and how to show each one's place. */
export async function waitingOrders() {
	const countAll = settings().queueCount !== "shop";
	const [orders, queue] = await Promise.all([api.allOrders({ state: "pending" }), countAll ? api.queue() : null]);
	orders.sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity));
	const index = new Map(orders.map((o, i) => [o.id, i + 1]));
	// Out of the whole queue (the API's count), or numbered 1, 2, 3 among this shop's own orders.
	const place = (o: Order) => (queue ? `${o.place}/${queue.length}` : `${index.get(o.id)}/${orders.length}`);
	return { orders, queue, place };
}

export async function queuePage(page: number): Promise<BaseMessageOptions> {
	const s = settings();
	const { orders, queue, place } = await waitingOrders();
	const pages = Math.ceil(orders.length / PAGE_SIZE);
	page = clampPage(page, pages);

	const lines = await Promise.all(
		orders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(async (o) => {
			const emoji = o.place === 1 ? s.emojiQueueActive : s.emojiQueueWaiting;
			const name =
				o.customer && isDiscordId(o.customer) && s.queueShowNames
					? code(await displayName(o.customer))
					: who(o.customer);
			return `> ${emoji ? `${emoji} ` : ""}${code(place(o))} ${name} ${progress(o)}`;
		}),
	);

	const claimsLeft = orders.reduce((sum, o) => sum + o.claims - o.received, 0);
	const footer = [`${orders.length} orders`, `${claimsLeft} claims left`];
	if (queue) footer.push(`${queue.length} waiting in all`);
	if (pages > 1) footer.push(`page ${page} of ${pages}`);

	return {
		embeds: [
			embed({
				title: "📝 Queue",
				description: lines.join("\n") || "Nobody is waiting.",
				footer: footer.join(" · "),
			}),
		],
		components: pageButtons("queue.page", page, pages),
	};
}

// ---- Bank leaderboard ----

export async function leaderboardPage(page: number): Promise<BaseMessageOptions> {
	const first = await api.customers(PAGE_SIZE, (Math.max(1, page) - 1) * PAGE_SIZE);
	const pages = Math.ceil(first.total.customers / PAGE_SIZE);
	const clamped = clampPage(page, pages);
	const { customers, total } = clamped === page ? first : await api.customers(PAGE_SIZE, (clamped - 1) * PAGE_SIZE);

	const lines = customers.map(
		(c, i) => `> **${(clamped - 1) * PAGE_SIZE + i + 1}.** ${who(c.id)} · ${code(c.credits)} credits`,
	);
	const footer = `${total.credits} total credits · ${total.customers} customers · page ${clamped} of ${Math.max(1, pages)}`;

	return {
		embeds: [
			embed({
				title: "🏦 Bank leaderboard",
				description: lines.join("\n") || "Nobody holds credits yet.",
				footer,
			}),
		],
		components: pageButtons("bank.page", clamped, pages),
	};
}

// ---- FAQ ----

export const FAQ_PAGE_LENGTH = 4096;

export const faqEntryText = (question: string, answer: string) => `**Q**: ${question}\n**A**: ${answer}\n`;

export async function faqPage(page: number): Promise<BaseMessageOptions> {
	const entries = await prisma.faq.findMany({ orderBy: { position: "asc" } });
	const pages = paginate(
		entries.map((e) => faqEntryText(e.question, e.answer)),
		FAQ_PAGE_LENGTH,
	);
	page = clampPage(page, pages.length);
	return {
		embeds: [
			embed({
				title: "❓ FAQ",
				description: pages[page - 1] ?? "No questions yet.",
				footer: pages.length > 1 ? `page ${page} of ${pages.length}` : undefined,
			}),
		],
		components: pageButtons("faq.page", page, pages.length),
	};
}

/**
 * Page buttons: on a shared message they open that page for whoever pressed, ephemerally;
 * on an ephemeral page they update it in place.
 */
export async function pageButton(inter: ButtonInteraction, render: (page: number) => Promise<BaseMessageOptions>) {
	const page = Number(inter.customId.split(":").at(-1));
	if (inter.message.flags.has(MessageFlags.Ephemeral)) await inter.deferUpdate();
	else await inter.deferReply(EPHEMERAL);
	await inter.editReply(await render(page));
}

// ---- Messages kept up to date ----

export type Kept = "queue" | "leaderboard" | "faq";

const kept = {
	queue: { channel: "queueChannel", message: "queueMessage", render: queuePage, command: "/settings queue channel" },
	leaderboard: {
		channel: "leaderboardChannel",
		message: "leaderboardMessage",
		render: leaderboardPage,
		command: "/settings bank leaderboard",
	},
	faq: { channel: "faqChannel", message: "faqMessage", render: faqPage, command: "/faq channel" },
} as const;

const lastRefresh: Record<Kept, number> = { queue: 0, leaderboard: 0, faq: 0 };
const pending: Partial<Record<Kept, NodeJS.Timeout>> = {};

/** Edits the message in place. A deleted message is noted in the logs once and the setting cleared. */
export async function refresh(kind: Kept) {
	lastRefresh[kind] = Date.now();
	const k = kept[kind];
	const s = settings();
	if (!s[k.channel] || !s[k.message]) return;

	try {
		const view = await k.render(1);
		const channel = await client.channels.fetch(s[k.channel]);
		if (!channel?.isTextBased()) throw new Error("not a text channel");
		const message = await channel.messages.fetch(s[k.message]);
		await message.edit(view);
	} catch (e) {
		const gone =
			e instanceof DiscordAPIError &&
			(e.code === RESTJSONErrorCodes.UnknownMessage || e.code === RESTJSONErrorCodes.UnknownChannel);
		if (!gone) return log.warn(`Could not refresh the ${kind} message:`, e);
		await updateSettings({ [k.channel]: "", [k.message]: "" });
		await eventLog(
			"🗑️ Message deleted",
			`The ${kind} message was deleted, so it is no longer kept up to date. Post it again with \`${k.command}\`.`,
		);
	}
}

/** Refresh within 30 seconds, and no more often than that. */
export function soon(kind: Kept) {
	if (pending[kind]) return;
	const wait = Math.max(0, lastRefresh[kind] + 30_000 - Date.now());
	pending[kind] = setTimeout(() => {
		pending[kind] = undefined;
		void refresh(kind);
	}, wait);
}

/** Posts the message in a channel, replacing the old one. */
export async function post(kind: Kept, channel: SendableChannels) {
	const k = kept[kind];
	const s = settings();
	if (s[k.channel] && s[k.message]) {
		const old = await client.channels.fetch(s[k.channel]).catch(() => null);
		if (old?.isTextBased()) await old.messages.delete(s[k.message]).catch(() => {});
	}
	const message = await channel.send(await k.render(1));
	await updateSettings({ [k.channel]: channel.id, [k.message]: message.id });
}

const timers: NodeJS.Timeout[] = [];

export function startRefreshing() {
	timers.push(
		setInterval(() => void refresh("queue"), 5 * 60_000),
		setInterval(() => void refresh("leaderboard"), 10 * 60_000),
		setInterval(() => void refresh("faq"), 10 * 60_000),
	);
	for (const kind of Object.keys(kept) as Kept[]) void refresh(kind);
}

export function stopRefreshing() {
	for (const timer of [...timers, ...Object.values(pending)]) clearTimeout(timer);
}
