ProxyChat = {

    socket: null,
    channel: null,
    channelId: null,
    messages: [],
    isHovering: false,
    isScrolledUp: false,
    userMessages: {},
    userInfo: {},
    messageById: {},
    threadSeq: 0,
    thirdPartyEmotes: {},
    thirdPartyEmoteCodesByPriority: [],
    thirdPartyEmotePattern: null,
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
                if (!emote?.code || !emote.images) return;
                ProxyChat.thirdPartyEmotes[emote.code] = {
                    id: emote.id,
                    src: emote.images['4x'] || emote.images['2x'] || emote.images['1x']
                };
            });
        }

        for (const endpoint of ['emotes/global', `users/twitch/${ProxyChat.channelId}`]) {
            let bttvEmotes = await fetchJson(`https://api.betterttv.net/3/cached/${endpoint}`);
            bttvEmotes = Array.isArray(bttvEmotes) ? bttvEmotes : [].concat(bttvEmotes?.channelEmotes ?? [], bttvEmotes?.sharedEmotes ?? []);
            (bttvEmotes ?? []).forEach(emote => {
                if (!emote?.code) return;
                ProxyChat.thirdPartyEmotes[emote.code] = {
                    id: emote.id,
                    src: `https://cdn.betterttv.net/emote/${emote.id}/3x`
                };
            });
        }

        for (const endpoint of ['emote-sets/global', `users/twitch/${ProxyChat.channelId}`]) {
            const stvEmotes = await fetchJson(`https://7tv.io/v3/${endpoint}`);
            const emotes = stvEmotes?.emote_set?.emotes ?? stvEmotes?.emotes ?? [];
            (emotes ?? []).forEach(emote => {
                if (!emote?.name || !emote?.data?.host?.files?.length || !emote.data.host.url?.trim()) return;
                const files = emote.data.host.files;
                const bestQualityEmote = files.reduce((best, file) => {
                    return !best || (file.width * file.height > best.width * best.height) ? file : best;
                }, null);
                const lowestQualityEmote = files.reduce((smallest, file) => {
                    return !smallest || (file.width * file.height < smallest.width * smallest.height) ? file : smallest;
                }, null);
                if (!bestQualityEmote || !lowestQualityEmote) return;
                ProxyChat.thirdPartyEmotes[emote.name] = {
                    id: emote.id,
                    src: `https:${emote.data.host.url}/${bestQualityEmote.name}`,
                    width: `${lowestQualityEmote.width / 10}rem`,
                    height: `${lowestQualityEmote.height / 10}rem`,
                    aspectRatio: `${lowestQualityEmote.width} / ${lowestQualityEmote.height}`,
                    scaleToChat: true
                };
            });
        }

        // store emotes priority by its length
        ProxyChat.thirdPartyEmoteCodesByPriority = Object.keys(ProxyChat.thirdPartyEmotes).filter(code => code && code.trim());
        ProxyChat.thirdPartyEmoteCodesByPriority.sort((a, b) => b.length - a.length);
        ProxyChat.thirdPartyEmotePattern = ProxyChat.thirdPartyEmoteCodesByPriority.length
            ? new RegExp(`(^|\\s)(?:${ProxyChat.thirdPartyEmoteCodesByPriority.map(escapeRegExp).join('|')})(?=\\s|$)`, 'g')
            : null;
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
        const matches = [];

        message.emotes.split("/").forEach((emote) => {
            const [emoteIndex, ranges] = emote.split(":");
            ranges.split(",").forEach((range) => {
                const [start, end] = range.split("-");
                const startIndex = parseInt(start);
                const endIndex = parseInt(end);
                matches.push({
                    start: startIndex,
                    end: endIndex,
                    data: {
                        id: emoteIndex,
                        name: message.msg.substring(startIndex, endIndex + 1),
                        provider: 'Twitch',
                        src: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteIndex}/default/dark/1.0`,
                        hoverSrc: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteIndex}/default/dark/3.0`
                    }
                });
            });
        });

        matches.sort((a, b) => a.start - b.start);
        let cursor = 0;
        matches.forEach(match => {
            if (match.start < cursor) return;
            fragment.append(document.createTextNode(message.msg.substring(cursor, match.start)));
            fragment.append($(ProxyChat.wrapEmote(match.data))[0]);
            cursor = match.end + 1;
        });
        fragment.append(document.createTextNode(message.msg.substring(cursor)));
        return fragment;
    },

    replaceThirdPartyEmotes: function (messageElement) {
        const pattern = ProxyChat.thirdPartyEmotePattern;
        if (!pattern) return;
        messageElement.contents().each(function () {
            if (this.nodeType !== 3) return;
            const text = this.nodeValue;
            if (!text) return;
            let didReplace = false;
            let lastIndex = 0;
            const parts = [];
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const code = match[0].substring(match[1].length);
                parts.push(text.substring(lastIndex, match.index + match[1].length));
                parts.push($(ProxyChat.wrapEmote({
                    ...ProxyChat.thirdPartyEmotes[code],
                    name: code,
                    provider: 'Third-party'
                }))[0]);
                lastIndex = match.index + match[1].length + code.length;
                didReplace = true;
            }
            if (didReplace) {
                parts.push(text.substring(lastIndex));
                ProxyChat.replaceTextNode(this, parts);
            }
        });
    },

    replaceMentions: function (messageElement) {
        const pattern = /(^|\s)(@?[a-zA-Z0-9_]{1,25})\b/g;
        messageElement.contents().each(function () {
            if (this.nodeType !== 3) return;
            const text = this.nodeValue;
            if (!text) return;
            let didReplace = false;
            let lastIndex = 0;
            const parts = [];
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const isAtMention = match[2].charAt(0) === '@';
                const username = isAtMention ? match[2].slice(1) : match[2];
                const login = username.toLowerCase();
                const user = ProxyChat.userInfo[login] || {};
                if (!isAtMention && (!ProxyChat.userInfo[login] || !ProxyChat.isStandaloneUsername(text, match))) {
                    continue;
                }
                const color = user.color || twitchColors[(user.displayName || username).charCodeAt(0) % 16];
                parts.push(text.substring(lastIndex, match.index + match[1].length));
                parts.push($('<span class="anti-ban-chat-mention anti-ban-chat-username">')
                    .attr({
                        'data-user-id': user.userId || login,
                        'data-username': login,
                        'data-display-name': user.displayName || username
                    })
                    .css('color', color)
                    .text(match[2])[0]);
                lastIndex = match.index + match[1].length + match[2].length;
                didReplace = true;
            }
            if (didReplace) {
                parts.push(text.substring(lastIndex));
                ProxyChat.replaceTextNode(this, parts);
            }
        });
    },

    isStandaloneUsername: function (text, match) {
        const end = match.index + match[1].length + match[2].length;
        const after = text[end];
        if (after === '@' || after === ':') return false;
        if (after === '.' && /[a-zA-Z0-9]/.test(text[end + 1] || '')) return false;
        return true;
    },

    replaceUrls: function (messageElement) {
        const pattern = /(?:(?:https?:\/\/|www\.)|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[^\s<]*)/i;
        messageElement.contents().each(function () {
            if (this.nodeType !== 3) return;
            const text = this.nodeValue;
            if (!text) return;
            let didReplace = false;
            let lastIndex = 0;
            const parts = [];
            let match;
            while ((match = pattern.exec(text.substring(lastIndex))) !== null) {
                const value = match[0].replace(/[.,!?;:)]+$/, '');
                if (!value) {
                    lastIndex += match[0].length;
                    continue;
                }
                const start = lastIndex + match.index;
                parts.push(text.substring(lastIndex, start));
                const href = /^(?:https?:\/\/)/i.test(value) ? value : `https://${value}`;
                parts.push($('<a class="anti-ban-chat-link" target="_blank" rel="noopener noreferrer">')
                    .attr('href', href)
                    .text(value)[0]);
                lastIndex = start + value.length;
                didReplace = true;
            }
            if (didReplace) {
                parts.push(text.substring(lastIndex));
                ProxyChat.replaceTextNode(this, parts);
            }
        });
    },

    replaceTextNode: function (textNode, parts) {
        const parent = textNode.parentNode;
        parts.forEach(part => {
            parent.insertBefore(typeof part === 'string' ? document.createTextNode(part) : part, textNode);
        });
        parent.removeChild(textNode);
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
        messageElement.append(ProxyChat.replaceTwitchEmotes(message).contents());
        ProxyChat.replaceThirdPartyEmotes(messageElement);
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
                    <div class="chat-badge" title="${badgeData.title}">
                        <img class="chat-image" alt="${badgeData.title}" src="${badgeData.src1x}" srcset="${badgeData.src1x} 1x, ${badgeData.src4x} 4x"/>
                    </div>
                </div>`;
    },

    wrapBadges: function (message) {
        const badges = [];
        const privilegedBadges = new Set(['admin', 'staff', 'global_mod', 'broadcaster', 'moderator', 'lead_moderator', 'partner']);
        const badgeLabels = {
            admin: 'Twitch admin',
            staff: 'Twitch staff',
            global_mod: 'Twitch global moderator',
            broadcaster: 'Streamer',
            moderator: 'Moderator',
            lead_moderator: 'Lead moderator',
            partner: 'Verified streamer'
        };

        (message.badges || '').split(',').filter(Boolean).forEach(badge => {
            const badgeName = badge.split('/')[0];
            if (!privilegedBadges.has(badgeName) || !(badge in ProxyChat.badges)) return;
            badges.push(ProxyChat.wrapBadge({
                ...ProxyChat.badges[badge],
                title: badgeLabels[badgeName] || badgeName
            }));
        });

        // user-type is present on older IRC messages even when badge metadata is unavailable.
        const role = message['user-type'];
        if (role === 'staff' || role === 'admin' || role === 'mod') {
            const badgeName = role === 'mod' ? 'moderator' : role;
            if (!badges.length || !message.badges?.split(',').some(badge => badge.startsWith(`${badgeName}/`))) {
                const badgeData = Object.entries(ProxyChat.badges).find(([key]) => key.startsWith(`${badgeName}/`))?.[1];
                if (badgeData) badges.push(ProxyChat.wrapBadge({...badgeData, title: badgeLabels[badgeName]}));
            }
        }
        return badges;
    },

    trackUser: function (message) {
        const login = (message.login || message.source?.nickname || '').toLowerCase();
        if (!login) return;
        const user = ProxyChat.userInfo[login] = ProxyChat.userInfo[login] || {};
        const colorChanged = message.color && user.color !== message.color;
        if (message['user-id']) user.userId = message['user-id'];
        if (message.color) user.color = message.color;
        if (message['display-name']) user.displayName = message['display-name'];
        if (colorChanged) {
            $(`.anti-ban-chat-mention[data-username="${login}"]`).css('color', message.color);
        }
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

    formatDuration: function (seconds) {
        const s = parseInt(seconds, 10);
        if (isNaN(s)) return `${seconds}s`;
        if (s < 60) return `${s} second${s !== 1 ? 's' : ''}`;
        if (s < 3600) {
            const m = Math.floor(s / 60);
            const rem = s % 60;
            return rem ? `${m}m ${rem}s` : `${m} minute${m !== 1 ? 's' : ''}`;
        }
        if (s < 86400) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return m ? `${h}h ${m}m` : `${h} hour${h !== 1 ? 's' : ''}`;
        }
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        return h ? `${d}d ${h}h` : `${d} day${d !== 1 ? 's' : ''}`;
    },

    writeBanNotice: function (message) {
        const login = (message.msg || '').trim();
        const targetUserId = message['target-user-id'] || '';
        const duration = message['ban-duration'];
        const rawReason = message['ban-reason'] || '';
        const reason = rawReason ? decodeURIComponent(rawReason.replace(/\\s/g, ' ')) : '';
        const info = ProxyChat.userInfo[login.toLowerCase()] || {};
        const displayName = info.displayName || login || `user:${targetUserId}`;
        const time = new Date().toLocaleTimeString();
        const chatLine = $('<div></div>');
        chatLine.addClass('chat-line anti-ban-system-message anti-ban-ban-notice');
        const timeEl = $('<span>').text(`[${time}] `).css({color: '#adadb8', fontSize: '0.8em'});
        let text;
        if (duration) {
            text = `${displayName} was timed out for ${ProxyChat.formatDuration(duration)} by a moderator`;
        } else {
            text = `${displayName} was banned by a moderator`;
        }
        if (reason) text += ` (Reason: ${reason})`;
        text += '.';
        // IRC CLEARCHAT does not include moderator name; show generic moderator
        chatLine.append(timeEl);
        chatLine.append($('<span>').text(text));
        ProxyChat.messages.push(chatLine.wrap('<div>').parent().html());
    },

    hideFooter: function () {
        const footerSelectors = [
            '.chat-input',
            '[data-test-selector="chat-input-container"]',
            '[data-test-selector="chat-input-buttons-container"]',
            '[data-test-selector="banned-user-message"]',
            '[data-test-selector="request-unban-link"]',
            '[data-test-selector="cooldown-text"]',
            '.banned-chat-overlay',
            '.banned-chat-overlay__halt',
            '.banned-chat-overlay__circle',
            '.banned-chat-overlay__message',
            '.channel-points-reward-line',
            '.community-points-summary',
            '[data-test-selector="community-points-summary"]',
            '[data-test-selector="channel-points-reward-line"]',
            '[data-a-target="chat-input"]',
            '.chat-input-tray',
            '.chat-room__footer',
            '[data-test-selector="chat-footer"]'
        ];
        $(footerSelectors.join(', ')).hide();
        $('.chat-room, .stream-chat').children().not('.chat-room__content, .chat-room__header, [data-a-target="chat-header"], [data-test-selector="chat-header"]').hide();
    },

    initChat: function () {
        $('body').addClass('anti-ban-chat-active');
        $('.chat-room, .stream-chat').addClass('anti-ban-chat-active');
        ProxyChat.hideFooter();

        let proxyChat = $(`<div id="anti-ban-chat"></div>`);
        let chatPaused = $(`<div class="anti-ban-chat-paused"><span>Scroll Down</span></div>`);
        let chatContainer = $('.chat-room__content').children().first();
        chatContainer.removeClass();
        chatContainer.addClass("chat-list--default");
        chatContainer.html(proxyChat);
        chatContainer.attr('style', 'display: block !important; height: 100% !important;');
        $('.chat-room__content').attr('style', 'flex: 1 1 100% !important; height: 100% !important; max-height: 100% !important;');
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
        chatContainer.on('click', '.anti-ban-chat-thread-button', function (event) {
            event.stopPropagation();
            ProxyChat.showThreadPopup($(this).closest('.anti-ban-chat-reply'));
        });
        chatContainer.on('click', '.anti-ban-chat-reply', function () {
            const parentId = $(this).attr('data-reply-parent-id');
            if (!parentId) return;
            const container = $('.chat-list--default');
            const parent = container.find(`.chat-line[data-id="${parentId}"]`);
            if (!parent.length) return;
            const containerTop = container[0].getBoundingClientRect().top;
            const elementTop = parent[0].getBoundingClientRect().top;
            container.scrollTop(container.scrollTop() + (elementTop - containerTop) - container.innerHeight() * 0.3);
            parent.addClass('anti-ban-chat-thread-highlight');
            setTimeout(() => parent.removeClass('anti-ban-chat-thread-highlight'), 2000);
        });
        chatContainer.on('mouseenter', '.anti-ban-emote', function () {
            ProxyChat.showEmoteTooltip($(this));
        });
        chatContainer.on('mouseleave', '.anti-ban-emote', function () {
            ProxyChat.hideEmoteTooltip();
        });
        chatContainer.on('mouseenter', '.anti-ban-chat-link', function () {
            ProxyChat.showImagePreview($(this));
        });
        chatContainer.on('mouseleave', '.anti-ban-chat-link', function () {
            ProxyChat.hideImagePreview();
        });

        chatPaused.on("click", () => {
            const chatContainer = $('.chat-list--default');
            chatContainer.scrollTop(chatContainer.prop('scrollHeight') - chatContainer.innerHeight());
            $('.anti-ban-chat-paused').hide();
        });
        chatPaused.hide();

        ProxyChat.lastDragEnd = 0;
        $(document).on('click.anti-ban-dismiss', function (event) {
            if (Date.now() - ProxyChat.lastDragEnd < 300) return;
            if ($(event.target).closest('.anti-ban-user-popup, .anti-ban-thread-popup, .anti-ban-chat-username, .anti-ban-chat-thread-button').length) return;
            $('.anti-ban-user-popup, .anti-ban-thread-popup').not('.anti-ban-pinned').remove();
        });
    },

    updateChat: setInterval(function () {
        if ($('#anti-ban-chat').length) {
            ProxyChat.hideFooter();
        }
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
        ProxyChat.trackUser(message);
        const login = (message.login || message.source?.nickname || '').toLowerCase();
        const userKey = login || message['user-id'] || 'unknown';
        ProxyChat.userMessages[userKey] = ProxyChat.userMessages[userKey] || [];
        const renderedMessage = ProxyChat.wrapMessage(message);
        ProxyChat.userMessages[userKey].push({
            html: renderedMessage.html(),
            time: new Date().toLocaleTimeString()
        });
        ProxyChat.userMessages[userKey] = ProxyChat.userMessages[userKey].slice(-10);
        ProxyChat.refreshPinnedPopup(userKey);

        const reply = ProxyChat.wrapReply(message);
        if (reply) {
            chatLine.addClass('chat-line--reply');
            chatLine.append(reply);
        }
        ProxyChat.wrapBadges(message).forEach(badge => {
            userInfo.append(badge);
        });
        userInfo.append(ProxyChat.wrapUsername(message));
        userInfo.append(message.action ? '<span>&nbsp;</span>' : '<span class="colon">: </span>');

        chatLine.append(userInfo);
        chatLine.append(renderedMessage);
        ProxyChat.storeMessage(message, renderedMessage);
        ProxyChat.messages.push(chatLine.wrap('<div>').parent().html());
    },

    wrapReply: function (message) {
        const parentId = message['reply-parent-msg-id'];
        if (!parentId) return null;
        const parent = ProxyChat.messageById[parentId];
        const login = parent?.login || (message['reply-parent-user-login'] || '').toLowerCase();
        const displayName = parent?.displayName || message['reply-parent-display-name'] || login || 'User';
        const color = parent?.color || twitchColors[(displayName || login).charCodeAt(0) % 16];
        const reply = $('<span class="anti-ban-chat-reply">').attr('data-reply-parent-id', parentId);
        const content = $('<span class="anti-ban-chat-reply-content"></span>');
        const author = $('<span class="anti-ban-chat-reply-author anti-ban-chat-username"></span>')
            .attr({
                'data-user-id': parent?.userId || login,
                'data-username': login,
                'data-display-name': displayName
            })
            .css('color', color)
            .text(displayName);
        content.append(author);
        if (parent?.text) {
            content.append($('<span class="anti-ban-chat-reply-snippet">').text(parent.text));
        }
        reply.append($('<span class="anti-ban-chat-reply-arrow">↩</span>'), content);
        reply.append($('<button class="anti-ban-chat-thread-button" type="button">').text('View thread'));
        return reply;
    },

    storeMessage: function (message, renderedMessage) {
        if (!message.id) return;
        const parentId = message['reply-parent-msg-id'] || null;
        ProxyChat.messageById[message.id] = {
            id: message.id,
            seq: ++ProxyChat.threadSeq,
            parentId,
            login: (message.login || message.source?.nickname || '').toLowerCase(),
            userId: message['user-id'] || '',
            displayName: message['display-name'] || message.login || message.source?.nickname || '',
            color: message.color || '',
            text: message.msg,
            html: renderedMessage.html(),
            time: new Date().toLocaleTimeString(),
            children: []
        };
        if (parentId && ProxyChat.messageById[parentId]) {
            ProxyChat.messageById[parentId].children.push(message.id);
        }
        const keys = Object.keys(ProxyChat.messageById);
        if (keys.length > 400) {
            keys.slice(0, keys.length - 300).forEach(key => delete ProxyChat.messageById[key]);
        }
    },

    buildThread: function (messageId) {
        const messages = [];
        let node = ProxyChat.messageById[messageId];
        if (!node) return messages;
        while (node.parentId && ProxyChat.messageById[node.parentId]) {
            node = ProxyChat.messageById[node.parentId];
        }
        const queue = [node.id];
        const seen = new Set([node.id]);
        while (queue.length) {
            const current = ProxyChat.messageById[queue.shift()];
            if (!current) continue;
            messages.push(current);
            (current.children || []).forEach(childId => {
                if (!seen.has(childId) && ProxyChat.messageById[childId]) {
                    seen.add(childId);
                    queue.push(childId);
                }
            });
        }
        messages.sort((a, b) => a.seq - b.seq);
        return messages;
    },

    showThreadPopup: function (replyElement) {
        $('.anti-ban-user-popup, .anti-ban-thread-popup').not('.anti-ban-pinned').remove();
        const messageId = replyElement.closest('.chat-line').attr('data-id');
        const messages = ProxyChat.buildThread(messageId);
        const popup = $('<div class="anti-ban-thread-popup">');
        popup.append($('<button class="anti-ban-popup-close" type="button">').text('×'));
        ProxyChat.makePinButton(popup);
        popup.append($('<strong>').text(`Thread (${messages.length})`));
        const thread = $('<div class="anti-ban-thread-messages">');
        messages.forEach(item => {
            const color = item.color || twitchColors[(item.displayName || item.login || '').charCodeAt(0) % 16];
            const name = $('<span class="anti-ban-chat-username"></span>')
                .attr({
                    'data-user-id': item.userId || item.login,
                    'data-username': item.login,
                    'data-display-name': item.displayName
                })
                .css('color', color)
                .text(item.displayName);
            thread.append($('<div class="anti-ban-thread-line"></div>').append(
                $('<time>').text(`${item.time} `),
                name,
                $('<span class="colon">: </span>'),
                $('<span>').html(item.html)
            ));
        });
        popup.append(thread);
        popup.on('click', '.anti-ban-popup-close', () => popup.remove());
        popup.on('click', '.anti-ban-chat-username', function (event) {
            event.stopPropagation();
            ProxyChat.showUserPopup($(this));
        });
        $('body').append(popup);
        const rect = replyElement[0].getBoundingClientRect();
        popup.css({
            top: `${Math.min(rect.bottom, window.innerHeight - popup.outerHeight() - 8)}px`,
            left: `${Math.min(rect.left, window.innerWidth - popup.outerWidth() - 8)}px`
        });
        setTimeout(() => { thread[0].scrollTop = thread[0].scrollHeight; }, 0);
        ProxyChat.makeDraggable(popup);
    },

    showUserPopup: function (usernameElement) {
        $('.anti-ban-user-popup, .anti-ban-thread-popup').not('.anti-ban-pinned').remove();
        const login = (usernameElement.attr('data-username') || '').toLowerCase();
        const userId = usernameElement.attr('data-user-id');
        const user = ProxyChat.userInfo[login] || {};
        const displayName = usernameElement.attr('data-display-name') || user.displayName || login || usernameElement.text().replace(/^@/, '');
        const popup = $('<div class="anti-ban-user-popup">');
        popup.append($('<button class="anti-ban-popup-close" type="button">').text('×'));
        ProxyChat.makePinButton(popup);
        popup.append($('<strong>').text(displayName));
        popup.append($('<a target="_blank" rel="noopener noreferrer">').attr('href', `https://www.twitch.tv/${encodeURIComponent(login || displayName)}`).text('View Twitch profile'));
        const history = $('<div class="anti-ban-user-history">');
        history.attr('data-user-key', login || userId || 'unknown');
        (ProxyChat.userMessages[login || userId || 'unknown'] || []).forEach(item => {
            history.append($('<div>').append($('<time>').text(`${item.time} `), $('<span>').html(item.html)));
        });
        popup.append(history);
        $('body').append(popup);
        const chatWidth = $('.chat-list--default').outerWidth();
        if (chatWidth) popup.css({ width: `${Math.min(chatWidth, window.innerWidth - 8)}px`, maxWidth: 'none' });
        const rect = usernameElement[0].getBoundingClientRect();
        popup.css({top: `${Math.min(rect.bottom, window.innerHeight - popup.outerHeight() - 8)}px`, left: `${Math.min(rect.left, window.innerWidth - popup.outerWidth() - 8)}px`});
        popup.on('click', '.anti-ban-popup-close', () => popup.remove());
        ProxyChat.makeDraggable(popup);
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

    isImageUrl: function (url) {
        try {
            const pathname = new URL(url).pathname;
            return /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|avif)$/i.test(pathname);
        } catch {
            return /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|avif)(\?.*)?$/i.test(url);
        }
    },

    showImagePreview: function (linkElement) {
        ProxyChat.hideImagePreview();
        const url = linkElement.attr('href');
        if (!url || !ProxyChat.isImageUrl(url)) return;
        const preview = $('<div class="anti-ban-image-preview">');
        const img = $('<img>').attr({ src: url, alt: 'Preview' });
        img.on('error', function () { preview.remove(); });
        img.on('load', function () {
            const rect = linkElement[0].getBoundingClientRect();
            const pw = preview.outerWidth();
            const ph = preview.outerHeight();
            let top = rect.top - ph - 8;
            if (top < 8) top = rect.bottom + 8;
            let left = rect.left;
            if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
            if (left < 8) left = 8;
            preview.css({ top: `${top}px`, left: `${left}px` });
        });
        preview.append(img);
        $('body').append(preview);
        const rect = linkElement[0].getBoundingClientRect();
        preview.css({ top: `${rect.bottom + 8}px`, left: `${rect.left}px` });
    },

    hideImagePreview: function () {
        $('.anti-ban-image-preview').remove();
    },

    makeDraggable: function (popup) {
        popup.on('mousedown.draggable', function (e) {
            if ($(e.target).is('button, a, .anti-ban-user-history, .anti-ban-thread-messages, .anti-ban-chat-username')) return;
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const rect = popup[0].getBoundingClientRect();
            const origLeft = rect.left;
            const origTop = rect.top;
            popup.css('cursor', 'grabbing');

            $(document).on('mousemove.draggable', function (e) {
                popup.css({
                    left: `${Math.max(0, Math.min(origLeft + e.clientX - startX, window.innerWidth - popup.outerWidth()))}px`,
                    top: `${Math.max(0, Math.min(origTop + e.clientY - startY, window.innerHeight - popup.outerHeight()))}px`
                });
            }).on('mouseup.draggable', function () {
                ProxyChat.lastDragEnd = Date.now();
                popup.css('cursor', '');
                $(document).off('mousemove.draggable mouseup.draggable');
            });
        });
    },

    refreshPinnedPopup: function (userKey) {
        const history = $(`.anti-ban-user-popup.anti-ban-pinned .anti-ban-user-history[data-user-key="${userKey}"]`);
        if (!history.length) return;
        history.empty();
        (ProxyChat.userMessages[userKey] || []).forEach(item => {
            history.append($('<div>').append($('<time>').text(`${item.time} `), $('<span>').html(item.html)));
        });
        history[0].scrollTop = history[0].scrollHeight;
    },

    makePinButton: function (popup) {
        const pin = $('<button class="anti-ban-popup-pin" type="button" title="Pin">').html(
            '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" fill="currentColor"/></svg>'
        );
        pin.on('click', function () {
            popup.toggleClass('anti-ban-pinned');
        });
        popup.append(pin);
    },

    connect: function (channel) {
        if (ProxyChat.socket) {
            ProxyChat.socket.onclose = function () {};
            ProxyChat.disconnect();
        }
        const channelName = channel.toLowerCase();
        if (ProxyChat.channel !== channelName) {
            ProxyChat.userInfo = {};
            ProxyChat.messageById = {};
        }
        ProxyChat.channel = channelName;

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
                            if (message['target-user-id']) {
                                ProxyChat.clearAllMessages(message['target-user-id']);
                                ProxyChat.writeBanNotice(message);
                            } else {
                                // chat cleared
                                const chatLine = $('<div></div>');
                                chatLine.addClass('chat-line anti-ban-system-message anti-ban-ban-notice');
                                chatLine.append($('<span>').text(`[${new Date().toLocaleTimeString()}] `).css({color: '#adadb8', fontSize: '0.8em'}));
                                chatLine.append($('<span>').text('Chat was cleared by a moderator.'));
                                ProxyChat.messages.push(chatLine.wrap('<div>').parent().html());
                            }
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

    restoreOriginalChat: function () {
        $('body').removeClass('anti-ban-chat-active');
        $('.anti-ban-chat-active').removeClass('anti-ban-chat-active');
        $('#anti-ban-chat').remove();
        $('.anti-ban-chat-paused').remove();
        $('.chat-input, [data-test-selector="chat-input-container"], .channel-points-reward-line, .community-points-summary, .chat-room__footer').show();
        $('.chat-room__content').removeAttr('style');
        ProxyChat.disconnect();
        ProxyChat.channel = null;
        ProxyChat.channelId = null;
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
