import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError } from "../src/api.ts";
import { log, redact } from "../src/log.ts";

const TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.TESTOK.reseller-api-test-token-not-a-real-one";
const ORDER = { token: TOKEN, claims: 5, customer: "401234567890123456", paidFrom: "customer" } as const;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Runs `fn`, returning everything it printed to the console. */
async function captureConsole(fn: () => Promise<void>) {
	const lines: string[] = [];
	const { log: out, error: err } = console;
	console.log = console.error = (...args: unknown[]) => void lines.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = out;
		console.error = err;
	}
	return lines.join("\n");
}

test("redact hides Discord tokens and API keys wherever they appear", () => {
	assert.equal(redact(`token: ${TOKEN}!`), "token: [token]!");
	assert.equal(redact("Bearer isk_live_abcDEF123_-x"), "Bearer [api key]");
	assert.equal(redact("order #1234 for 401234567890123456"), "order #1234 for 401234567890123456");
});

test("the logger never prints a token, whatever it is given", async () => {
	const printed = await captureConsole(async () => {
		log.error("failed:", new Error(`request ${JSON.stringify(ORDER)} broke`));
		log.warn({ body: ORDER });
		log.info(TOKEN);
	});
	assert.ok(printed.length > 0);
	assert.ok(!printed.includes(TOKEN), printed);
});

test("an API error never carries the request body, even when the server echoes it", async () => {
	globalThis.fetch = async (_url, init) =>
		new Response(
			JSON.stringify({ error: { code: "token_invalid", message: "Discord refused it" }, echo: init?.body }),
			{
				status: 422,
			},
		);

	const error = await api.createOrder(ORDER, "discord-123456789").catch((e) => e);
	assert.ok(error instanceof ApiError);
	assert.equal(error.code, "token_invalid");
	assert.equal(error.message, "Discord refused it");
	assert.ok(!JSON.stringify({ ...error, stack: error.stack, message: error.message }).includes(TOKEN));
});

test("a failing request (network error with the body in it) cannot dump the body", async () => {
	globalThis.fetch = async (_url, init) => {
		throw new TypeError(`fetch failed while sending ${init?.body}`);
	};

	const printed = await captureConsole(async () => {
		const error = await api.createOrder(ORDER, "discord-123456789").catch((e) => e);
		assert.ok(error instanceof ApiError);
		assert.equal(error.code, "network_error");
		assert.ok(!`${error.message}\n${error.stack}`.includes(TOKEN));
		log.error("Interaction failed:", error);
	});
	assert.ok(!printed.includes(TOKEN), printed);
});

test("a server error answer without JSON does not leak anything either", async () => {
	globalThis.fetch = async (_url, init) => new Response(`<html>${init?.body}</html>`, { status: 418 });
	const error = await api.createOrder(ORDER, "discord-123456789").catch((e) => e);
	assert.ok(error instanceof ApiError);
	assert.equal(error.code, "http_error");
	assert.ok(!`${error.message}\n${error.stack}`.includes(TOKEN));
});
