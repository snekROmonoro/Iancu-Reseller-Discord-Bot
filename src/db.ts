import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./env.ts";
import { PrismaClient, type Prisma, type Settings } from "./generated/prisma/client.ts";

// SQLite by default; a postgres:// DATABASE_URL (with provider "postgresql" in schema.prisma) uses PostgreSQL.
export const prisma = new PrismaClient({
	adapter: /^postgres(ql)?:/.test(env.databaseUrl)
		? new PrismaPg({ connectionString: env.databaseUrl })
		: new PrismaBetterSqlite3({ url: env.databaseUrl }),
});

// Only this bot writes the settings row, so it is kept in memory and read without waiting.
let cached: Settings;

export const loadSettings = async () =>
	(cached = await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }));

export const settings = () => cached;

export const updateSettings = async (data: Prisma.SettingsUpdateInput) =>
	(cached = await prisma.settings.update({ where: { id: 1 }, data }));
