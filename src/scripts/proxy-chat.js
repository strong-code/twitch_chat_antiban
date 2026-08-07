ProxyChat = {

    socket: null,
    channel: null,
    channelId: null,
    messages: [],
    isHovering: false,
    isScrolledUp: false,
    userMessages: {},
    thirdPartyEmotes: {},
    thirdPartyEmoteCodesByPriority: [],
    badges: {},
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

    loadTwitchBadges: async function () {
        const globalBadges = await getTwitchBadges('global');
        const channelBadges = await getTwitchBadges(ProxyChat.channelId);
        ProxyChat.parseTwitchBadges(globalBadges?.data ?? []);
        ProxyChat.parseTwitchBadges(channelBadges?.data ?? []);
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
                    const files = emote.data.host.files;
                    const bestQualityEmote = files.reduce((best, file) => {
                        return !best || (file.width * file.height > best.width * best.height) ? file : best;
                    }, null);
                    const lowestQualityEmote = files.reduce((smallest, file) => {
                        return !smallest || (file.width * file.height < smallest.width * smallest.height) ? file : smallest;
                    }, null);
                    ProxyChat.thirdPartyEmotes[emote.name] = {
                        id: emote.id,
                        src: `https:${emote.data.host.url}/${bestQualityEmote.name}`,
                        width: `${lowestQualityEmote.width / 10}rem`,
                        height: `${lowestQualityEmote.height / 10}rem`,
                        aspectRatio: `${lowestQualityEmote.width} / ${lowestQualityEmote.height}`,
                        scaleToChat: true
                    };
                }
            });
        }

        // store emotes priority by its length
        ProxyChat.thirdPartyEmoteCodesByPriority = Object.keys(ProxyChat.thirdPartyEmotes);
        ProxyChat.thirdPartyEmoteCodesByPriority.sort((a, b) => b.length - a.length);
    },

    parseTwitchBadges: function (badgeData) {
        for (const badge of badgeData) {
            for (const version of badge.versions) {
                const key = `${badge.set_id}/${version.id}`;
                ProxyChat.badges[key] = {
                    src1x: version.image_url_1x,
                    src4x: version.image_url_4x
                };
            }
        }
    },

    replaceTwitchEmotes: function (message) {
        if (!message.emotes) return $('<span>').text(message.msg);
        const fragment = $('<span>');
        let cursor = 0;
        const emoteCodes = {};

        message.emotes.split("/").forEach((emote) => {
            const [emoteIndex, ranges] = emote.split(":");
            ranges.split(",").forEach((range) => {
                const [start, end] = range.split("-");
                const emoteCode = message.msg.substring(parseInt(start), parseInt(end) + 1);
                emoteCodes[emoteCode] = {
                    id: emoteIndex,
                    name: emoteCode,
                    provider: 'Twitch',
                    src: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteIndex}/default/dark/1.0`,
                    hoverSrc: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteIndex}/default/dark/3.0`
                };
            });
        });

        const matches = Object.keys(emoteCodes)
            .map(code => ({code, index: message.msg.indexOf(code), data: emoteCodes[code]}))
            .filter(match => match.index >= 0)
            .sort((a, b) => a.index - b.index);
        matches.forEach(match => {
            if (match.index < cursor) return;
            fragment.append(document.createTextNode(message.msg.substring(cursor, match.index)));
            fragment.append($(ProxyChat.wrapEmote(match.data))[0]);
            cursor = match.index + match.code.length;
        });
        fragment.append(document.createTextNode(message.msg.substring(cursor)));
        return fragment;
    },

    replaceThirdPartyEmotes: function (messageElement, msg) {
        const text = msg.text();
        if (!text) return;
        for (const code of ProxyChat.thirdPartyEmoteCodesByPriority) {
            const regex = new RegExp(`(^|\\s)${escapeRegExp(code)}(?=\\s|$)`);
            const match = regex.exec(text);
            if (!match) continue;
            const index = match.index + match[1].length;
            const replacement = $(ProxyChat.wrapEmote({
                ...ProxyChat.thirdPartyEmotes[code],
                name: code,
                provider: 'Third-party'
            }))[0];
            messageElement.empty().append(
                document.createTextNode(text.substring(0, index)),
                replacement,
                document.createTextNode(text.substring(index + code.length))
            );
            ProxyChat.replaceThirdPartyEmotes(messageElement, messageElement);
            return;
        }
    },

    replaceMentions: function (messageElement) {
        const text = messageElement.text();
        if (!text) return;
        const mention = /(^|\s)@([a-zA-Z0-9_]{1,25})\b/.exec(text);
        if (!mention) return;
        const start = mention.index + mention[1].length;
        const username = mention[2];
        const replacement = $('<span class="anti-ban-chat-mention anti-ban-chat-username">')
            .attr({
                'data-user-id': username,
                'data-username': username
            })
            .text(`@${username}`)[0];
        messageElement.empty().append(
            document.createTextNode(text.substring(0, start)),
            replacement,
            document.createTextNode(text.substring(start + username.length + 1))
        );
        ProxyChat.replaceMentions(messageElement);
    },

    replaceUrls: function (messageElement) {
        const text = messageElement.text();
        if (!text) return;
        const url = /(?:(?:https?:\/\/|www\.)|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[^\s<]*)/i.exec(text);
        if (!url) return;
        const value = url[0].replace(/[.,!?;:)]+$/, '');
        const href = /^(?:https?:\/\/)/i.test(value) ? value : `https://${value}`;
        const start = url.index;
        const link = $('<a class="anti-ban-chat-link" target="_blank" rel="noopener noreferrer">')
            .attr('href', href)
            .text(value)[0];
        messageElement.empty().append(
            document.createTextNode(text.substring(0, start)),
            link,
            document.createTextNode(text.substring(start + value.length))
        );
        ProxyChat.replaceUrls(messageElement);
    },

    wrapUsername: function (message) {
        const usernameElement = $('<span class="chat-author__display-name"></span>');
        const color = message.color || twitchColors[message['display-name'].charCodeAt(0) % 16];
        usernameElement.css('color', color);
        usernameElement.text(message['display-name'] ?? message.source?.nickname ?? '');
        usernameElement.attr({
            'data-user-id': message['user-id'] || '',
            'data-username': message.login || message.source?.nickname || ''
        });
        usernameElement.addClass('anti-ban-chat-username');
        return usernameElement;
    },

    wrapMessage: function (message) {
        const messageElement = $('<span></span>');
        if (message.action) {
            const color = message.color || this.twitchColors[message['display-name'].charCodeAt(0) % 16];
            messageElement.css('color', color);
        }
        messageElement.append(ProxyChat.replaceTwitchEmotes(message));
        ProxyChat.replaceThirdPartyEmotes(messageElement, messageElement);
        ProxyChat.replaceMentions(messageElement);
        ProxyChat.replaceUrls(messageElement);
        return messageElement;
    },

    wrapEmote: function (emote) {
        const imgStyle = emote.width || emote.height ? `style="${emote.scaleToChat ? 'max-width: 100%; max-height: 100%; width: auto; height: auto;' : `${emote.width ? `width: ${emote.width};` : ''}${emote.height ? `height: ${emote.height};` : ''}`}${emote.aspectRatio ? `aspect-ratio: ${emote.aspectRatio};` : ''}"` : '';
        const name = $('<div>').text(emote.name || '').html();
        const provider = $('<div>').text(emote.provider || '').html();
        return `<div class="inline-image">
                    <div class="chat-image__container anti-ban-emote" data-emote-name="${name}" data-emote-provider="${provider}">
                        <img class="chat-image chat-line__message--emote" src="${emote.src}" data-hover-src="${emote.hoverSrc || emote.src}" alt="${name}" ${imgStyle}/>
                    </div>
                </div>`;
    },

    wrapBadge: function (badgeData) {
        return `<div class="inline-image">
                    <div class="chat-badge">
                        <img class="chat-image" src="${badgeData.src1x}" srcset="${badgeData.src1x} 1x, ${badgeData.src4x} 4x"/>
                    </div>
                </div>`;
    },

    wrapBadges: function (message) {
        let badges = [];
        if (message.badges) {
            message.badges.split(',').forEach(badge => {
                const badgeName = badge.split('/')[0];
                const privilegedBadges = ['admin', 'staff', 'global_mod', 'broadcaster', 'moderator', 'lead_moderator'];
                if (privilegedBadges.includes(badgeName) && badge in ProxyChat.badges) {
                    const badgeData = ProxyChat.badges[badge];
                    badges.push(ProxyChat.wrapBadge(badgeData));
                }
            });
        }
        return badges;
    },

    log: function (message) {
        ProxyChat.writeChat({
            'display-name': "Twitch Anti-Ban",
            'msg': message
        });
        console.log(`Twitch Anti-Ban: ${message}`);
    },

    clearMessage: function (messageId) {
        setTimeout(function () {
            const messageElement = $(`.chat-line[data-id=${messageId}]`);
            if (messageElement.length) {
                messageElement.addClass('chat-line--deleted');
            }
        }, 100);
    },

    clearAllMessages: function (userId) {
        setTimeout(function () {
            const userMessages = $(`.chat-line[data-user-id=${userId}]`);
            if (userMessages.length) {
                userMessages.addClass('chat-line--deleted');
            }
        }, 100);
    },

    initChat: function () {
        let proxyChat = $(`<div id="anti-ban-chat"></div>`);
        let chatPaused = $(`<div class="anti-ban-chat-paused"><span>Scroll Down</span></div>`);
        let chatContainer = $('.chat-room__content').children().first();
        chatContainer.removeClass();
        chatContainer.addClass("chat-list--default");
        chatContainer.html(proxyChat);
        chatContainer.attr('style', 'display: block !important;');
        chatContainer.append(chatPaused);

        chatContainer.on('mouseenter', function () {
            ProxyChat.isHovering = true;
            chatPaused.text('Chat scroll paused').show();
        });
        chatContainer.on('mouseleave', function () {
            ProxyChat.isHovering = false;
            chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
            ProxyChat.isScrolledUp = false;
            chatPaused.hide();
        });
        chatContainer.on('scroll', function () {
            const distance = this.scrollHeight - this.clientHeight - this.scrollTop;
            ProxyChat.isScrolledUp = distance > this.clientHeight * 0.2;
            if (!ProxyChat.isScrolledUp) $('.anti-ban-chat-paused').hide();
        });

        chatContainer.on('click', '.anti-ban-chat-username', function (event) {
            event.stopPropagation();
            ProxyChat.showUserPopup($(this));
        });
        chatContainer.on('mouseenter', '.anti-ban-emote', function () {
            ProxyChat.showEmoteTooltip($(this));
        });
        chatContainer.on('mouseleave', '.anti-ban-emote', function () {
            ProxyChat.hideEmoteTooltip();
        });

        chatPaused.on("click", () => {
            const chatContainer = $('.chat-list--default');
            chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
            $('.anti-ban-chat-paused').hide();
        });
        chatPaused.hide();
    },

    updateChat: setInterval(function () {
        if (ProxyChat.messages.length > 0) {
            ProxyChat.messages.forEach(message => {
                const chatContainer = $('.chat-list--default');
                const isScrolledNearBottom = chatContainer.prop('scrollHeight') - chatContainer.innerHeight() <= chatContainer.scrollTop() + chatContainer.innerHeight() * 0.2; // 20% from bottom of container
                $('#anti-ban-chat').append(message);
                if (!ProxyChat.isHovering) {
                    if (isScrolledNearBottom) {
                        chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
                        $('.anti-ban-chat-paused').hide();
                    } else if (!ProxyChat.isScrolledUp) {
                        chatPaused.text('Scroll Down').show();
                    }
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
        const userId = message['user-id'] || message.source?.nickname || 'unknown';
        ProxyChat.userMessages[userId] = ProxyChat.userMessages[userId] || [];
        const renderedMessage = ProxyChat.wrapMessage(message);
        ProxyChat.userMessages[userId].push({
            html: renderedMessage.html(),
            time: new Date().toLocaleTimeString()
        });
        ProxyChat.userMessages[userId] = ProxyChat.userMessages[userId].slice(-10);
        ProxyChat.wrapBadges(message).forEach(badge => {
            userInfo.append(badge);
        });
        userInfo.append(ProxyChat.wrapUsername(message));
        userInfo.append(message.action ? '<span>&nbsp;</span>' : '<span class="colon">: </span>');

        chatLine.append(userInfo);
        chatLine.append(ProxyChat.wrapMessage(message));
        ProxyChat.messages.push(chatLine.wrap('<div>').parent().html());
    },

    showUserPopup: function (usernameElement) {
        $('.anti-ban-user-popup').remove();
        const userId = usernameElement.attr('data-user-id') || usernameElement.attr('data-username');
        const username = usernameElement.attr('data-username') || usernameElement.text();
        const popup = $('<div class="anti-ban-user-popup">');
        popup.append($('<button class="anti-ban-popup-close" type="button">').text('×'));
        popup.append($('<strong>').text(username));
        popup.append($('<a target="_blank" rel="noopener noreferrer">').attr('href', `https://www.twitch.tv/${encodeURIComponent(username)}`).text('View Twitch profile'));
        const history = $('<div class="anti-ban-user-history">');
        (ProxyChat.userMessages[userId] || []).forEach(item => {
            history.append($('<div>').append($('<time>').text(`${item.time} `), $('<span>').html(item.html)));
        });
        popup.append(history);
        $('body').append(popup);
        const rect = usernameElement[0].getBoundingClientRect();
        popup.css({top: `${Math.min(rect.bottom, window.innerHeight - popup.outerHeight() - 8)}px`, left: `${Math.min(rect.left, window.innerWidth - popup.outerWidth() - 8)}px`});
        popup.on('click', '.anti-ban-popup-close', () => popup.remove());
    },

    showEmoteTooltip: function (emoteElement) {
        ProxyChat.hideEmoteTooltip();
        const image = emoteElement.find('img')[0];
        const tooltip = $('<div class="anti-ban-emote-tooltip">');
        tooltip.append($('<strong>').text(emoteElement.attr('data-emote-name')));
        tooltip.append($('<small>').text(emoteElement.attr('data-emote-provider')));
        tooltip.append($('<img>').attr({src: image.dataset.hoverSrc || image.src, alt: image.alt}));
        $('body').append(tooltip);
        const rect = emoteElement[0].getBoundingClientRect();
        tooltip.css({top: `${Math.max(8, rect.top - tooltip.outerHeight() - 8)}px`, left: `${Math.min(rect.left, window.innerWidth - tooltip.outerWidth() - 8)}px`});
    },

    hideEmoteTooltip: function () {
        $('.anti-ban-emote-tooltip').remove();
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
                            if (message['target-msg-id']) ProxyChat.clearMessage(message['target-msg-id']);
                            return;
                        case "CLEARCHAT":
                            if (message['target-user-id']) ProxyChat.clearAllMessages(message['target-user-id']);
                            return;
                        case "PRIVMSG":
                            if (message.channel.toLowerCase() !== ProxyChat.channel || !message.msg) return;
                            ProxyChat.writeChat(message);
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
