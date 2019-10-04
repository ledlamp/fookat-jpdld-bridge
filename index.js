(async function (){
	require('dotenv').config()
	global.RocketChat = require('@rocket.chat/sdk');
	global.driver = RocketChat.driver;
	global.api = RocketChat.api;
	global.methodCache = RocketChat.methodCache;

	await driver.connect();
	await driver.login(); // using environment variables
	await driver.subscribeToMessages();


	global.Discord = require("discord.js");
	global.dClient = new Discord.Client({disableEveryone: true});
	await dClient.login(process.env.DISCORD_TOKEN);
	dClient.on("error", console.error);


	const JPDLD_GUILD_ID = "357038384121905152";

	// fookat rocket to jpdld discord
	var receivedRcMsgIDs = [];
	await driver.reactToMessages(async function(e, m, mo){
		if (e) return console.error(e);
		if (receivedRcMsgIDs.includes(m._id)) return; // apparently the server re-sends messages with the same id to add url information for embeds; so we need to collect the msg IDs to ignore those
		else receivedRcMsgIDs.push(m._id);
		if (m.u._id == driver.userId) return;
		if (!m.mentions && !m.channels) return; // ignore user join/leave messages and whatever else; TODO any better way to differentiate them?
		var roomName = mo && mo.roomName || await driver.getRoomId(m.rid);
		if (!roomName.startsWith("jpdld_")) return;
		var dcname = roomName.substr("jpdld_".length);
		var jpdldGuild = dClient.guilds.get(JPDLD_GUILD_ID);
		if (!jpdldGuild) return console.warn("Can't find JPDLD guild!");
		var dc = jpdldGuild.channels.find(c => c.name == dcname);
		if (!dc) return console.warn(`Couldn't find JPDLD Discord channel ${dcname} to bridge to RC channel ${roomName}`); // TODO add reaction
		if (!dc.wh) {
			console.log("Attaching webhook to dc", dc.name);
			try {
				if (dcname in require("./webhooks")) {
					let wh = require("./webhooks")[dcname];
					dc.wh = new Discord.WebhookClient(wh.id, wh.token);
				} else {
					let whs = await dc.fetchWebhooks();
					let wh = whs.find(w => w.name == "fookat bridge");
					if (wh) dc.wh = wh;
					else {
						dc.wh = await dc.createWebhook("fookat bridge", undefined, "Automatically created webhook to bridge to fookat.tk");
					}
				}
			} catch(e) {
				console.error(`Couldn't get webhook for ${dcname}:`, e.message);
				await fallbackSend();
				return;
			}
		}
		try {
			await dc.wh.send(m.msg,{
				username: m.u.username.substr(0,32),
				avatarURL: `https://fookat.tk/avatar/${m.u.username}`,
				split: true,
				disableEveryone: true,
				embeds: m.attachments ? m.attachments.map(a => ({
					title: a.title,
					url: a.title_link ? "https://fookat.tk" + a.title_link : undefined,
					description: a.description,
					image: a.image_url ? {url: "https://fookat.tk" + a.image_url} : undefined
				})) : undefined
			});
		} catch(e) {
			console.error(`JPDLD webhook send failure:`, e);
			await fallbackSend();
		}
		async function fallbackSend() {
			await dc.send(`**${m.u.username}:** ${m.msg}`, {
				split: true,
				embeds: m.attachments ? m.attachments.map(a => ({
					title: a.title,
					url: a.title_link ? "https://fookat.tk" + a.title_link : undefined,
					description: a.description,
					image: a.image_url ? {url: "https://fookat.tk" + a.image_url} : undefined
				})) : undefined
			}).catch(e => console.error(`Couldn't send fallback message to JPDLD channel ${dcname} (${e.message})`));
		}
	});

	// jpdld discord to fookat rocket
	//var rcroomBlacklist = [];
	dClient.on("message", async function(message){
		if (!message.guild || message.guild.id != JPDLD_GUILD_ID) return;
		if (message.author.id == dClient.user.id || (message.channel.wh && message.channel.wh.id == message.author.id)) return;
		var rcroom = "jpdld_" + message.channel.name;
		//if (rcroomBlacklist.includes(rcroom)) return;
		async function sendrcmsg(rid) {
			var rcmsg = driver.prepareMessage();
			rcmsg.rid = rid || await driver.getRoomId(rcroom);
			rcmsg.msg = message.cleanContent;
			rcmsg.alias = message.member && message.member.displayName || message.author.username;
			rcmsg.avatar = message.author.avatarURL || message.author.defaultAvatarURL;
			rcmsg.attachments = message.attachments.map(attachment => ({
				title: attachment.filename,
				title_link: attachment.url,
				title_link_download: true,
				image_url: attachment.width ? attachment.url : undefined,
				audio_url: [".ogg", ".mp3", ".wav", ".flac"].some(ext=>attachment.filename.endsWith(ext)) ? attachment.url : undefined,
				video_url: [".mp4", ".webm", ".mov", ".avi"].some(ext=>attachment.filename.endsWith(ext)) ? attachment.url : undefined

			}));
			message.rcmsg = await driver.sendMessage(rcmsg);
		}
		try {
			await sendrcmsg();
		} catch (e) {
			console.warn(`Failed to send message from JPDLD guild to fookat room ${rcroom}; attempting to create room and send again. (${e.message})`);
			let res = await api.post("channels.create", {name: rcroom});
			if (!res.success) return console.error("Failed to create rc channel", rcroom);
			await driver.subscribe("stream-room-messages", res.channel._id);
			try {
				await sendrcmsg(res.channel._id);
				methodCache.reset("getRoomIdByNameOrId", rcroom);
				return;
			} catch(e) {
				console.error(e.message);
			}
			/*try {
				//await new Promise(r => setTimeout(r, 3000));
				await sendrcmsg();
			} catch(e) {
				console.warn(`Failed to send JPDLD message to fookat room ${rcroom} after creating room; adding to blacklist. (${e.message})`);
				rcroomBlacklist.push(rcroom);
			}*/
		}
	});
	// synchronize message edits and deletes too, from discord to rocket
	dClient.on("messageUpdate", async function (oldMessage, newMessage) {
		if (newMessage.rcmsg) {
			await api.post('chat.update', {
				roomId: newMessage.rcmsg.rid,
				msgId: newMessage.rcmsg._id,
				text: newMessage.cleanContent
			}).catch(e => console.error("Failed to synchronize message edit from discord to rocket:", e.message));
		}
	});
	dClient.on("messageDelete", async function (message) {
		if (message.rcmsg) {
			await api.post('chat.delete', {
				roomId: message.rcmsg.rid,
				msgId: message.rcmsg._id,
				//asUser: true // ??
			}).catch(e => console.error("Failed to syncrhonize message delete from discord to rocket:", e.message));
		}
	});

})();
