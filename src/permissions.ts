// Staff levels live here and nowhere else. They have nothing to do with Discord roles.
import type { RepliableInteraction } from "discord.js";
import { prisma } from "./db.ts";
import { refused, respond } from "./discord.ts";
import { env } from "./env.ts";

export enum Level {
	Customer = 0,
	Moderator = 1,
	Administrator = 2,
	SuperAdministrator = 3,
}

export const levelNames: Record<number, string> = {
	[Level.Moderator]: "Moderator",
	[Level.Administrator]: "Administrator",
	[Level.SuperAdministrator]: "Super Administrator",
};

/** The SUPER_ADMINISTRATOR from .env is a Super Administrator without being in the database. */
export const levelFor = (userId: string, superAdministrator: string, stored?: number | null): Level =>
	superAdministrator && userId === superAdministrator ? Level.SuperAdministrator : (stored ?? Level.Customer);

/** A higher level can do everything a lower one can. */
export const atLeast = (level: Level, required: Level) => level >= required;

export async function levelOf(userId: string) {
	const staff = await prisma.staff.findUnique({ where: { userId } });
	return levelFor(userId, env.superAdministrator, staff?.level);
}

/**
 * The one gate, checked every time a command is used and again when its form is submitted.
 * Returns true when allowed; otherwise tells the user, ephemerally, and returns false.
 */
export async function allowed(inter: RepliableInteraction, required: Level, message?: string) {
	if (atLeast(await levelOf(inter.user.id), required)) return true;
	await respond(inter, {
		embeds: [refused("⛔ Staff only", message ?? `This is for staff (${levelNames[required]} or higher).`)],
	});
	return false;
}
