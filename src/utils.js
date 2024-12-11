const twitchColors = ["#FF0000", "#0000FF", "#008000", "#B22222", "#E05B5B", "#FF7F50", "#9ACD32", "#FF4500", "#2E8B57", "#DAA520", "#D2691E", "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F"];

async function fetchJson(url, method = "GET", headers = {}, body = null) {
    try {
        const response = await fetch(url, {
            method: method,
            headers: headers,
            body: body
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.log(`Twitch Anti-Ban: unable to fetch from ${url}: ${error}`);
        return null;
    }
}

async function getTwitchUserId(username) {
    const userId = await getFromStorage(username.toString());
    if (userId) {
        console.log('Twitch Anti-Ban: found channel ID in local storage:', userId);
        return userId;
    }
    const data = await fetchJson(
        `https://%APIURL%/getTwitchUserId?username=${username}`
    );
    if (data) {
        await storeToStorage(username, data);
        console.log('Twitch Anti-Ban: channel ID stored in local storage:', data);
    }
    return data;
}

async function getFromStorage(key) {
    return new Promise((resolve) => {
        if (typeof browser !== 'undefined') {
            browser.storage.local.get([key]).then((result) => resolve(result[key]));
        } else {
            chrome.storage.local.get([key], (result) => resolve(result[key]));
        }
    });
}

async function storeToStorage(key, value) {
    return new Promise((resolve) => {
        if (typeof browser !== 'undefined') {
            browser.storage.local.set({[key]: value}).then(resolve);
        } else {
            chrome.storage.local.set({[key]: value}, resolve);
        }
    });
}

function parseIRCMessage(message) {
    const parsedMessage = {};

    if (message.startsWith('PING')) {
        parsedMessage.command = 'PING';
        parsedMessage.msg = message.split(' ').slice(1).join(' ');
        return parsedMessage;
    }

    const [tags, source, command, channel, ...msg] = message.split(' ');

    if (tags.startsWith('@')) {
        const tagsString = tags.substring(1);
        const tagsArray = tagsString.split(';');
        tagsArray.forEach(tag => {
            const [key, value] = tag.split('=');
            parsedMessage[key] = value;
        });
    }

    if (source.startsWith(':')) {
        const sourceString = source.substring(1);
        const [nickname, user, host] = sourceString.split(/[!@]/);
        parsedMessage.source = {nickname, user, host};
    }

    parsedMessage.command = command;
    parsedMessage.channel = channel?.substring(1);

    parsedMessage.msg = msg.join(' ').substring(1);
    if (parsedMessage.msg.startsWith('\x01ACTION') && parsedMessage.msg.endsWith('\x01')) {
        parsedMessage.action = true;
        parsedMessage.msg = parsedMessage.msg.replace(/^\x01ACTION/, '').replace(/\x01$/, '').trim();
    } else {
        parsedMessage.action = false;
    }

    return parsedMessage;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
