import assert from "node:assert/strict";
import { test } from "node:test";
import { matchExpected, type Expected } from "../src/history.ts";

const CUSTOMER = "401234567890123456";
const at = 0;

test("a credit change takes the person who made it through the bot", () => {
	const list: Expected[] = [
		{ actorId: "staff-a", customerId: CUSTOMER, cause: "given", change: 5, at },
		{ actorId: "staff-b", customerId: CUSTOMER, cause: "taken_back", change: -2, at },
	];
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "taken_back", change: -2, orderId: null }), 1);
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "given", change: 5, orderId: null }), 0);
});

test("a change that does not match (other amount, customer or cause) gets nobody", () => {
	const list: Expected[] = [{ actorId: "staff-a", customerId: CUSTOMER, cause: "given", change: 5, at }];
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "given", change: 6, orderId: null }), -1);
	assert.equal(matchExpected(list, { customerId: "999", cause: "given", change: 5, orderId: null }), -1);
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "spent", change: 5, orderId: null }), -1);
	assert.equal(matchExpected([], { customerId: CUSTOMER, cause: "given", change: 5, orderId: null }), -1);
});

test("an API refund matches by order, since its amount and customer are not known beforehand", () => {
	const list: Expected[] = [{ actorId: "staff-a", cause: "refunded", orderId: 42, at }];
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "refunded", change: 3, orderId: 42 }), 0);
	assert.equal(matchExpected(list, { customerId: CUSTOMER, cause: "refunded", change: 3, orderId: 43 }), -1);
});
