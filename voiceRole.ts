import * as getLogger from "loggy";
import { getDB } from "@utils/db";
import { Plugin } from "@cogs/plugin";
import { IModule } from "@sb-types/ModuleLoader/Interfaces.new";
import { replaceAll } from "@utils/text";
import { messageToExtra } from "@utils/failToDetail";
import { ModulePrivateInterface } from "@sb-types/ModuleLoader/PrivateInterface";
import { createConfirmationMessage } from "@utils/interactive";
import { initializationMethod, unloadMethod } from "@sb-types/ModuleLoader/Decorators";
import { MessagesFlows, IMessageFlowContext, IPublicFlowCommand } from "@cogs/cores/messagesFlows/messagesFlows";
import { generateLocalizedEmbed, localizeForGuild, localizeForUser } from "@utils/ez-i18n";
import { EmbedType, resolveGuildRole, resolveGuildChannel, getMessageMember } from "@utils/utils";
import { Message, Guild, Role, GuildMember, VoiceChannel, Collection, VoiceState } from "discord.js";
import Verify from "@cogs/verify/verify";
import { ModulePublicInterface } from "@sb-types/ModuleLoader/PublicInterfaces";

// Welcome to ruins of VoiceRole module :)
// ... it will be updated one day — they say

const TABLE_NAME = "voice_role";
const SPECIFIC_TABLE_NAME = "specificvoicerole";
const VOICEROLE_COMMAND = "voicerole";
function hasManagePermissions(member: GuildMember) {
	return member.permissions.has(["MANAGE_GUILD", "MANAGE_CHANNELS", "MANAGE_ROLES"])
		|| member.permissions.has("ADMINISTRATOR"); // TODO: is that really necessary?
}

interface IGuildRow {
	/**
	 * Discord snowflake, guild ID
	 */
	guild_id: string;

	/**
	 * Discord snowflake, role ID
	 * or `-` if no role set
	 */
	voice_role: string | "-";
}

interface ISpecificRoleRow {
	guild_id: string;
	channel_id: string;
	voice_role: string;
}

// FIXME: make a new help function maybe and use it instead

// const HELP_CHECKS = {
// 	default: (msg: Message) => msg.channel.type === "text" && MANAGE_PERMS(msg.member)
// };

// const HELP_CATEGORY = "VOICEROLE";


// @command(HELP_CATEGORY, `${VOICEROLE_COMMAND} set`, `loc:VOICEROLE_META_SET`, {
// 	[`loc:VOICEROLE_META_SET_ARG0`]: {
// 		description: `loc:VOICEROLE_META_SET_ARG0_DESC`,
// 		optional: false
// 	}
// }, HELP_CHECKS.default)
// @command(HELP_CATEGORY, `${VOICEROLE_COMMAND} delete`, `loc:VOICEROLE_META_DELETE`, undefined, HELP_CHECKS.default)
// @command(HELP_CATEGORY, `${VOICEROLE_COMMAND} specific set`, `loc:VOICEROLE_META_SPECIFICSET`, {
// 	[`loc:VOICEROLE_META_SPECIFICSET_ARG0`]: {
// 		description: `loc:VOICEROLE_META_SPECIFICSET_ARG0_DESC`,
// 		optional: false
// 	},
// 	[`loc:VOICEROLE_META_SET_ARG0`]: {
// 		description: `loc:VOICEROLE_META_SET_ARG0_DESC`,
// 		optional: false
// 	}
// }, HELP_CHECKS.default)
// @command(HELP_CATEGORY, `${VOICEROLE_COMMAND} speficic delete`, `loc:VOICEROLE_META_SPECIFICDELETE`, {
// 	[`loc:VOICEROLE_META_SPECIFICDELETE_ARG0`]: {
// 		description: `loc:VOICEROLE_META_SPECIFICDELETE_ARG0_DESC`,
// 		optional: false
// 	}
// }, HELP_CHECKS.default)

