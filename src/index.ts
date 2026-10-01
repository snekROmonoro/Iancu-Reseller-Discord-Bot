import { env, missingEnv } from "./env.ts"; // first: loads .env
import { setTimeout as sleep } from "node:timers/promises";
import { Events } from "discord.js";
import { api, ApiError, keyKind } from "./api.ts";
import { rotateStatus } from "./commands/status.ts";
import { loadSettings, prisma } from "./db.ts";
import { client } from "./discord.ts";
import { startFeed, stopFeed } from "./feed.ts";
import { log } from "./log.ts";
import { handleEvent, reportMissed } from "./notify.ts";
import { commandData, route } from "./router.ts";
import { startRefreshing, stopRefreshing } from "./views.ts";

let statusTimer: NodeJS.Timeout | undefined;

/** Stops for good, but not straight away: a process manager restarting at once would hit the API's limit on wrong keys. */
async function fatal(message: string): Promise<never> {
	log.error(message);
	log.error("Fix .env and start the bot again. Stopping in 60 seconds.");
	await sleep(60_000);
	return exit(1);
}

async function exit(code: number): Promise<never> {
	await client.destroy().catch(() => {});
	await prisma.$disconnect().catch(() => {});
	process.exit(code);
}

async function checkApiKey() {
	try {
		const balance = await api.balance({ retry: false });
		log.info(`Reseller API: ${balance.credits} credits on the shop's balance (${keyKind()} key)`);
	} catch (e) {
		if (!(e instanceof ApiError)) throw e;
		if (e.status === 401) return fatal("API_KEY is not a valid Reseller API key.");
		if (e.status === 429) {
			return fatal(
				"The Reseller API is refusing this address for a minute. That happens after many wrong API keys: check API_KEY.",
			);
		}
		if (e.code === "not_found") return fatal(`API_BASE_URL looks wrong: ${env.apiBaseUrl} has no Reseller API.`);
		if (e.code === "reseller_suspended") return fatal("The reseller account is suspended.");
		// Unreachable for now: carry on, the feed keeps trying and commands say what is wrong.
		log.warn(`Reseller API check failed: ${e.message}`);
	}
}

async function main() {
	const missing = missingEnv();
	if (missing.length) {
		log.error(`Missing in .env: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
		process.exit(1);
	}

	await loadSettings();
	await checkApiKey();

	client.on(Events.InteractionCreate, (inter) => void route(inter));
	client.once(Events.ClientReady, async (ready) => {
		log.info(`Logged in as ${ready.user.tag}`);
		startFeed({ handle: handleEvent, expired: reportMissed });
		startRefreshing();
		void rotateStatus();
		statusTimer = setInterval(() => void rotateStatus(), 60_000);

		// Last, so a hiccup here never stops the feed. Commands registered before stay registered.
		await ready.application.commands
			.set(commandData)
			.then(() => log.info(`Registered ${commandData.length} commands`))
			.catch((e) => log.error("Could not register the commands (restart the bot to try again):", e));
	});

	await client.login(env.botToken).catch((e) => {
		if (e?.code === "TokenInvalid") return fatal("BOT_TOKEN is not a valid Discord bot token.");
		throw e;
	});
}

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	log.info(`${signal}: stopping…`);
	clearInterval(statusTimer);
	stopRefreshing();
	await stopFeed();
	await exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => log.error("Unhandled error:", e));

main().catch((e) => {
	log.error("The bot could not start:", e);
	void exit(1);
});
