import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError, type Order, type PaidFrom } from "../src/api.ts";
import { followUpChange, releasing, removeOrder } from "../src/refunds.ts";

test("/leave: the customer always ends up with the refund", () => {
	// Paid from their credits: the API already gave it back to them.
	assert.equal(followUpChange("leave", "customer", 3), 0);
	// Paid from the shop's balance: the bot gives them those credits.
	assert.equal(followUpChange("leave", "balance", 3), 3);
});

test("/queue remove refund:true: the same as /leave", () => {
	assert.equal(followUpChange("remove-refund", "customer", 3), 0);
	assert.equal(followUpChange("remove-refund", "balance", 3), 3);
});

test("/queue remove refund:false: the shop keeps it", () => {
	// Paid from their credits: the bot takes the refund back from them.
	assert.equal(followUpChange("remove-keep", "customer", 3), -3);
	// Paid from the shop's balance: the API already gave it back to the shop.
	assert.equal(followUpChange("remove-keep", "balance", 3), 0);
});

test("nothing refunded means nothing to settle", () => {
	assert.equal(followUpChange("leave", "balance", 0), 0);
	assert.equal(followUpChange("remove-keep", "customer", 0), 0);
});

// ---- removeOrder against a fake API ----

const original = { cancelOrder: api.cancelOrder, changeCredits: api.changeCredits, order: api.order };
afterEach(() => {
	Object.assign(api, original);
	releasing.clear();
});

const order = (paidFrom: PaidFrom): Order => ({
	id: 42,
	reference: null,
	state: "refunded",
	account: "100000000000000001",
	claims: 5,
	received: 2,
	reason: null,
	customer: "401234567890123456",
	paidFrom,
});

function fakeApi(paidFrom: PaidFrom, changeCredits?: typeof api.changeCredits) {
	const calls: { id: string; change: number; key: string }[] = [];
	api.cancelOrder = async () => ({ order: order(paidFrom), refunded: 3 });
	api.changeCredits =
		changeCredits ??
		(async (id, change, key) => {
			calls.push({ id, change, key });
			return { customer: { id, credits: 10 }, change };
		});
	return calls;
}

test("the follow-up change carries a key derived from the order, so a retry never moves it twice", async () => {
	const calls = fakeApi("balance");
	const r = await removeOrder(42, "leave", false, "999");
	assert.deepEqual(calls, [{ id: "401234567890123456", change: 3, key: "refund-42" }]);
	assert.equal(r.change, 3);
	assert.equal(r.holds, 10);
});

test("refund:false on an order the customer paid takes the refund back", async () => {
	const calls = fakeApi("customer");
	await removeOrder(42, "remove-keep", true, "999");
	assert.deepEqual(calls, [{ id: "401234567890123456", change: -3, key: "refund-42" }]);
});

test("no follow-up when the API already refunded the right party", async () => {
	const calls = fakeApi("customer");
	const r = await removeOrder(42, "leave", false, "999");
	assert.equal(calls.length, 0);
	assert.equal(r.change, 0);
});

test("a refused follow-up is reported with its numbers, not thrown", async () => {
	fakeApi("customer", async () => {
		throw new ApiError(402, "insufficient_customer_credits", "They hold 1 credit - taking 3 is not possible");
	});
	const r = await removeOrder(42, "remove-keep", true, "999");
	assert.equal(r.change, -3);
	assert.equal(r.refunded, 3);
	assert.equal(r.failure?.code, "insufficient_customer_credits");
});

test("the feed is told who keeps the refund and whether to DM, before the order is cancelled", async () => {
	let seen: unknown;
	fakeApi("balance");
	api.cancelOrder = async () => {
		seen = releasing.get(42);
		return { order: order("balance"), refunded: 3 };
	};
	await removeOrder(42, "remove-keep", false, "999");
	assert.deepEqual(seen, { dm: false, customerGets: false });
});

test("a cancel that got no answer but went through still settles the refund", async () => {
	const calls = fakeApi("balance");
	api.cancelOrder = async () => {
		throw new ApiError(0, "timeout", "took too long");
	};
	api.order = async () => ({ ...order("balance"), claimsLanded: [] });
	const r = await removeOrder(42, "leave", false, "999");
	assert.equal(r.refunded, 3, "5 claims, 2 received");
	assert.deepEqual(calls, [{ id: "401234567890123456", change: 3, key: "refund-42" }]);
	assert.ok(releasing.has(42), "the feed still knows how to word the DM");
});

test("a cancel that got no answer and did not go through is reported as failed", async () => {
	fakeApi("balance");
	api.cancelOrder = async () => {
		throw new ApiError(0, "timeout", "took too long");
	};
	api.order = async () => ({ ...order("balance"), state: "pending", claimsLanded: [] });
	await assert.rejects(removeOrder(42, "leave", false, "999"), { code: "timeout" });
	assert.ok(!releasing.has(42));
});