export class VoiceRole extends Plugin implements IModule<VoiceRole> {
	private readonly _db = getDB();
	private readonly _log = getLogger("VoiceRole");
	private _flowHandler: IPublicFlowCommand;
	private _verifyInterface?: ModulePublicInterface<Verify>;

	constructor() {
		super({
			"voiceStateUpdate": (oldVoiceState: VoiceState, newVoiceState: VoiceState) => this._onVCUpdated(oldVoiceState, newVoiceState)
		}, true);

		this._log("VoiceRole plugin constructed and ready to work!");
	}

	@initializationMethod
	public async init(i: ModulePrivateInterface<VoiceRole>) {
		this._log("info", "Checking table");

		let dbStatus: boolean = false;

		try {
			dbStatus = await this._db.schema.hasTable(TABLE_NAME);
		} catch (err) {
			$snowball.captureException(err);

			this._log("err", "Error checking if table was created", err);

			return;
		}

		if (!dbStatus) {
			this._log("warn", "Table in DB is not created. Going to create it right now");

			const creationStatus = await this._createTable();

			if (!creationStatus) {
				this._log("err", "Table creation failed.");

				return;
			}
		}

		this._log("info", "Checking specific table");

		let specificDBStatus = false;

		try {
			specificDBStatus = await this._db.schema.hasTable(SPECIFIC_TABLE_NAME);
		} catch (err) {
			$snowball.captureException(err);
			this._log("err", "Error checking if specific table is created");

			return;
		}

		if (!specificDBStatus) {
			this._log("warn", "Specific table not created in DB. Going to create it right meow");

			const creationStatus = await this._createSpecificTable();

			if (!creationStatus) {
				this._log("err", "Specific table creation failed.");

				return;
			}
		}

		const messagesFlowsKeeper = i.getDependency<MessagesFlows>("messages-flows");

		if (!messagesFlowsKeeper) {
			throw new Error("Cannot find `MessagesFlows` dependency");
		}

		messagesFlowsKeeper.onInit((mf) => {
			return this._flowHandler = mf.watchForCommands(
				(ctx) => this._onMessage(ctx),
				VOICEROLE_COMMAND
			);
		});

		const verifyInterface = i.getDependency<Verify>("verify");

		if (!verifyInterface) {
			this._log("warn", "`Verify` dependency not found. It helps to prevent non-verified members to gain a role and make malicious actions");
		} else {
			this._verifyInterface = verifyInterface;
		}

		this._handleEvents();

		for (const guild of $discordBot.guilds.values()) {
			if (!guild.available) {
				this._log("warn", `Cleanup ignored at Guild: "${guild.name}" because it isnt' available at the moment`);

				return;
			}

			this._log("info", `Cleanup started at Guild: "${guild.name}"`);

			await this._doCleanup(guild);
		}

		this._log("ok", "'VoiceRole' plugin loaded and ready to work");
	}

	private async _createTable() {
		try {
			await this._db.schema.createTable(TABLE_NAME, (tb) => {
				tb.string("guild_id").notNullable();
				tb.string("voice_role").defaultTo("-");
			});

			this._log("ok", "Created table for 'voice roles'");

			return true;
		} catch (err) {
			$snowball.captureException(err);

			this._log("err", "Failed to create table. An error has occured:", err);

			return false;
		}
	}

	private async _createSpecificTable() {
		try {
			await this._db.schema.createTable(SPECIFIC_TABLE_NAME, (tb) => {
				tb.string("guild_id").notNullable();
				tb.string("channel_id").notNullable();
				// FIXME: voice_role SHOULD be nullable to not store excessive data
				tb.string("voice_role").notNullable();
			});

			this._log("ok", "Created table for specific 'voice roles'");

			return true;
		} catch (err) {
			$snowball.captureException(err);

			this._log("err", "Failed to create table for specific 'voice roles'");

			return false;
		}
	}

