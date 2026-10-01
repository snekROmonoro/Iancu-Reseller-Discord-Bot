// The Reseller API: https://iancu.services/docs/reseller-api
// Every request carries the key, has a timeout, waits out 429s, and fails with one ApiError.
// Request bodies (which can hold a customer's token) are never put in an error or a log.
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "./env.ts";
import { log } from "./log.ts";

export type OrderState = "pending" | "completed" | "refunded" | "removed";
export type PaidFrom = "customer" | "balance";

export interface Order {
	id: number;
	reference: string | null;
	state: OrderState;
	account: string;
	claims: number;
	received: number;
	place?: number | null;
	reason: string | null;
	customer: string | null;
	paidFrom: PaidFrom;
	createdAt?: string;
	updatedAt?: string;
}

export interface Claim {
	type: string;
	delayMs: number | null;
	at: string;
}

export interface OrderDetail extends Order {
	claimsLanded: Claim[];
}

export interface Customer {
	id: string;
	credits: number;
}

export interface Balance {
	credits: number;
	customerCredits: number;
	openOrders: number;
	lastSeq: number;
}

export interface FeedEvent {
	id: string;
	seq: number;
	test: boolean;
	type: string;
	createdAt: string;
	data: {
		order?: Order;
		claim?: Claim;
		cause?: string;
		refunded?: number;
		balance?: { credits: number; change: number; cause: string; orderId: number | null };
		customer?: Customer;
		change?: number;
		orderId?: number | null;
		counterpart?: string | null;
	};
}

export type SimulateResult = "claim" | "captcha" | "token_invalid" | "token_locked";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export const keyKind = (key = env.apiKey): "test" | "live" => (key.startsWith("isk_test_") ? "test" : "live");

interface RequestOptions {
	query?: Record<string, string | number | undefined>;
	body?: unknown;
	idempotencyKey?: string;
	timeoutMs?: number;
	/** false: one attempt only, not even after a 429. */
	retry?: boolean;
	signal?: AbortSignal;
}

export type CallOptions = Pick<RequestOptions, "timeoutMs" | "retry">;

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
	const url = new URL(env.apiBaseUrl + path);
	for (const [name, value] of Object.entries(opts.query ?? {})) {
		if (value !== undefined) url.searchParams.set(name, String(value));
	}

	const headers: Record<string, string> = { Authorization: `Bearer ${env.apiKey}`, Accept: "application/json" };
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

	// Sending again is only safe when it cannot happen twice: reads, token replacement, and
	// anything with an Idempotency-Key (which the API answers with the first result).
	const canResend = opts.retry !== false && (method === "GET" || method === "PUT" || !!opts.idempotencyKey);

	for (let attempt = 1; ; attempt++) {
		const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers,
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
				signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
			});
		} catch {
			if (opts.signal?.aborted) throw new ApiError(0, "aborted", "Stopped.");
			if (canResend && attempt < 3) continue;
			throw timeout.aborted
				? new ApiError(0, "timeout", "The claim service took too long to answer. Please try again.")
				: new ApiError(0, "network_error", "Could not reach the claim service. Please try again in a moment.");
		}

		if (res.status === 429 && opts.retry !== false && attempt < 4) {
			const wait = Number(res.headers.get("retry-after")) || 5;
			log.warn(`Reseller API rate limit reached, waiting ${wait}s before trying again`);
			await res.body?.cancel();
			await sleep(wait * 1000, undefined, { signal: opts.signal });
			continue;
		}

		if (res.status >= 500 && canResend && attempt < 3) {
			await res.body?.cancel();
			await sleep(1000 * attempt, undefined, { signal: opts.signal });
			continue;
		}

		const json = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
		if (res.ok) return json as T;

		const error = json?.error;
		throw new ApiError(
			res.status,
			typeof error?.code === "string" ? error.code : "http_error",
			typeof error?.message === "string" ? error.message : `The claim service answered with HTTP ${res.status}.`,
		);
	}
}

const enc = encodeURIComponent;

type OrdersQuery = {
	state?: OrderState;
	customer?: string;
	updatedSince?: string;
	limit?: number;
	cursor?: number;
};

// An object rather than loose functions, so tests can swap single calls.
export const api = {
	balance: (opts?: CallOptions) => request<Balance>("GET", "/balance", opts),

	queue: () => request<{ length: number; places: { orderId: number; place: number }[] }>("GET", "/queue"),

	customers: (limit: number, offset: number) =>
		request<{ customers: Customer[]; total: { customers: number; credits: number } }>("GET", "/customers", {
			query: { limit, offset },
		}),

	customer: async (id: string, opts?: CallOptions) =>
		(await request<{ customer: Customer }>("GET", `/customers/${enc(id)}`, opts)).customer,

	changeCredits: (id: string, change: number, idempotencyKey: string) =>
		request<{ customer: Customer; change: number }>("POST", `/customers/${enc(id)}/credits`, {
			body: { change },
			idempotencyKey,
		}),

	transfer: (from: string, to: string, credits: number, idempotencyKey: string) =>
		request<{ from: Customer; to: Customer }>("POST", `/customers/${enc(from)}/transfer`, {
			body: { to, credits },
			idempotencyKey,
		}),

	createOrder: async (
		body: { token: string; claims: number; customer: string; paidFrom: PaidFrom },
		idempotencyKey: string,
	) => (await request<{ order: Order }>("POST", "/orders", { body, idempotencyKey })).order,

	orders: (query: OrdersQuery, opts?: CallOptions) =>
		request<{ orders: Order[]; nextCursor: number | null }>("GET", "/orders", { query, ...opts }),

	/** Every page of GET /orders, newest first. */
	allOrders: async (query: Omit<OrdersQuery, "limit" | "cursor">) => {
		const all: Order[] = [];
		let cursor: number | undefined;
		do {
			const page = await api.orders({ ...query, limit: 100, cursor });
			all.push(...page.orders);
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		return all;
	},

	order: async (id: number) => (await request<{ order: OrderDetail }>("GET", `/orders/${id}`)).order,

	updateToken: async (id: number, token: string) =>
		(await request<{ order: Order }>("PUT", `/orders/${id}/token`, { body: { token } })).order,

	cancelOrder: (id: number) => request<{ order: Order; refunded: number }>("DELETE", `/orders/${id}`),

	simulate: (id: number, result: SimulateResult) =>
		request<{ order: Order; refunded?: number }>("POST", `/orders/${id}/simulate`, { body: { result } }),

	events: (after: number, signal?: AbortSignal) =>
		request<{ events: FeedEvent[]; lastSeq: number; hasMore: boolean }>("GET", "/events", {
			query: { after, limit: 100, wait: 30 },
			timeoutMs: 45_000,
			signal,
		}),
};
