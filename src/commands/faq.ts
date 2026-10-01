import {
	ChannelType,
	LabelBuilder,
	ModalBuilder,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type SlashCommandStringOption,
} from "discord.js";
import { prisma } from "../db.ts";
import { code, done, embed, EPHEMERAL, refused, staffLog } from "../discord.ts";
import { allowed, Level } from "../permissions.ts";
import { FAQ_PAGE_LENGTH, faqEntryText, faqPage, pageButton, post, refresh } from "../views.ts";
import { checkChannel, inServer } from "./settings.ts";
import { idData, type Command } from "./shared.ts";

const queryOption = (o: SlashCommandStringOption) =>
	o.setName("query").setDescription("Search the questions and answers").setRequired(true).setAutocomplete(true);

// "?" on a question without one, "." on an answer without an ending.
const tidyQuestion = (q: string) => (q.trim().endsWith("?") ? q.trim() : `${q.trim()}?`);
const tidyAnswer = (a: string) => (/[.!?]$/.test(a.trim()) ? a.trim() : `${a.trim()}.`);

/** Moves entries so their positions are 1, 2, 3 in the given order. */
async function renumber(ids: number[]) {
	await prisma.$transaction(ids.map((id, i) => prisma.faq.update({ where: { id }, data: { position: i + 1 } })));
}

const ordered = () => prisma.faq.findMany({ orderBy: { position: "asc" } });