	private async _onMessage(ctx: IMessageFlowContext) {
		if (ctx.message.channel.type !== "text") { return; }
		if (!ctx.message.content) { return; }

		try {
			return await this._settingsCommand(ctx);
		} catch (err) {
			$snowball.captureException(err, {
				extra: {
					parsed: ctx.parsed,
					msg: messageToExtra(ctx.message)
				}
			});

			// we don't await here, so unhandled err if smthn is expected
			ctx.message.channel.send({
				embed: await generateLocalizedEmbed(EmbedType.Error, ctx.message.member, "VOICEROLE_CMD_FAULT")
			});
		}
	}

	private async _isVerfied(member: GuildMember) {
		const itf = this._verifyInterface;

		if (!itf) return true;
		
		const base = itf.getBase();

		if (!base) return false;

		return base.isVerified(member);
	}

	private async _onVCUpdated(oldVCState: VoiceState, newVCState: VoiceState) {
		const member = newVCState.member;

		if (!(await this._isVerfied(member))) {
			// not going to do anything if user isn't verified
			return;
		}

		if (oldVCState.channel && newVCState.channel) {
			if (oldVCState.channel.guild.id !== newVCState.channel.guild.id) {
				// moved from one server to another (╯°□°）╯︵ ┻━┻
				// better not to wait this
				this._doRemoveRoles(oldVCState);
				this._doGiveRoles(newVCState);
			} else {
				// just moved from channel to channel on same server
				this._doRemoveRoles(oldVCState, newVCState);
				this._doGiveRoles(newVCState);
			}
		} else if (oldVCState.channel && !newVCState.channel) {
			this._doRemoveRoles(oldVCState);
		} else if (!oldVCState.channel && newVCState.channel) {
			this._doGiveRoles(newVCState);
		}
	}

	private async _searchGuildRow(guild: Guild): Promise<IGuildRow | null> {
		return this._db(TABLE_NAME).where({
			guild_id: guild.id
		}).first();
	}

	private async _getGuildRow(guild: Guild) {
		const element: null | IGuildRow = await this._searchGuildRow(guild);

		if (element) return element;

		await this._db(TABLE_NAME).insert({
			guild_id: guild.id,
			voice_role: "-"
		});

		return this._searchGuildRow(guild);
	}

	private async _getAllSpecificRowsOfGuild(guild: Guild, method: "role" | "channel") {
		const rows = <ISpecificRoleRow[]> ((await this._db(SPECIFIC_TABLE_NAME).where({
			guild_id: guild.id
		})) || []);

		const map = new Map<string, ISpecificRoleRow | ISpecificRoleRow[]>();

		for (const row of rows) {
			if (method !== "channel") {
				const current = map.get(row.voice_role);

				if (current) {
					map.set(row.voice_role, (<ISpecificRoleRow[]> []).concat(current).concat(row));
				}

				continue;
			}

			map.set(row.channel_id, row);
		}

		return map;
	}

	private async _getSpecificRow(channel: VoiceChannel | string) : Promise<ISpecificRoleRow> {
		return this._db(SPECIFIC_TABLE_NAME).where({
			channel_id: typeof channel === "string" ? channel : channel.id
		}).first();
	}

	private async _updateSpecificRole(row: ISpecificRoleRow) {
		const current = await this._getSpecificRow(row.channel_id);
		if (!current) {
			await this._db(SPECIFIC_TABLE_NAME).insert(row);

			return;
		}
		await this._db(SPECIFIC_TABLE_NAME).where({
			channel_id: row.channel_id
		}).update(row);
	}

	private async _deleteSpecificRow(row: ISpecificRoleRow) {
		return this._db(SPECIFIC_TABLE_NAME).where(row).first().delete();
	}

	private async _updateGuildRow(row: IGuildRow) {
		return this._db(TABLE_NAME).where({
			guild_id: row.guild_id
		}).update(row);
	}

