import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError, keyKind, type FeedEvent } from "../src/api.ts";
import { pollOnce, shouldApply, type FeedStore } from "../src/feed.ts";

const original = { events: api.events, balance: api.balance };
afterEach(() => Object.assign(api, original));

/** An in-memory feed position store. */
function memoryStore(initial: Record<string, number> = {}) {
	const positions = new Map(Object.entries(initial).map(([k, seq]) => [k, { seq, createdAt: null as Date | null }]));
	const store: FeedStore = {
		get: async (kind) => positions.get(kind) ?? null,
		set: async (kind, seq, createdAt) => void positions.set(kind, { seq, createdAt }),
	};
	return { store, positions };
}

const event = (seq: number): FeedEvent => ({
	id: `evt_${seq}`,
	seq,
	test: false,
	type: "order.created",
	createdAt: "2026-09-28T17:03:05.000Z",
	data: {},
});

const noExpiry = async () => {};

test("an event whose seq was already applied is ignored", () => {
	assert.ok(!shouldApply(10, 9));
	assert.ok(!shouldApply(10, 10));
	assert.ok(shouldApply(10, 11));
});

test("applies new events in order, skips old ones, and saves the position after each", async () => {
	const { store, positions } = memoryStore({ live: 10 });
	const applied: number[] = [];
	api.events = async () => ({ events: [event(9), event(10), event(11), event(12)], lastSeq: 12, hasMore: false });

	await pollOnce("live", store, {
		handle: async (e) => {
			applied.push(e.seq);
			// The position is saved before the next event is handled.
			assert.equal(positions.get("live")!.seq, e.seq - 1);
		},
		expired: noExpiry,
	});

	assert.deepEqual(applied, [11, 12]);
	assert.equal(positions.get("live")!.seq, 12);
});

test("a failing handler does not stop the feed or re-apply the event", async () => {
	const { store, positions } = memoryStore({ live: 0 });
	api.events = async () => ({ events: [event(1), event(2)], lastSeq: 2, hasMore: false });
	const applied: number[] = [];
	await pollOnce("live", store, {
		handle: async (e) => {
			applied.push(e.seq);
			if (e.seq === 1) throw new Error("Discord is down");
		},
		expired: noExpiry,
	});
	assert.deepEqual(applied, [1, 2]);
	assert.equal(positions.get("live")!.seq, 2);
});

test("test and live keys keep separate positions", async () => {
	assert.equal(keyKind("isk_test_abc"), "test");
	assert.equal(keyKind("isk_live_abc"), "live");

	const { store, positions } = memoryStore({ live: 1289, test: 4 });
	const asked: number[] = [];
	api.events = async (after) => {
		asked.push(after);
		return { events: [event(after + 1)], lastSeq: after + 1, hasMore: false };
	};

	await pollOnce("test", store, { handle: async () => {}, expired: noExpiry });
	assert.deepEqual(asked, [4], "the test feed is read from the test position");
	assert.equal(positions.get("test")!.seq, 5);
	assert.equal(positions.get("live")!.seq, 1289, "the live position is untouched");
});

test("the first time a kind of key is used, it starts from the newest event", async () => {
	const { store, positions } = memoryStore({ test: 57 });
	api.balance = async () => ({ credits: 47, customerCredits: 58, openOrders: 1, lastSeq: 1289 });
	const asked: number[] = [];
	api.events = async (after) => {
		asked.push(after);
		return { events: [], lastSeq: after, hasMore: false };
	};

	await pollOnce("live", store, { handle: async () => {}, expired: noExpiry });
	assert.deepEqual(asked, [1289], "never reads the live feed from a test number");
	assert.equal(positions.get("live")!.seq, 1289);
	assert.equal(positions.get("test")!.seq, 57);
});

test("400 past the newest event (test mode started over) begins again from lastSeq", async () => {
	const { store, positions } = memoryStore({ test: 500 });
	api.balance = async () => ({ credits: 1000, customerCredits: 0, openOrders: 0, lastSeq: 0 });
	api.events = async () => {
		throw new ApiError(400, "bad_request", "after is past the newest event");
	};
	await pollOnce("test", store, { handle: async () => {}, expired: noExpiry });
	assert.equal(positions.get("test")!.seq, 0);
});

test("410 events_expired reports what changed since the saved time, then carries on from lastSeq", async () => {
	const since = new Date("2026-08-01T00:00:00.000Z");
	const { store, positions } = memoryStore();
	positions.set("live", { seq: 5, createdAt: since });
	api.balance = async () => ({ credits: 1, customerCredits: 0, openOrders: 0, lastSeq: 9000 });
	api.events = async () => {
		throw new ApiError(410, "events_expired", "too old");
	};
	let reported: Date | null = null;
	await pollOnce("live", store, {
		handle: async () => assert.fail("no old events are sent to anyone"),
		expired: async (d) => void (reported = d),
	});
	assert.equal(reported, since);
	assert.equal(positions.get("live")!.seq, 9000);
});
