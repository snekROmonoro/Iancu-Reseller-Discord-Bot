# CLAUDE.md

Self-hosted Discord bot for resellers of Iancu Services Nitro claims. Credits, orders, customers
and the queue live in the **Reseller API**; this bot keeps only its own settings, staff, FAQ,
status texts, events-feed positions and customers' credit history (`CreditHistory`). The API reference is the source of truth:
https://iancu.services/docs/reseller-api — read it before changing anything that calls the API.
`README.md` is written for non-developers; keep it accurate when behaviour changes.

## Commands

- `npm start`: `prisma db push`, then runs `src/index.ts` with tsx (no build step)
- `npm test`: node:test via tsx (`test/*.test.ts`)
- `npm run typecheck`: `tsc` (noEmit)
- `npm run format`: Prettier (tabs, width 4, print width 120)
- After editing `prisma/schema.prisma`: `npx prisma generate` (also runs on `npm install`)

Run typecheck and tests before calling a change done.

## Stack quirks

- Node 22+, ESM, TypeScript run by **tsx**. Relative imports end in **`.ts`**
  (`allowImportingTsExtensions`, `verbatimModuleSyntax`: use `import type` for types).
- **Prisma 7**: generator `prisma-client`, output `src/generated/prisma` (git-ignored, import from
  `./generated/prisma/client.ts`). The datasource URL is in `prisma.config.ts`, not the schema.
  The driver adapter is picked in `src/db.ts` from `DATABASE_URL` (better-sqlite3, or pg for
  `postgres://`). There are **no migrations**: `db push` on start keeps it provider-agnostic, so
  schema changes must be additive or have defaults.
- npm 12+ blocks dependency install scripts unless listed in `package.json` `allowScripts`. A new
  dependency with an install script (native addon, binary download) must be added there, or a
  fresh install breaks at runtime (e.g. better-sqlite3 "Could not locate the bindings file").
- `package.json` `overrides` pin patched `deepmerge-ts`/`mysql2` (pulled in by the Prisma CLI).
  Keep `npm audit` at 0.
- discord.js v14 with the **`Guilds` intent only**. Don't add privileged intents. Members are
  fetched one by one (`guild.members.fetch(id)`), never listed.
- `src/env.ts` must stay the **first import** in `src/index.ts` (it loads `.env`).

## Rules that must not break

- **Tokens.** A customer's Discord token is only ever typed into a modal (`tokenModal` in
  `src/commands/shared.ts`) and passed straight to the API. Never log, store, cache, echo it, or
  put it in an error. `ApiError` never carries a request body. Every console line goes through
  `log` in `src/log.ts`, which redacts tokens and API keys: use `log`, never bare `console`.
  `test/tokens.test.ts` guards this.
- **Permissions.** Levels live only in `src/permissions.ts` (Moderator < Administrator < Super
  Administrator; `SUPER_ADMINISTRATOR` from `.env` is always Super). Every staff command calls
  `allowed()` when used **and again in its modal/button handler**. Commands stay visible to
  everybody: don't use Discord's default member permissions.
- **Idempotency.** Every order, credit change and transfer sends an `Idempotency-Key`:
  `idempotencyKey(inter)` = `discord-<interaction id>`, or `refund-<order id>` for refund
  follow-ups. Keys are 8–100 chars of letters, digits and `. _ : -`.
- **Discord's 3 seconds.** Anything that calls the API defers first. A modal can't be deferred,
  so before `showModal` only quick checks run (`/redeem` and `/update-token` get a 1.5s API
  budget with `{ timeoutMs: 1500, retry: false }`, and open the form anyway if it's slow).
- **Errors shown to people** use the API's `message`. Code branches on `code`. Unhandled throws
  in handlers are caught by `src/router.ts`, which turns `ApiError` into a red embed.
- **Mentions never ping** (client default `allowedMentions: { parse: [] }`), except the
  claim-ping role in the claims channel. Never put a mention inside backticks. Customer ids that
  aren't all digits are website customers: show them as text, never mention, DM or give a role
  (`who()` / `isDiscordId()` in `src/discord.ts`).

## How things fit

- `src/api.ts`: the only API client. Methods live on the `api` object so tests can swap them.
  `allOrders()` follows cursors. Resending only happens when safe (GET, PUT, or with an
  idempotency key). 429 waits `Retry-After`.
- `src/feed.ts`: long-polls `GET /events?wait=30`. The position is saved after **every** event,
  separately for `live` and `test` keys (`keyKind()`). The first run starts from
  `GET /balance`'s `lastSeq`. 400 means start over from `lastSeq`; 410 calls `reportMissed`,
  then starts from `lastSeq`.
- `src/notify.ts`: one handler per event type (DMs, claims channel, event logs, customer role,
  `soon()` refreshes).
- `src/history.ts`: credit history, recorded from `customer.credits_changed` events (one row per
  `kind` + `seq`, so recording twice is harmless; live and test kept apart). The feed doesn't say
  who made a change, so **every bot call that moves customer credits is wrapped in `expecting()`**
  with the acting user, and the matching event takes that person. New credit-moving code must do the
  same, or its history rows show nobody. Shown by `/bank history`.
- `src/refunds.ts`: who keeps an order's refund after `/leave` and `/queue remove`
  (`followUpChange`). `releasing` tells the feed, **before** the DELETE, whether to DM and who
  got the refund. `test/refunds.test.ts` pins the rules.
- `src/views.ts`: queue, leaderboard and FAQ pages (used by commands and by the messages kept up
  to date), `pageButton`, `refresh`/`soon` (≤ once per 30s)/`post`, plus the interval timers.
- `src/router.ts`: registers commands (contexts Guild + BotDM, guild install) and routes
  interactions. Components and modals route by custom id `"<command>.<what>:<data>"`, and ids
  carry their data so they work after a restart. The guild gate lives here: until
  `/settings bot guild` runs, everything else says to run it; after, only that server and DMs.
- `src/db.ts`: the settings row (id 1) is cached in memory (`settings()`), so always write it
  through `updateSettings()`. Empty string means "not set".
- To add a command, export a `Command` from `src/commands/*.ts` and add it to `all` in
  `src/router.ts`. Channel and role options only work inside the server (`inServer()`), and
  channels are checked with `checkChannel()`.

## Style

- Everything the bot says is an embed (`embed`/`done`/`refused`/`warning` in `src/discord.ts`),
  except the claims channel in Text style. Colours by meaning: green done, red refused, amber
  warning, pink `#F47FFF` claim, `EMBED_COLOR` for info, blurple staff logs, grey event logs.
  Emoji titles, facts as inline fields, numbers and ids in backticks, and the shop's name plus
  the time in the footer (added by `embed()`).
- **Don't call `embed()` at module load.** It reads settings, which only load at startup. Use a
  function instead.
- **Never name the supplier** (Iancu Services) or "the Reseller API" in anything the bot says: customers
  see the shop, not who it buys from. Say "the claim service" or "the supplier" (staff logs). Only
  console logs, the README and code comments may name it.
- Staff actions go to `staffLog(actorId, …)`, feed events to `eventLog(…)`.
- Wording follows the old bot. The Text claim line keeps the progress on purpose:
  `💎 Successfully claimed `Nitro Monthly`in`2.1s` for @customer (`3/5`) @claim-ping`.
- Replies are ephemeral except `/bank view`, `/queue position` (unless `order:true`) and
  `/faq show`/`search`.