	private async _doCleanup(guild: Guild, role?: Role) {
		if (!role) {
			const row = await this._getGuildRow(guild);

			if (row && row.voice_role !== "-") {
				if (!guild.roles.has(row.voice_role)) {
					row.voice_role = "-";
					await this._updateGuildRow(row);
				}
				role = guild.roles.get(row.voice_role);
			}
		}

		let allSpecificRows = await this._getAllSpecificRowsOfGuild(guild, "role");
		let changes = false; // to check if something changed

		// slight optimization
		const checkRow = async (s: ISpecificRoleRow) => {
			if (!guild.channels.has(s.channel_id) || !guild.roles.has(s.voice_role)) {
				changes = true;
				await this._deleteSpecificRow(s);
			}
		};

		for (const specific of allSpecificRows.values()) {
			if (specific instanceof Array) {
				for (const s of specific) { await checkRow(s); }
			} else {
				checkRow(specific);
			}
		}

		if (changes) {
			// because we made a lot of changes before
			allSpecificRows = await this._getAllSpecificRowsOfGuild(guild, "role");
		}

		let members : Collection<string, GuildMember>;

		try {
			members = await guild.members.fetch();
		} catch (err) {
			this._log("err", "Could not fetch guild members", err);

			return;
		}

		for (const member of members.values()) {
			let voiceChannelOfMember: VoiceChannel | undefined = member.voice.channel;
			if (voiceChannelOfMember && voiceChannelOfMember.guild.id !== guild.id) {
				voiceChannelOfMember = undefined;
			}

			if (role) {
				if (!voiceChannelOfMember && member.roles.has(role.id)) {
					member.roles.remove(role);
				} else if (voiceChannelOfMember && !member.roles.has(role.id)) {
					member.roles.add(role);
				}
			}

			// removing old specific roles
			for (const memberRole of member.roles.values()) {
				const specificRow = allSpecificRows.get(memberRole.id);
				if (!specificRow) { continue; }
				let ok = false;
				if (voiceChannelOfMember) {
					if (specificRow instanceof Array) {
						ok = !!specificRow.find((s) => voiceChannelOfMember ? voiceChannelOfMember.id === s.channel_id : false);
					} else {
						ok = voiceChannelOfMember.id === specificRow.channel_id;
					}
				}
				if (!ok) {
					member.roles.remove(memberRole);
				} // else keeping role
			}

			// adding new specific role
			// tslint:disable-next-line:early-exit
			if (voiceChannelOfMember) {
				let specificRoleForChannel: ISpecificRoleRow | undefined = undefined;

				// because Map has no .find(), fuck
				for (const specific of allSpecificRows.values()) {
					if (specific instanceof Array) {
						for (const realSpecific of specific) {
							if (realSpecific.channel_id === voiceChannelOfMember.id) {
								specificRoleForChannel = realSpecific;
								break;
							}
						}
						if (specificRoleForChannel) { break; }
					} else if (specific.channel_id === voiceChannelOfMember.id) {
						specificRoleForChannel = specific;
						break;
					}
				}

				// that's finnaly all the code we need
				if (specificRoleForChannel) {
					if (guild.roles.has(specificRoleForChannel.voice_role)) {
						if (!member.roles.has(specificRoleForChannel.voice_role)) {
							member.roles.add(specificRoleForChannel.voice_role);
						}
					} else {
						await this._deleteSpecificRow(specificRoleForChannel);
					}
				}
			}
		}

		return;
	}

