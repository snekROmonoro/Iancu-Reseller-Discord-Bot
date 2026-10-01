// Reads the reseller's events feed all the time: one request held open with wait=30, asked again as
// soon as it answers. The position is saved after every event, one for live keys and one for test keys.
import { setTimeout as sleep } from "node:timers/promises";
import { api, ApiError, keyKind, type FeedEvent } from "./api.ts";
import { prisma } from "./db.ts";
import { log } from "./log.ts";

type Kind = "live" | "test";
type Position = { seq: number; createdAt: Date | null };

export interface FeedStore {
	get(kind: Kind): Promise<Position | null>;
	set(kind: Kind, seq: number, createdAt: Date | null): Promise<void>;
}

export const dbStore: FeedStore = {
	get: (kind) => prisma.feedPosition.findUnique({ where: { kind } }),
	set: async (kind, seq, createdAt) => {
		await prisma.feedPosition.upsert({
			where: { kind },
			create: { kind, seq, createdAt },
			update: { seq, createdAt },
		});
	},
};

export const shouldApply = (lastSeq: number, seq: number) => seq > lastSeq;

/** Begin at the newest event, so old history is not sent to anyone. */
async function startFresh(kind: Kind, store: FeedStore): Promise<Position> {
	const { lastSeq } = await api.balance();
	const position = { seq: lastSeq, createdAt: new Date() };
	await store.set(kind, position.seq, position.createdAt);
	log.info(`Events feed (${kind}): starting from event ${lastSeq}`);
	return position;
}

export interface FeedHandlers {
	handle(event: FeedEvent): Promise<void>;
	/** The saved position is older than the feed keeps: report what changed since `since`. */
	expired(since: Date | null): Promise<void>;
}

/** One request to the feed, applying what it returns. Returns whether more events are waiting. */
export async function pollOnce(kind: Kind, store: FeedStore, handlers: FeedHandlers, signal?: AbortSignal) {
	let position = (await store.get(kind)) ?? (await startFresh(kind, store));

	let page;
	try {
		page = await api.events(position.seq, signal);
	} catch (e) {
		if (e instanceof ApiError && e.code === "bad_request") {
			// Past the newest event: the test feed was started over.
			log.warn(`Events feed (${kind}): event ${position.seq} is past the newest one, starting again`);
			await startFresh(kind, store);
			return true;
		}
		if (e instanceof ApiError && e.code === "events_expired") {
			await handlers.expired(position.createdAt);
			await startFresh(kind, store);
			return true;
		}
		throw e;
	}

	for (const event of page.events) {
		if (!shouldApply(position.seq, event.seq)) continue;
		try {
			await handlers.handle(event);
		} catch (e) {
			log.error(`Event ${event.seq} (${event.type}) could not be fully handled:`, e);
		}
		position = { seq: event.seq, createdAt: new Date(event.createdAt) };
		await store.set(kind, position.seq, position.createdAt);
	}
	return page.hasMore;
}

let controller: AbortController | undefined;
let running: Promise<void> | undefined;

export function startFeed(handlers: FeedHandlers) {
	if (running) return; // never twice at once
	controller = new AbortController();
	const { signal } = controller;
	const kind = keyKind();

	running = (async () => {
		let backoff = 1000;
		while (!signal.aborted) {
			try {
				await pollOnce(kind, dbStore, handlers, signal);
				backoff = 1000;
			} catch (e) {
				if (signal.aborted) break;
				log.warn(`Events feed: ${e instanceof Error ? e.message : e} Trying again in ${backoff / 1000}s.`);
				await sleep(backoff, undefined, { signal }).catch(() => {});
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	})();
}

export async function stopFeed() {
	controller?.abort();
	await running;
	running = undefined;
}
