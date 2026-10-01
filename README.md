# Iancu Reseller Discord Bot

A Discord bot for shops that resell Nitro claims from **[Iancu Services](https://iancu.services/)**. You run it yourself,
in your own server, under your own bot's name and picture.

Your customers hold **credits** (1 credit = 1 claim). Your staff give them credits after they
pay you, however your shop takes payment. Customers spend them with `/redeem`, typing their
Discord token into a private form. The bot puts the account in the claim queue and messages
them as claims land and when the order ends. Whatever an order does not receive goes back to
the customer.

Credits, orders and customers are all kept by the Iancu Services **Reseller API**. The bot keeps
its own settings, staff, FAQ and status texts, plus a history of every change to customers' credits.

> **Hosted or self-hosted?** This bot is similar to the one we, [Iancu Services](https://iancu.services/), can host for your
> shop (see "Discord bot" on the Reseller page). The difference is that here you get the full
> source code: run it wherever you like, and edit or extend it however you want, from wording and
> commands to new features of your own.

---

## What you need

- A computer or server that stays on: Windows, Linux or macOS.
- **Node.js 22 or newer**. Download the "LTS" version from [nodejs.org](https://nodejs.org).
  To check, open a terminal and run `node -v`.
- A reseller account at Iancu Services.

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click
   **New Application**. Give it your shop's name.
2. On **General Information**, copy the **Application ID**. You need it for the invite link below.
3. Open **Bot**:
    - Click **Reset Token** and copy the token. This is your `BOT_TOKEN`. Keep it secret.
    - Under **Privileged Gateway Intents**, leave **Presence**, **Server Members** and
      **Message Content** **off**. The bot doesn't need them.
    - Set the bot's name and picture here if you like.
4. Invite the bot to your server. Paste your Application ID into this link and open it:

    ```
    https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=268782656&integration_type=0
    ```

    It uses the `bot` and `applications.commands` scopes and asks for these permissions:
    View Channels, Send Messages, Embed Links, Read Message History, Add Reactions,
    Use External Emojis and Manage Roles.

5. In your server, open **Server Settings → Roles** and drag the bot's role **above** the
   customer role it will give out.

## 2. Get a Reseller API key

On the **Reseller page** of your Iancu Services dashboard, make an API key with both scopes,
`orders:read` and `orders:write`.

**Start with a test key** (`isk_test_…`). It works exactly like a live key but against a test
world: a test balance of 1000 credits, and test orders that never enter the real queue. You
switch to a live key at the end (step 6).

A key is shown only once, so copy it somewhere safe.

## 3. Install and start the bot

1. Download this project: click **Code → Download ZIP** on GitHub and unzip it, or use
   `git clone`.
2. Open a terminal in the project folder (the one with `package.json`) and run:

    ```bash
    npm install
    ```

3. Copy `.env.example` to a new file named `.env` and fill it in. Every line is explained in
   the file:

    | Variable              | What to put                                                                                               |
    | --------------------- | --------------------------------------------------------------------------------------------------------- |
    | `BOT_TOKEN`           | The bot token from step 1                                                                                 |
    | `API_KEY`             | Your Reseller API key from step 2                                                                         |
    | `API_BASE_URL`        | Leave it as it is                                                                                         |
    | `SUPER_ADMINISTRATOR` | Your own Discord user id: Developer Mode on (Settings → Advanced), right-click yourself, **Copy User ID** |
    | `SHOP_NAME`           | Your shop's name, shown on every message and in DMs ("Shop" if empty)                                     |
    | `EMBED_COLOR`         | Your shop's colour, as hex without `#` (for example `F47FFF`)                                             |
    | `DATABASE_URL`        | Leave it as it is                                                                                         |

4. Start the bot:

    ```bash
    npm start
    ```

    You should see `Reseller API: 1000 credits on the shop's balance (test key)` and then
    `Logged in as YourBot#1234`. The first start can take a minute while Discord shows the
    commands. To stop the bot, press `Ctrl + C`.

If something in `.env` is missing or wrong, the bot says what, and stops.

## 4. Set it up in Discord

Everything else is set from Discord. Only you (the `SUPER_ADMINISTRATOR`) and the staff you add
can change anything.

1. In your server, run **`/settings bot guild`**. This tells the bot which server it serves.
   Until then, every other command asks you to do this first.
2. Set the rest. Pick only what you want:

    | Command                              | What it sets                                                                             |
    | ------------------------------------ | ---------------------------------------------------------------------------------------- |
    | `/settings bot logs channel`         | A private channel where every staff action and everything that happens is logged         |
    | `/settings claims channel channel`   | The public channel where claims are announced                                            |
    | `/settings claims style style`       | Claims as an **Embed** (default) or one line of **Text**                                 |
    | `/settings bot role which role`      | **Customer**: given to customers. **Claim Ping**: pinged on every claim                  |
    | `/settings bot emoji which emoji`    | Queue Active, Queue Waiting, Nitro, Nitro Classic, Nitro Basic, and the Claims Reaction  |
    | `/settings queue channel channel`    | Posts the queue message there. It is kept up to date on its own                          |
    | `/settings queue show-names show`    | Display names in the queue, or mentions                                                  |
    | `/settings queue count mode`         | Places out of the **whole** queue (Global, default) or out of your shop's orders (Local) |
    | `/settings bank leaderboard channel` | Posts the credits leaderboard there. It is kept up to date on its own                    |
    | `/faq channel channel`               | Posts the FAQ there (add questions with `/faq add`)                                      |
    | `/status add name type`              | Status texts the bot rotates every minute                                                |

    The bot checks that it can post in a channel before saving it.

3. Add your staff with **`/staff add user level`**:
    - **Moderator**: the bank, queueing and removing orders, the FAQ, `/balance`, `/sync roles`
    - **Administrator**: everything a Moderator can, plus `/settings`, `/status` and `/test`
    - **Super Administrator**: everything, including `/staff add` and `/staff remove`

    Staff levels belong to the bot. They have nothing to do with Discord roles. Every command
    is visible to everybody; someone without the level is told it is for staff.

**Every command also works in a DM with the bot**, acting for your server. The exceptions are
the few that pick a channel or a role, which only work inside the server.

## 5. Try everything in test mode

With the test key still in `.env`:

1. **Give yourself credits:** `/bank add user:@you credits:10`. You get a DM saying you received
   them. `/balance` shows the shop's test balance went down by 10.
2. **Redeem:** `/redeem claims:2`. A form opens. Paste this test token:

    ```
    MTAwMDAwMDAwMDAwMDAwMDAx.TESTOK.reseller-api-test-token-not-a-real-one
    ```

    You get a receipt by DM, and the order shows in `/queue view` and `/queue position`.
    Because the token belongs to a different account than yours, the receipt and `/order info`
    say "for account …": you bought for somebody else.

3. **Land claims:** `/test claim`. The claims channel announces it, and you get a "🎉 New claim!"
   DM. Run `/test claim` again: the order completes and you get "🤝 Order completed".
4. **Leave the queue:** `/redeem claims:3` with the token above, then `/leave`. The 3 credits
   come back to you.
5. **Other endings:** redeem again, then try `/test token_invalid`, `/test token_locked` or
   `/test captcha`. Each one releases the order and gives the credits back.
6. **Refused tokens:** these test tokens are refused, so you can see the error messages:

    ```
    MTAwMDAwMDAwMDAwMDAwMDA5.TESTIV.reseller-api-test-token-not-a-real-one
    MTAwMDAwMDAwMDAwMDAwMDA5.TESTLK.reseller-api-test-token-not-a-real-one
    ```

Your logs channel shows every step. To start the test world over, use **Start over** on the
Reseller page.

## 6. Go live

1. On the Reseller page, make a **live** key (`isk_live_…`).
2. Replace `API_KEY` in `.env` with it.
3. Restart the bot.

Test and live events are counted separately, and the bot remembers its place in each, so
switching never mixes them up. `/test` does nothing with a live key. With a live key,
customers use their **real** Discord tokens.

## 7. Keep it running

`npm start` runs the bot for as long as the terminal stays open. To keep it running after you
close the terminal, and after the computer restarts, use whatever you prefer: `pm2`, Docker,
`screen`, a systemd service, a Windows task, your host's panel… Two common choices:

### pm2

```bash
npm install -g pm2
pm2 start npm --name reseller-bot -- start
pm2 save
pm2 startup
```

`pm2 startup` prints one more command that makes the bot start with the computer (on Windows,
use [pm2-installer](https://github.com/jessety/pm2-installer) instead). Then use
`pm2 logs reseller-bot` to see what it says, and `pm2 restart reseller-bot` after changing
`.env`.

### Docker

With [Docker](https://docs.docker.com/get-docker/) installed, and `.env` filled in:

```bash
docker compose up -d --build
```

The database is kept in the `data` folder next to `docker-compose.yml`. Use
`docker compose logs -f` to see what it says, and `docker compose up -d --build` again after
changing `.env` or updating.

### Updating

Download the new version (or `git pull`), run `npm install`, and restart the bot. Your settings,
staff, FAQ and credit history are kept in `bot.db` (in `data` with Docker). Don't delete it.

---

## Commands

Replies are private (only you see them), except `/bank view`, `/queue position` and the FAQ.

| Command                                                        | Who                  | What it does                                                                                           |
| -------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `/bank view [user]`, **Bank View** (menu)                      | anyone               | Credits someone holds                                                                                  |
| `/bank leaderboard [page]`                                     | anyone               | Customers by credits                                                                                   |
| `/bank transfer user credits [from]`                           | anyone               | Send your credits to someone (`from` someone else: Moderator)                                          |
| `/bank history [user]`                                         | anyone (own history) | Every change to your credits: given, spent, refunded, transferred, and by whom. Staff can see anyone's |
| `/redeem claims`                                               | anyone               | Opens a private form for a token, then queues it, paid from your credits                               |
| `/update-token [order]`                                        | anyone               | A new token for your waiting order (same account; it keeps its place)                                  |
| `/leave [order]`                                               | anyone               | Takes your order out; what it didn't receive comes back as credits                                     |
| `/queue view [page]`                                           | anyone               | The shop's waiting orders, in queue order                                                              |
| `/queue position [user] [order]`, **Queue Position** (menu)    | anyone               | Where someone's orders stand                                                                           |
| `/order list [user]` · `/order info id`                        | anyone (own orders)  | Your orders, or one order with its claims by type. Staff can see anyone's                              |
| `/faq show` · `/faq search`                                    | anyone               | The FAQ                                                                                                |
| `/bank add` · `/bank remove`                                   | Moderator            | Give credits from the shop's balance, or take them back                                                |
| `/balance`                                                     | Moderator            | The shop's credits, what customers hold, orders in the queue                                           |
| `/queue add user claims`                                       | Moderator            | Queue someone, paid from the shop's balance (opens a token form)                                       |
| `/queue remove order refund message`                           | Moderator            | Take an order out. `refund`: the customer gets what it didn't receive. `message`: DM them              |
| `/faq add · edit · remove · move · channel · update`           | Moderator            | Manage the FAQ and its message                                                                         |
| `/sync roles`                                                  | Moderator            | Give the customer role to every customer who lacks it                                                  |
| `/staff list`                                                  | Moderator            | Staff and their levels                                                                                 |
| `/settings …` · `/status …`                                    | Administrator        | Settings (see step 4) and the bot's status texts                                                       |
| `/test claim · captcha · token_invalid · token_locked [order]` | Administrator        | Move a test order on (test key only)                                                                   |
| `/staff add` · `/staff remove`                                 | Super Administrator  | Manage staff                                                                                           |

### What the bot does on its own

- **DMs customers** when they get credits, when their order is placed, as each claim lands, and
  when the order completes or ends early. Somebody who doesn't accept DMs is skipped.
- **Announces every claim** in the claims channel, with the claim-ping role and the reaction
  emoji if you set them.
- **Logs** every staff action and everything that happens in the logs channel. A token never
  appears anywhere.
- **Keeps the queue, leaderboard and FAQ messages up to date.** If one is deleted, the bot
  notes it in the logs and stops updating it.
- **Gives the customer role** to customers when they first get credits or an order.

### About tokens

A customer's Discord token is only ever typed into a private form. The bot passes it straight
to the Reseller API and forgets it: the bot never stores, logs or shows it again. Iancu Services
keeps it encrypted only while the order waits in the queue, and deletes it when the order leaves. The API checks
that the customer can pay **before** it checks the token, so a customer who can't pay never
has their token sent anywhere.

---

## Using PostgreSQL instead of SQLite

SQLite (a single `bot.db` file) is fine for almost every shop. To use PostgreSQL:

1. In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
2. In `.env`, set `DATABASE_URL="postgresql://user:password@host:5432/database"`.
3. Run `npm install`, then `npm start`.

The bot creates its tables on start. Settings are not copied over from `bot.db`.

## For developers

- TypeScript run directly with [tsx](https://tsx.is), discord.js v14 (`Guilds` intent only),
  and Prisma 7 with SQLite.
- `npm test` runs the tests (permission levels, refunds, the events feed positions, credit
  history, and that tokens never reach a log). `npm run typecheck` checks types, and `npm run format` formats.
- `src/api.ts` is the Reseller API client, `src/feed.ts` reads the events feed, and
  `src/notify.ts` handles each event. `src/permissions.ts` holds the staff levels,
  `src/history.ts` the credit history, `src/router.ts` registers and routes commands, and
  `src/commands/` has one file per command group. `CLAUDE.md` lists the rules the code keeps.
- The full API reference: <https://iancu.services/docs/reseller-api>

## Contributing

Pull requests are welcome: new features, fixes, better wording, docs, anything that makes the bot
better for every shop. For a bigger change, open an issue first so we can talk it through. Before
you send one, run `npm run typecheck` and `npm test`, and `npm run format` to match the code style.
If you use Claude Code, `CLAUDE.md` explains the rules the code must keep.

## Credits

This project was written with [Claude](https://claude.com/claude-code), Anthropic's AI coding
assistant.

## License

[MIT](LICENSE) © 2026 Iancu Services