	private async _doGiveRoles(voiceState: VoiceState) {
		const member = voiceState.member;

		const row = await this._getGuildRow(member.guild);

		const vChannel = voiceState.channel;

		const specificRow = vChannel ? await this._getSpecificRow(vChannel) : undefined;
		if (!row && !specificRow) { return; }

		if (row && vChannel && row.voice_role !== "-") {
			// we have row & user in voice channel
			// let's check everything
			if (member.guild.roles.has(row.voice_role)) {
				// guild has our voice role
				// let's give it to user if he has not it
				if (!member.roles.has(row.voice_role)) {
					// yep, take this role, my dear
					await member.roles.add(
						row.voice_role,
						await localizeForGuild(
							member.guild,
							"VOICEROLE_JOINED_VC", {
								channelName: vChannel.name
							}
						)
					);
				} // nop, you have this role, next time.. next time...
			} else {
				// guild has no our voice role
				// no surprises in bad admins
				// removing it
				row.voice_role = "-";
				await this._updateGuildRow(row);
			}
		}

		// tslint:disable-next-line:early-exit
		if (specificRow) {
			// we found specific role for this voice channel
			if (!member.guild.roles.has(specificRow.voice_role)) {
				// but sadly bad admin removed it, can remove row
				await this._deleteSpecificRow(specificRow);
			} else if (!member.roles.has(specificRow.voice_role)) {
				// dear, why don't you have this specific role?
				await member.roles.add(
					specificRow.voice_role,
					await localizeForGuild(
						member.guild,
						"VOICEROLE_SPECIFIC_ADDED", {
							channelName: vChannel!.name
						}
					)
				);
			}
		}
	}

	private async _doRemoveRoles(voiceState: VoiceState, newVCState?: VoiceState) {
		const member = voiceState.member;

		const row = await this._getGuildRow(member.guild);

		const specificRow = voiceState.channel ? await this._getSpecificRow(voiceState.channel) : undefined;

		if (!row && !specificRow) { return; }

		if (!newVCState || !newVCState.channel) {
			// checking IF user not in voice channel anymore
			// OR if we have no 'newMember' (means user left from any channel on guild)
			// THEN deleting role
			if (row && row.voice_role !== "-") {
				if (member.guild.roles.has(row.voice_role)) {
					// role's here, we can remove it
					// but let's check if user HAS this role
					if (member.roles.has(row.voice_role)) {
						// yes, he has it, can remove
						await member.roles.remove(
							row.voice_role,
							await localizeForGuild(
								member.guild,
								"VOICEROLE_LEFT_VC", {
									channelName: voiceState.channel!.name
								}
							)
						);
					} // else we doing nothin'
				} else {
					// wowee, role got deleted
					// so we deleting guild row too
					row.voice_role = "-";
					await this._updateGuildRow(row);
				}
			}
		}

		// tslint:disable-next-line:early-exit
		if (specificRow && voiceState.channel) {
			// we had specific role for old channel
			// time to test if everything is OK
			if (!member.guild.roles.has(specificRow.voice_role)) {
				// sadly, but this means not everything is OK
				// we have no specific role no more on this guild
				// time to delete specific row
				await this._deleteSpecificRow(specificRow);
			} else if (member.roles.has(specificRow.voice_role)) {
				// there we got good answer means everything is OK
				// we can remove old specific role
				await member.roles.remove(
					specificRow.voice_role,
					await localizeForGuild(
						member.guild,
						"VOICEROLE_SPECIFIC_REMOVED", {
							channelName: voiceState.channel.name
						}
					)
				);
			}
		}
	}

	private async _settingsCommand(ctx: IMessageFlowContext) {
		const parsed = ctx.parsed;
		if (!parsed || !parsed.command) { return; } // ???

		const msg = ctx.message; // backwards compat

		const msgMember = await getMessageMember(msg);

		if (!msgMember) { return; }

		const hasPermissionToChange = hasManagePermissions(msgMember);

		if (!hasPermissionToChange) {
			msg.channel.send(await localizeForUser(msgMember, "VOICEROLE_NOPERMS"));

			return;
		}

		const subcmd = parsed.subCommand; // renamed war, so could see usage of prev one
		if (!subcmd || subcmd === "help") {
			return msg.channel.send({
				embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, {
					custom: true,
					string: `${await localizeForUser(msgMember, "VOICEROLE_SETTING_HELP")}\n${await localizeForUser(msgMember, "VOICEROLE_SETTING_HELP_SPECIFIC")}`
				}, {
					universalTitle: await localizeForUser(msgMember,
						"VOICEROLE_SETTING_HELP_TITLE")
				})
			});
		}

