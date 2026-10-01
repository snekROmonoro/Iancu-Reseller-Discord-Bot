// Customers' credit history, recorded from the events feed. The feed does not say who made a change,
// so the bot notes what it is about to do (`expecting`) and the matching event takes that person.
import type { BaseMessageOptions } from "discord.js";
import type { FeedEvent } from "./api.ts";
import { prisma } from "./db.ts";
import { code, embed, orderNo, pageButtons, who } from "./discord.ts";

export const customerCauses: Record<string, string> = {
	given: "given by the shop",
	taken_back: "taken back by the shop",
	spent: "spent on an order",
	refunded: "refunded from an order",
	transferred_in: "received from another customer",
	transferred_out: "sent to another customer",
};

/** The words for a cause code, or the code with spaces if it is a new one. */
export const describe = (causes: Record<string, string>, cause = "") => causes[cause] ?? cause.replaceAll("_", " ");

// ---- Who did it ----

export interface Expected {
	actorId: string;
	/** Left out when not known beforehand (a staff /queue remove refund). */
	customerId?: string;
	cause: string;
	/** Left out when the amount is not known beforehand (an API refund). */
	change?: number;
	orderId?: number;
	at: number;
}

const expected: Expected[] = [];
const EXPIRES_MS = 10 * 60_000;

/** Notes a change the bot is about to make for `actorId`, then makes it; forgotten again if the call fails. */
export async function expecting<T>(e: Omit<Expected, "at">, call: () => Promise<T>): Promise<T> {
	const now = Date.now();
	// ponytail: a restart forgets these, so changes in flight then are recorded without a person.
	while (expected.length && expected[0]!.at < now - EXPIRES_MS) expected.shift();
	const entry = { ...e, at: now };
	expected.push(entry);
	try {
		return await call();
	} catch (err) {
		const i = expected.indexOf(entry);
		if (i >= 0) expected.splice(i, 1);
		throw err;
	}
}

/** Takes the first expectation this credit change matches, and returns its index (or -1). */
export function matchExpected(
	list: Expected[],
	change: { customerId: string; cause: string; change: number; orderId: number | null },
) {
	return list.findIndex(
		(e) =>
			(e.customerId === undefined || e.customerId === change.customerId) &&
			e.cause === change.cause &&
			(e.change === undefined || e.change === change.change) &&
			(e.orderId === undefined || e.orderId === change.orderId),
	);
}

// ---- Recording and showing ----

/** Records a customer.credits_changed event. Safe to call twice for the same event. */
export async function recordCreditChange(event: FeedEvent) {
	const d = event.data;
	if (!d.customer) return;
	const change = {
		customerId: d.customer.id,
		cause: d.cause ?? "",
		change: d.change ?? 0,
		orderId: d.orderId ?? null,
	};
	const i = matchExpected(expected, change);
	const actorId = i >= 0 ? expected.splice(i, 1)[0]!.actorId : null;
	const kind = event.test ? "test" : "live";

	await prisma.creditHistory.upsert({
		where: { kind_seq: { kind, seq: event.seq } },
		create: {
			kind,
			seq: event.seq,
			...change,
			credits: d.customer.credits,
			counterpart: d.counterpart ?? null,
			actorId,
			createdAt: new Date(event.createdAt),
		},
		update: {},
	});
}

const PAGE_SIZE = 15;

export async function historyPage(
	kind: "live" | "test",
	customerId: string,
	page: number,
): Promise<BaseMessageOptions> {
	const where = { kind, customerId };
	const total = await prisma.creditHistory.count({ where });
	const pages = Math.ceil(total / PAGE_SIZE);
	page = Math.min(Math.max(1, page || 1), Math.max(1, pages));
	const rows = await prisma.creditHistory.findMany({
		where,
		orderBy: { seq: "desc" },
		skip: (page - 1) * PAGE_SIZE,
		take: PAGE_SIZE,
	});

	const lines = rows.map((r) => {
		const parts = [
			`<t:${Math.floor(r.createdAt.getTime() / 1000)}:f>`,
			`${code(r.change > 0 ? `+${r.change}` : r.change)} → ${code(r.credits)}`,
			describe(customerCauses, r.cause),
		];
		if (r.counterpart) parts.push(`${r.change < 0 ? "to" : "from"} ${who(r.counterpart)}`);
		if (r.orderId) parts.push(`order ${orderNo(r.orderId)}`);
		if (r.actorId && r.actorId !== customerId) parts.push(`by <@${r.actorId}>`);
		return `> ${parts.join(" · ")}`;
	});

	return {
		embeds: [
			embed({
				title: "📜 Credit history",
				description: `${who(customerId)}${kind === "test" ? " (test key)" : ""}\n${lines.join("\n") || "No credit changes yet."}`,
				footer: pages > 1 ? `page ${page} of ${pages}` : undefined,
			}),
		],
		components: pageButtons(`bank.history:${customerId}`, page, pages),
	};
}
