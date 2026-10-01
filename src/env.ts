// Imported first by index.ts, so .env is loaded before anything reads process.env.
try {
	process.loadEnvFile();
} catch {
	// No .env file: the variables come from the environment (Docker, pm2, ...).
}

export const env = {
	botToken: process.env.BOT_TOKEN ?? "",
	apiKey: process.env.API_KEY ?? "",
	apiBaseUrl: (process.env.API_BASE_URL || "https://iancu.services/api/v1/reseller").replace(/\/+$/, ""),
	superAdministrator: process.env.SUPER_ADMINISTRATOR ?? "",
	shopName: process.env.SHOP_NAME?.trim() || "Shop",
	embedColor: parseInt((process.env.EMBED_COLOR || "5865F2").replace("#", ""), 16) || 0x5865f2,
	databaseUrl: process.env.DATABASE_URL || "file:./bot.db",
};

export const missingEnv = () => ["BOT_TOKEN", "API_KEY", "SUPER_ADMINISTRATOR"].filter((name) => !process.env[name]);
