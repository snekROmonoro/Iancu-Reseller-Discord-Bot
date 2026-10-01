import { defineConfig } from "prisma/config";

try {
	process.loadEnvFile();
} catch {
	// No .env file: the variables come from the environment (Docker, pm2, ...).
}

export default defineConfig({
	schema: "prisma/schema.prisma",
	datasource: { url: process.env.DATABASE_URL || "file:./bot.db" },
});