export const faq: Command = {
	data: new SlashCommandBuilder()
		.setName("faq")
		.setDescription("Frequently asked questions")
		.addSubcommand((s) =>
			s
				.setName("show")
				.setDescription("The FAQ, a page at a time")
				.addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)),
		)
		.addSubcommand((s) => s.setName("search").setDescription("Find one question").addStringOption(queryOption))
		.addSubcommand((s) =>
			s
				.setName("add")
				.setDescription("Add a question at the end (staff)")
				.addStringOption((o) => o.setName("question").setDescription("The question").setRequired(true))
				.addStringOption((o) => o.setName("answer").setDescription("The answer").setRequired(true)),
		)
		.addSubcommand((s) =>
			s.setName("edit").setDescription("Edit a question and its answer (staff)").addStringOption(queryOption),
		)
		.addSubcommand((s) =>
			s.setName("remove").setDescription("Remove a question (staff)").addStringOption(queryOption),
		)
		.addSubcommand((s) =>
			s
				.setName("move")
				.setDescription("Move a question to another position (staff)")
				.addStringOption(queryOption)
				.addIntegerOption((o) =>
					o.setName("position").setDescription("New position").setMinValue(1).setRequired(true),
				),
		)
		.addSubcommand((s) =>
			s
				.setName("channel")
				.setDescription("Post the FAQ message in a channel, replacing the old one (staff)")
				.addChannelOption((o) =>
					o
						.setName("channel")
						.setDescription("Where to post it")
						.addChannelTypes(ChannelType.GuildText)
						.setRequired(true),
				),
		)
		.addSubcommand((s) => s.setName("update").setDescription("Refresh the FAQ message now (staff)")),

	async run(inter) {
		const sub = inter.options.getSubcommand();

		if (sub === "show") {
			await inter.deferReply(); // public
			return inter.editReply(await faqPage(inter.options.getInteger("page") ?? 1));
		}

		if (sub === "search") {
			const entry = await find(inter);
			if (!entry) return;
			return inter.reply({
				embeds: [embed({ title: `❓ ${entry.question}`.slice(0, 256), description: entry.answer })],
			});
		}

		if (sub === "edit") {
			// A form cannot be deferred, so the level is checked first, and again when it is submitted.
			if (!(await allowed(inter, Level.Moderator))) return;
			const entry = await find(inter);
			if (!entry) return;
			return inter.showModal(
				new ModalBuilder()
					.setCustomId(`faq.edit:${entry.id}`)
					.setTitle("Edit FAQ")
					.addLabelComponents(
						new LabelBuilder()
							.setLabel("Question")
							.setTextInputComponent(
								new TextInputBuilder()
									.setCustomId("question")
									.setStyle(TextInputStyle.Short)
									.setValue(entry.question)
									.setMaxLength(1000),
							),
						new LabelBuilder()
							.setLabel("Answer")
							.setTextInputComponent(
								new TextInputBuilder()
									.setCustomId("answer")
									.setStyle(TextInputStyle.Paragraph)
									.setValue(entry.answer)
									.setMaxLength(4000),
							),
					),
			);
		}

		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Moderator))) return;

		switch (sub) {
			case "add": {
				const question = tidyQuestion(inter.options.getString("question", true));
				const answer = tidyAnswer(inter.options.getString("answer", true));
				if (tooLong(question, answer)) return inter.editReply({ embeds: [tooLongEmbed()] });
				const position = (await prisma.faq.count()) + 1;
				await prisma.faq.create({ data: { position, question, answer } });
				return changed(inter, "✅ FAQ entry added", `${code(position)}. ${question}`);
			}
			case "remove": {
				const entry = await find(inter);
				if (!entry) return;
				await prisma.faq.delete({ where: { id: entry.id } });
				await renumber((await ordered()).map((e) => e.id));
				return changed(inter, "✅ FAQ entry removed", entry.question);
			}
			case "move": {
				const entry = await find(inter);
				if (!entry) return;
				const ids = (await ordered()).map((e) => e.id).filter((id) => id !== entry.id);
				const position = Math.min(inter.options.getInteger("position", true), ids.length + 1);
				ids.splice(position - 1, 0, entry.id);
				await renumber(ids);
				return changed(inter, "✅ FAQ entry moved", `${entry.question} is now at position ${code(position)}.`);
			}
			case "channel": {
				if (!(await inServer(inter))) return;
				const channel = await checkChannel(inter);
				if (!channel) return;
				await post("faq", channel);
				await staffLog(inter.user.id, "⚙️ FAQ message posted", `In <#${channel.id}>`);
				return inter.editReply({
					embeds: [done("✅ FAQ posted", `The FAQ message is now in <#${channel.id}>.`)],
				});
			}
			case "update":
				await refresh("faq");
				return inter.editReply({ embeds: [done("✅ FAQ refreshed")] });
		}
	},

	async modal(inter) {
		await inter.deferReply(EPHEMERAL);
		if (!(await allowed(inter, Level.Moderator))) return;
		const id = idData(inter.customId);
		const question = tidyQuestion(inter.fields.getTextInputValue("question"));
		const answer = tidyAnswer(inter.fields.getTextInputValue("answer"));
		if (tooLong(question, answer)) return inter.editReply({ embeds: [tooLongEmbed()] });
		const updated = await prisma.faq.updateMany({ where: { id }, data: { question, answer } });
		if (!updated.count)
			return inter.editReply({ embeds: [refused("⛔ Not found", "That FAQ entry no longer exists.")] });
		return changed(inter, "✅ FAQ entry edited", question);
	},

	async autocomplete(inter) {
		const focused = String(inter.options.getFocused()).toLowerCase();
		const entries = await ordered();
		return inter.respond(
			entries
				.filter((e) => e.question.toLowerCase().includes(focused) || e.answer.toLowerCase().includes(focused))
				.slice(0, 25)
				.map((e) => ({ name: `${e.position}. ${e.question}`.slice(0, 100), value: String(e.id) })),
		);
	},

	button: (inter) => pageButton(inter, faqPage),
};

/** The entry picked with autocomplete, or a reply saying it was not found. */
async function find(inter: ChatInputCommandInteraction) {
	const query = inter.options.getString("query", true);
	const entry = /^\d+$/.test(query) ? await prisma.faq.findUnique({ where: { id: Number(query) } }) : null;
	if (!entry) {
		const reply = { embeds: [refused("⛔ Not found", "Pick a question from the list.")] };
		if (inter.deferred) await inter.editReply(reply);
		else await inter.reply({ ...reply, ...EPHEMERAL });
	}
	return entry;
}

const tooLong = (question: string, answer: string) => faqEntryText(question, answer).length > FAQ_PAGE_LENGTH;
const tooLongEmbed = () => refused("⛔ Too long", "That entry is longer than one FAQ page. Please shorten it.");

async function changed(inter: ChatInputCommandInteraction | ModalSubmitInteraction, title: string, what: string) {
	await refresh("faq");
	await staffLog(inter.user.id, title, what);
	return inter.editReply({ embeds: [done(title, what)] });
}
