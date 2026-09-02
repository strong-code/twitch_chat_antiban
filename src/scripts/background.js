browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'fetchJson') {
        fetch(request.url, {
            method: request.method || 'GET',
            headers: request.headers || {},
            body: request.body || null
        })
        .then(response => response.ok ? response.json() : null)
        .then(data => sendResponse(data))
        .catch(error => {
            console.error(`Twitch Anti-Ban: unable to fetch from ${request.url}:`, error);
            sendResponse(null);
        });
        return true;
    }

    if (request.type === 'fetchText') {
        fetch(request.url, {
            method: request.method || 'GET',
            headers: request.headers || {},
            body: request.body || null
        })
        .then(response => response.ok ? response.text() : null)
        .then(data => sendResponse(data))
        .catch(error => {
            console.error('Twitch Anti-Ban: unable to fetch text:', error);
            sendResponse(null);
        });
        return true;
    }

    if (request.type === 'loadKickConfig') {
        fetch(browser.runtime.getURL('config.json'))
            .then(response => response.ok ? response.json() : {})
            .then(data => sendResponse(data))
            .catch(() => sendResponse({}));
        return true;
    }
}); 