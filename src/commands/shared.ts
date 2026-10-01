import {
	LabelBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type AutocompleteInteraction,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type RESTPostAPIApplicationCommandsJSONBody,
	type StringSelectMenuInteraction,
	type UserContextMenuCommandInteraction,
} from "discord.js";
import { api } from "../api.ts";

export interface Command {
	data: { name: string; toJSON(): RESTPostAPIApplicationCommandsJSONBody };
	run?(inter: ChatInputCommandInteraction): Promise<unknown>;
	menu?(inter: UserContextMenuCommandInteraction): Promise<unknown>;
	autocomplete?(inter: AutocompleteInteraction): Promise<unknown>;
	// Components and forms are routed by the start of their custom id: "<command name>.<what>:<data>".
	button?(inter: ButtonInteraction): Promise<unknown>;
	select?(inter: StringSelectMenuInteraction): Promise<unknown>;
	modal?(inter: ModalSubmitInteraction): Promise<unknown>;
}

/** Every order, credit change and transfer started from an interaction carries this key. */
export const idempotencyKey = (inter: { id: string }) => `discord-${inter.id}`;

/** The only place a token is ever typed: a private form. */
export const tokenModal = (customId: string, title: string) =>
	new ModalBuilder()
		.setCustomId(customId)
		.setTitle(title.slice(0, 45))
		.addLabelComponents(
			new LabelBuilder()
				.setLabel("Discord token")
				.setDescription("The token of the account the claims go to. It is only used to claim on that account.")
				.setTextInputComponent(
					new TextInputBuilder().setCustomId("token").setStyle(TextInputStyle.Short).setRequired(true),
				),
		);

export const tokenFrom = (inter: ModalSubmitInteraction) => inter.fields.getTextInputValue("token");

/** The number after the last ":" in a custom id. */
export const idData = (customId: string) => Number(customId.split(":").at(-1));

/** Autocomplete over waiting orders: all of the shop's, or one customer's. */
export async function orderChoices(inter: AutocompleteInteraction, customer?: string) {
	const focused = String(inter.options.getFocused()).replace("#", "");
	const { orders } = await api.orders({ state: "pending", customer, limit: 100 });
	return inter.respond(
		orders
			.filter((o) => !focused || String(o.id).includes(focused))
			.slice(0, 25)
			.map((o) => ({
				name: `#${o.id} · ${o.received}/${o.claims} claims · place ${o.place ?? "-"}${customer ? "" : ` · ${o.customer ?? "no customer"}`}`.slice(
					0,
					100,
				),
				value: o.id,
			})),
	);
}
