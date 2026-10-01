import { inspect } from "node:util";

// Anything shaped like a Discord token (user or bot) or a Reseller API key.
const DISCORD_TOKEN = /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g;
const API_KEY = /isk_(?:test|live)_[\w-]+/g;

/** Every console line goes through this, so a token can never reach the logs, whatever printed it. */
export const redact = (text: string) => text.replace(DISCORD_TOKEN, "[token]").replace(API_KEY, "[api key]");

const format = (arg: unknown) =>
	arg instanceof Error ? (arg.stack ?? `${arg.name}: ${arg.message}`) : typeof arg === "string" ? arg : inspect(arg);

const write = (level: "info" | "warn" | "error", args: unknown[]) => {
	const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(args.map(format).join(" "))}`;
	if (level === "info") console.log(line);
	else console.error(line);
};

export const log = {
	info: (...args: unknown[]) => write("info", args),
	warn: (...args: unknown[]) => write("warn", args),
	error: (...args: unknown[]) => write("error", args),
};
