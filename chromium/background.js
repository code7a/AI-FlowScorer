chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== 'score') return;

    (async () => {
        try {
            const resp = await fetch('https://sableye.serviceslab.click/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(msg.payload)
            });

            const text = await resp.text();

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error('❌ Invalid JSON from API:', text);
                sendResponse({
                    ok: false,
                    error: 'Invalid JSON from scoring service'
                });
                return;
            }

            sendResponse({ ok: true, data });

        } catch (err) {
            console.error('❌ Fetch failed:', err);
            sendResponse({
                ok: false,
                error: err.message || 'Fetch failed'
            });
        }
    })();

    return true;
});
