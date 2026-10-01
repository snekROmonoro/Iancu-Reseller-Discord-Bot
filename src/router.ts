import {
	ApplicationIntegrationType,
	InteractionContextType,
	type APIEmbed,
	type Interaction,
	type RepliableInteraction,
} from "discord.js";
import { ApiError } from "./api.ts";
import { bank, bankView, balance } from "./commands/bank.ts";
import { faq } from "./commands/faq.ts";
import { order } from "./commands/order.ts";
import { queue, queuePosition } from "./commands/queue.ts";
import { leave, redeem, updateToken } from "./commands/redeem.ts";
import { settingsCommand } from "./commands/settings.ts";
import type { Command } from "./commands/shared.ts";
import { staff } from "./commands/staff.ts";
import { status } from "./commands/status.ts";
import { sync } from "./commands/sync.ts";
import { test } from "./commands/test.ts";
import { settings } from "./db.ts";
import { refused, respond, warning } from "./discord.ts";
import { log } from "./log.ts";

const all: Command[] = [
	bank,
	bankView,
	balance,
	redeem,
	updateToken,
	leave,
	queue,
	queuePosition,
	order,
	faq,
	staff,
	settingsCommand,
	status,
	sync,
	test,
];
const commands = new Map(all.map((c) => [c.data.name, c]));

/** Registered globally, for the server and for DMs with the bot. Visible to everybody: levels are the only gate. */
export const commandData = all.map((c) => ({
	...c.data.toJSON(),
	contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
	integration_types: [ApplicationIntegrationType.GuildInstall],
}));

const errorTitles: Record<string, string> = {
	insufficient_credits: "⛔ Not enough credits",
	insufficient_customer_credits: "⛔ Not enough credits",
	account_already_queued: "⛔ Already in the queue",
	token_invalid: "⛔ Token refused",
	token_locked: "🔒 Account locked",
	different_account: "⛔ Different account",
	not_in_queue: "⛔ Not in the queue",
	order_not_found: "⛔ Order not found",
	claims_disabled: "⏸️ Claims paused",
	rate_limited: "⏳ Too many requests",
	timeout: "📡 Service not answering",
	network_error: "📡 Service not answering",
	reseller_suspended: "⛔ Shop suspended",
	unauthorized: "⛔ Shop setup problem",
	missing_scope: "⛔ Shop setup problem",
};

/** People see the API's message, which is written for them; the bot only branches on the code. */
function errorEmbed(e: unknown): APIEmbed {
	if (e instanceof ApiError) {
		if (e.status === 401 || e.status === 403 || e.status >= 500)
			log.warn(`Reseller API ${e.status} ${e.code}: ${e.message}`);
		// A key problem is the shop's to fix: the details go to the console, not to customers.
		if (e.code === "unauthorized" || e.code === "missing_scope")
			return refused(errorTitles[e.code]!, "Something is wrong with the shop's setup. Please tell staff.");
		const message =
			e.code === "account_already_queued"
				? `${e.message}\nIf its token stopped working, use \`/update-token\` to give a new one.`
				: e.message;
		return refused(errorTitles[e.code] ?? "⛔ Refused", message);
	}
	log.error("Interaction failed:", e);
	return refused("⛔ Something went wrong", "That did not work. Please try again in a moment.");
}

const isGuildSetup = (inter: Interaction) =>
	inter.isChatInputCommand() &&
	inter.commandName === "settings" &&
	inter.options.getSubcommandGroup(false) === "bot" &&
	inter.options.getSubcommand(false) === "guild";

export async function route(inter: Interaction) {
	const name =
		inter.isCommand() || inter.isAutocomplete()
			? inter.commandName
			: "customId" in inter
				? inter.customId.split(".")[0]!
				: "";
	const command = commands.get(name);
	if (!command) return;

	// Until a server is set, only /settings bot guild works; after, only that server and DMs.
	const s = settings();
	let gate: APIEmbed | undefined;
	if (!s.guildId && !isGuildSetup(inter)) {
		gate = warning(
			"⚙️ Setup needed",
			"An administrator needs to run `/settings bot guild` in the shop's server first.",
		);
	} else if (s.guildId && inter.guildId && inter.guildId !== s.guildId && !isGuildSetup(inter)) {
		gate = refused("⛔ Wrong server", "This bot serves another server.");
	}

	try {
		if (inter.isAutocomplete()) return gate ? inter.respond([]) : await command.autocomplete?.(inter);
		if (gate) return await respond(inter as RepliableInteraction, { embeds: [gate] });

		if (inter.isChatInputCommand()) await command.run?.(inter);
		else if (inter.isUserContextMenuCommand()) await command.menu?.(inter);
		else if (inter.isModalSubmit()) await command.modal?.(inter);
		else if (inter.isButton()) await command.button?.(inter);
		else if (inter.isStringSelectMenu()) await command.select?.(inter);
	} catch (e) {
		if (inter.isAutocomplete()) return void inter.respond([]).catch(() => {});
		await respond(inter as RepliableInteraction, { embeds: [errorEmbed(e)] }).catch((err) =>
			log.warn("Could not send an error reply:", err),
		);
	}
}