		if (subcmd === "set") {
			if (!parsed.arguments) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, {
						custom: true,
						string: replaceAll(await localizeForUser(msgMember, "VOICEROLE_SETTING_HELP_SET"), "\n", "\n\t")
					})
				});
			}

			const resolvedRole = resolveGuildRole(parsed.arguments[0].raw, msg.guild, {
				caseStrict: false,
				strict: false
			});

			if (!resolvedRole) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ROLENOTFOUND")
				});
			}

			const row = await this._getGuildRow(msg.guild);

			if (!row) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBGUILDNOTFOUND")
				});
			}

			const onFaultCleanup = async (err) => {
				$snowball.captureException(err, {
					extra: {
						row, newRole: resolvedRole,
						...messageToExtra(msg)
					}
				});

				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ROLECLEANUP")
				});
			};

			const confirmation = await createConfirmationMessage(await generateLocalizedEmbed(EmbedType.Progress, msgMember, {
				key: "VOICEROLE_SETTING_CONFIRMATION_SET",
				formatOptions: {
					role: replaceAll(resolvedRole.name, "`", "'")
				}
			}), msg);

			if (!confirmation) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CANCELED")
				});
			}

			if (row.voice_role !== "-") {
				try {
					for (const member of msg.guild.members.values()) {
						if (!row) { continue; }
						if (member.roles.has(row.voice_role)) {
							await member.roles.remove(row.voice_role);
						}
					}
				} catch (err) {
					return onFaultCleanup(err);
				}
			}

			row.voice_role = resolvedRole.id;

			try {
				await this._updateGuildRow(row);
			} catch (err) {
				$snowball.captureException(err, {
					extra: { row, newRole: resolvedRole, ...messageToExtra(msg) }
				});

				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_SAVING")
				});
			}

			try {
				await this._doCleanup(msg.guild);
			} catch (err) {
				return onFaultCleanup(err);
			}

			msg.react("👍");

			return;
		} else if (subcmd === "delete") {
			const row = await this._getGuildRow(msg.guild);

			if (!row) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBGUILDNOTFOUND")
				});
			}

			const onFaultCleanup = async (err: Error) => {
				$snowball.captureException(err, {
					extra: {
						row,
						...messageToExtra(msg)
					}
				});

				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ROLECLEANUP")
				});
			};

			if (row.voice_role === "-") {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Warning, msgMember, "VOICEROLE_SETTING_FAULT_VRNOTSET")
				});
			}

			const updateRow = async () => {
				try {
					await this._updateGuildRow(row);

					return true;
				} catch (err) {
					$snowball.captureException(err, {
						extra: { ...messageToExtra(msg), row, voiceRoleDeleted: true }
					});
					msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBSAVING")
					});

					return false;
				}
			};

			const resolvedRole = msg.guild.roles.get(row.voice_role);

			if (!resolvedRole) {
				row.voice_role = "-";
				if (await updateRow()) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, "VOICEROLE_SETTING_FASTDELETE")
					});
				}

				return;
			}

			const confirmation = await createConfirmationMessage(await generateLocalizedEmbed(EmbedType.Progress, msgMember, {
				key: "VOICEROLE_SETTING_CONFIRMATION_DELETE",
				formatOptions: {
					role: replaceAll(resolvedRole.name, "`", "'"),
					notice: await localizeForUser(msgMember, "VOICEROLE_SETTING_CONFIRMATIONS_NOTICE")
				}
			}), msg);

			if (!confirmation) {
				return msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CANCELED")
				});
			}

			try {
				for (const member of msg.guild.members.values()) {
					if (member.roles.has(row.voice_role)) {
						await member.roles.remove(row.voice_role);
					}
				}
			} catch (err) {
				return onFaultCleanup(err);
			}

			row.voice_role = "-";

			await updateRow();

			try {
				await this._doCleanup(msg.guild);
			} catch (err) {
				return onFaultCleanup(err);
			}

			msg.react("👍");

			return;
		} else if (subcmd === "specific") {
			if (!parsed.arguments) {
				// TODO: help for specific
				return;
			}

			// back comp
			const specCallCont = ctx.message.content.slice(`${ctx.prefix!}${parsed.command} ${parsed.subCommand}`.length).trim();
			const _spcIndex = specCallCont.indexOf(" ");
			const specSubCmd = specCallCont.slice(0, _spcIndex);
			const specArgs = specCallCont.slice(_spcIndex).split(",").map(a => a.trim());

			if (specSubCmd === "set") {
				if (specArgs.length === 0) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, {
							key: "VOICEROLE_SETTING_HELP_SPECIFIC_SET",
							formatOptions: {
								argInfo: replaceAll(await localizeForUser(msgMember, "VOICEROLE_SETTING_ARGINFO_SPECIFIC"), "\n", "\n\t")
							}
						})
					});
				} else if (specArgs.length !== 2) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ARGERR")
					});
				}

				const resolvedChannel = resolveGuildChannel(specArgs[0], msg.guild, {
					caseStrict: false,
					strict: false,
					possibleMention: false,
					types: ["voice"]
				});

				if (!resolvedChannel) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CHANNELERR")
					});
				}

				const resolvedRole = resolveGuildRole(specArgs[1], msg.guild, {
					caseStrict: false,
					strict: false
				});

				if (!resolvedRole) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ROLENOTFOUND")
					});
				}

				const confirmation = await createConfirmationMessage(await generateLocalizedEmbed(EmbedType.Progress, msgMember, {
					key: "VOICEROLE_SETTING_SPECIFIC_CONFIRMATION",
					formatOptions: {
						role: replaceAll(resolvedRole.name, "`", "'"),
						voiceChannel: replaceAll(resolvedChannel.name, "`", "'")
					}
				}), msg);

				if (!confirmation) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CANCELED")
					});
				}

				// #region Handling current specific voice role

				const currentSpecVR = await this._getSpecificRow(<VoiceChannel> resolvedChannel);

				if (currentSpecVR) {
					const oldRole = currentSpecVR.voice_role;
					currentSpecVR.voice_role = resolvedRole.id;

					const statusMessage = <Message> await msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Progress, msgMember, "VOICEROLE_SETTING_SAVING")
					});

					const onFaultSubmit = async (err: Error, specialMsgStr?: string) => {
						$snowball.captureException(err, {
							extra: {
								currentSpecVR, oldRole, newRole: resolvedRole,
								...messageToExtra(msg)
							}
						});

						return msg.channel.send({
							embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, specialMsgStr || "VOICEROLE_SETTING_FAULT_ROLECLEANUP")
						});
					};

					try {
						for (const member of msg.guild.members.values()) {
							if (member.roles.has(oldRole)) {
								await member.roles.remove(oldRole);
							}
						}
					} catch (err) {
						return onFaultSubmit(err);
					}

					try {
						await this._updateSpecificRole(currentSpecVR);
					} catch (err) {
						return onFaultSubmit(err, "VOICEROLE_SETTING_FAULT_DBSAVING");
					}

					try {
						await this._doCleanup(msg.guild);
					} catch (err) {
						return onFaultSubmit(err);
					}

					msg.react("👍");

					return statusMessage.edit("", {
						embed: await generateLocalizedEmbed(EmbedType.OK, msgMember, "VOICEROLE_SETTING_SAVING_DONE")
					});
				}

				const newRow: ISpecificRoleRow = {
					channel_id: resolvedChannel.id,
					guild_id: msg.guild.id,
					voice_role: resolvedRole.id
				};

				const statusMessage = <Message> await msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, "VOICEROLE_SETTING_SAVING")
				});

				try {
					await this._updateSpecificRole(newRow);
					await this._doCleanup(msg.guild);
				} catch (err) {
					$snowball.captureException(err, {
						extra: {
							currentSpecVR, new: newRow,
							...messageToExtra(msg)
						}
					});
					statusMessage.edit("", {
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBSAVING")
					});
				}

				// #endregion

				msg.react("👍");

				return statusMessage.edit("", {
					embed: await generateLocalizedEmbed(EmbedType.OK, msgMember, "VOICEROLE_SETTING_SETTINGDONE")
				});
			} else if (specSubCmd === "delete") {
				if (specArgs.length !== 1) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, {
							key: "VOICEROLE_SETTING_HELP_SPECIFIC_DELETE",
							formatOptions: {
								argInfo: replaceAll(await localizeForUser(msgMember, "VOICEROLE_SETTING_ARGINFO_SPECIFIC"), "\n", "\n\t")
							}
						})
					});
				}

				const resolvedChannel = resolveGuildChannel(specArgs[0], msg.guild, {
					caseStrict: false,
					strict: false,
					possibleMention: false,
					types: ["voice"]
				});

				if (!resolvedChannel) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CHANNELERR")
					});
				}

				const current = await this._getSpecificRow(<VoiceChannel> resolvedChannel);

				if (!current) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, "VOICEROLE_SETTING_FAULT_NOSPECIFICROLE")
					});
				}

				const resolvedRole = msg.guild.roles.get(current.voice_role);
				if (!resolvedRole) {
					// removing faster!
					try {
						await this._deleteSpecificRow(current);
					} catch (err) {
						$snowball.captureException(err, {
							extra: {
								specificDeleted: false, current,
								...messageToExtra(msg)
							}
						});

						return msg.channel.send({
							embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBSAVING")
						});
					}

					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Information, msgMember, "VOICEROLE_SETTING_SPECIFIC_FASTDELETE")
					});
				}

				const confirmation = await createConfirmationMessage(await generateLocalizedEmbed(EmbedType.Progress, msgMember, {
					key: "VOICEROLE_SETTING_SPECIFIC_DELETECONFIRMATION",
					formatOptions: {
						role: replaceAll(resolvedRole.name, "`", "'"),
						voiceChannel: replaceAll(resolvedChannel.name, "`", "'"),
						notice: await localizeForUser(msgMember, "VOICEROLE_SETTING_CONFIRMATIONS_NOTICE")
					}
				}), msg);

				if (!confirmation) {
					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_CANCELED")
					});
				}

				const statusMessage = <Message> await msg.channel.send({
					embed: await generateLocalizedEmbed(EmbedType.Progress, msgMember, "VOICEROLE_SETTING_SAVING")
				});

				try {
					await this._deleteSpecificRow(current);
				} catch (err) {
					$snowball.captureException(err, {
						extra: {
							specificDeleted: false, current,
							...messageToExtra(msg)
						}
					});

					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_DBSAVING")
					});
				}

				try {
					for (const member of msg.guild.members.values()) {
						if (member.roles.has(current.voice_role)) {
							await member.roles.remove(current.voice_role);
						}
					}
					await this._doCleanup(msg.guild);
				} catch (err) {
					$snowball.captureException(err, {
						extra: {
							specificDeleted: true, current,
							...messageToExtra(msg)
						}
					});

					return msg.channel.send({
						embed: await generateLocalizedEmbed(EmbedType.Error, msgMember, "VOICEROLE_SETTING_FAULT_ROLECLEANUP")
					});
				}

				msg.react("👍");

				return statusMessage.edit("", {
					embed: await generateLocalizedEmbed(EmbedType.OK, msgMember, "VOICEROLE_SETTING_SPEFIC_DELETED")
				});
			}
		}
	}

	@unloadMethod
	public async unload() {
		this._flowHandler && this._flowHandler.unhandle();
		this._unhandleEvents();

		return true;
	}
}

module.exports = VoiceRole;
