ProxyChat = {

    socket: null,
    channel: null,
    channelId: null,
    messages: [],
    thirdPartyEmotes: {},
    thirdPartyEmoteCodesByPriority: [],
    pingIntervalID: null,

    loadChannelData: async function () {
        const channelId = await getTwitchUserId(ProxyChat.channel);
        if (channelId === null) {
            ProxyChat.log(`Unable to fetch channel ID for channel name: ${ProxyChat.channel}`);
        } else {
            ProxyChat.channelId = channelId;
            await ProxyChat.loadThirdPartyEmotes();
            await ProxyChat.loadTwitchBadges();
        }
    },

    loadThirdPartyEmotes: async function () {
        ProxyChat.thirdPartyEmotes = {};
        ProxyChat.thirdPartyEmoteCodesByPriority = [];

        for (const endpoint of ['emotes/global', `users/twitch/${ProxyChat.channelId}`]) {
            const ffzEmotes = await fetchJson(`https://api.betterttv.net/3/cached/frankerfacez/${endpoint}`);
            (ffzEmotes ?? []).forEach(emote => {
                ProxyChat.thirdPartyEmotes[emote.code] = {
                    id: emote.id,
                    src: emote.images['4x'] || emote.images['2x'] || emote.images['1x']
                };
            });
        }

        for (const endpoint of ['emotes/global', `users/twitch/${ProxyChat.channelId}`]) {
            let bttvEmotes = await fetchJson(`https://api.betterttv.net/3/cached/${endpoint}`);
            bttvEmotes = Array.isArray(bttvEmotes) ? bttvEmotes : bttvEmotes?.channelEmotes.concat(bttvEmotes?.sharedEmotes) ?? [];
            bttvEmotes?.forEach(emote => {
                ProxyChat.thirdPartyEmotes[emote.code] = {
                    id: emote.id,
                    src: `https://cdn.betterttv.net/emote/${emote.id}/3x`
                };
            });
        }

        for (const endpoint of ['emote-sets/global', `users/twitch/${ProxyChat.channelId}`]) {
            const stvEmotes = await fetchJson(`https://7tv.io/v3/${endpoint}`);
            const emotes = stvEmotes?.emote_set?.emotes ?? stvEmotes?.emotes ?? [];
            emotes?.forEach(emote => {
                if (emote?.data?.host?.files?.length && emote.data.host.url?.trim()) {
                    const bestQualityEmote = emote.data.host.files.pop();
                    const lowestQualityEmote = emote.data.host.files.shift();
                    ProxyChat.thirdPartyEmotes[emote.name] = {
                        id: emote.id,
                        src: `https:${emote.data.host.url}/${bestQualityEmote.name}`,
                        width: `${lowestQualityEmote.width / 10}rem`,
                        height: `${lowestQualityEmote.height / 10}rem`
                    };
                }
            });
        }

        // store emotes priority by its length
        ProxyChat.thirdPartyEmoteCodesByPriority = Object.keys(ProxyChat.thirdPartyEmotes);
        ProxyChat.thirdPartyEmoteCodesByPriority.sort((a, b) => b.length - a.length);
    },

    replaceTwitchEmotes: function (message) {
        if (!message.emotes) return message.msg;
        let msg = message.msg;
        const emoteCodes = {};

        message.emotes.split("/").forEach((emote) => {
            const [emoteIndex, ranges] = emote.split(":");
            ranges.split(",").forEach((range) => {
                const [start, end] = range.split("-");
                const emoteCode = message.msg.substring(parseInt(start), parseInt(end) + 1);
                emoteCodes[emoteCode] = {
                    src: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteIndex}/default/dark/3.0`
                };
            });
        });

        for (const emote of Object.keys(emoteCodes)) {
            const emoteHtml = ProxyChat.wrapEmote(emoteCodes[emote]);
            const regex = new RegExp(`(?<!\\S)(${escapeRegExp(emote)})(?!\\S)`, 'g');
            msg = msg.replace(regex, emoteHtml);
        }

        return msg;
    },

    replaceThirdPartyEmotes: function (msg) {
        for (const emoteCode of ProxyChat.thirdPartyEmoteCodesByPriority) {
            const emoteHtml = ProxyChat.wrapEmote(ProxyChat.thirdPartyEmotes[emoteCode]);
            const regex = new RegExp(`(?<!\\S)(${escapeRegExp(emoteCode)})(?!\\S)`, 'g');
            msg = msg.replace(regex, emoteHtml);
        }

        return msg;
    },

    wrapUsername: function (message) {
        const usernameElement = $('<span class="chat-author__display-name"></span>');
        const color = message.color || twitchColors[message['display-name'].charCodeAt(0) % 16];
        usernameElement.css('color', color);
        usernameElement.html(message['display-name'] ?? message.source.nickname);
        return usernameElement;
    },

    wrapMessage: function (message) {
        const messageElement = $('<span></span>');
        if (message.action) {
            const color = message.color || this.twitchColors[message['display-name'].charCodeAt(0) % 16];
            messageElement.css('color', color);
        }
        let msgWithEmotes;
        msgWithEmotes = ProxyChat.replaceTwitchEmotes(message);
        msgWithEmotes = ProxyChat.replaceThirdPartyEmotes(msgWithEmotes);
        messageElement.html(msgWithEmotes);
        return messageElement;
    },

    wrapEmote: function (emote) {
        const imgStyle = emote.width || emote.height ? `style="width: ${emote.width || 'auto'}; height: ${emote.height || 'auto'};"` : '';
        return `<div class="inline-image">
                    <div class="chat-image__container" ${imgStyle}>
                        <img class="chat-image chat-line__message--emote" src="${emote.src}"/>
                    </div>
                </div>`;
    },

    log: function (message) {
        ProxyChat.writeChat({
            'display-name': "Twitch Anti-Ban",
            'msg': message
        });
        console.log(`Twitch Anti-Ban: ${message}`);
    },

    softDelete: function (messageId) {
        setTimeout(function () {
            $(`.chat-line[data-id=${messageId}]`).css('opacity', '0.5');
        }, 100);
    },

    softDeleteAllMessages: function (userId) {
        setTimeout(function () {
            $(`.chat-line[data-user-id=${userId}]`).css('opacity', '0.5');
        }, 100);
    },

    initChat: function () {
        let proxyChat = $(`<div id="proxy-chat"></div>`);
        let chatPaused = $(`<div class="chat-paused"><span>Chat paused due to mouseover</span></div>`);
        let chatContainer = $('.chat-room__content').children().first();
        chatContainer.removeClass();
        chatContainer.addClass("chat-list--default");
        chatContainer.html(proxyChat);
        chatContainer.append(chatPaused);
        chatPaused.on("click", () => {
            const chatContainer = $('.chat-list--default');
            chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
            $('.chat-paused').hide();
        });
        chatPaused.hide();
    },

    updateChat: setInterval(function () {
        if (ProxyChat.messages.length > 0) {
            ProxyChat.messages.forEach(message => {
                const chatContainer = $('.chat-list--default');
                const isHoveringOver = chatContainer.matches(':hover')
                // const isScrolledNearBottom = chatContainer.prop('scrollHeight') - chatContainer.innerHeight() <= chatContainer.scrollTop() + chatContainer.innerHeight() * 0.2; // 20% from bottom of container
                $('#proxy-chat').append(message);
                if (!isHoveringOver) {
                    chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
                    $('.chat-paused').hide();
                } else {
                    $('.chat-paused').show();
                }
            })
            ProxyChat.messages = [];
            $('.chat-line:lt(-200)').remove();
        }
    }, 200),

    writeChat: function (message) {
        const chatLine = $('<div></div>');
        const userInfo = $('<span></span>');
        chatLine.addClass('chat-line chat-line__message');
        chatLine.attr('data-user-id', message['user-id']);
        chatLine.attr('data-id', message.id);
        userInfo.append(ProxyChat.wrapUsername(message));
        userInfo.append(message.action ? '<span>&nbsp;</span>' : '<span class="colon">: </span>');

        chatLine.append(userInfo);
        chatLine.append(ProxyChat.wrapMessage(message));
        ProxyChat.messages.push(chatLine.wrap('<div>').parent().html());
    },

    connect: function (channel) {
        if (ProxyChat.socket) {
            ProxyChat.socket.onclose = function () {};
            ProxyChat.disconnect();
        }
        ProxyChat.channel = channel.toLowerCase();

        let disconnectTimeout;
        let lastDisconnectedTime = null;
        const reconnectionThreshold = 5000;

        ProxyChat.loadChannelData().then(() => {
            if (!ProxyChat.channelId) return;

            ProxyChat.log('Connecting to chat server...');
            ProxyChat.socket = new ReconnectingWebSocket('wss://irc-ws.chat.twitch.tv', 'irc', {reconnectInterval: 2000});

            ProxyChat.socket.onopen = function () {
                clearTimeout(disconnectTimeout);
                if (lastDisconnectedTime === null || (Date.now() - lastDisconnectedTime) > reconnectionThreshold) {
                    ProxyChat.log(`Connected to #${ProxyChat.channel}`);
                }
                ProxyChat.socket.send('PASS pass\r\n');
                ProxyChat.socket.send(`NICK justinfan${Math.floor(Math.random() * 999999)}\r\n`);
                ProxyChat.socket.send('CAP REQ :twitch.tv/commands twitch.tv/tags\r\n');
                ProxyChat.socket.send(`JOIN #${ProxyChat.channel}\r\n`);

                clearInterval(ProxyChat.pingIntervalID);
                ProxyChat.pingIntervalID = setInterval(function () {
                    ProxyChat.socket.send('PING\r\n');
                }, 4 * 60 * 1000);
            };

            ProxyChat.socket.ontimeout = function () {
                ProxyChat.log('Connection timeout, reconnecting...');
            };

            ProxyChat.socket.onclose = function () {
                clearInterval(ProxyChat.pingIntervalID);
                lastDisconnectedTime = Date.now();
                disconnectTimeout = setTimeout(function () {
                    ProxyChat.log('Disconnected');
                }, reconnectionThreshold);
            };

            ProxyChat.socket.onmessage = function (data) {
                data.data.split('\r\n').forEach(line => {
                    if (!line) return;
                    const message = parseIRCMessage(line);

                    switch (message.command) {
                        case "PING":
                            ProxyChat.socket.send(`PONG ${message.msg}\r\n`);
                            return;
                        case "JOIN":
                            ProxyChat.log(`Joined channel: ${ProxyChat.channel}`);
                            return;
                        case "CLEARMSG":
                            if (message['target-msg-id']) ProxyChat.softDelete(message['target-msg-id']);
                            return;
                        case "CLEARCHAT":
                            if (message['target-user-id']) ProxyChat.softDeleteAllMessages(message['target-user-id']);
                            return;
                        case "PRIVMSG":
                            if (message.channel.toLowerCase() !== ProxyChat.channel || !message.msg) return;
                            ProxyChat.writeChat(message);
                            return;
                        default:
                            ProxyChat.log(`Unhandled command received: ${message.command}`);
                            return;
                    }
                });
            };
        });
    },

    disconnect: function () {
        if (ProxyChat.socket) {
            ProxyChat.socket.close();
            ProxyChat.socket = null;
        }
        if (ProxyChat.pingIntervalID) {
            clearInterval(ProxyChat.pingIntervalID);
            ProxyChat.pingIntervalID = null;
        }
    }
}
