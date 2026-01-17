
// ai-flow-scorer.js
(() => {
    'use strict';

    /****************************
     * CONFIG & LOGGING
     ****************************/
    const SCORE_API = 'https://sableye.serviceslab.click/score';
    const STORAGE_KEY = 'aiFlowScorerEnabled';
    const LOG_PREFIX = '🤖 AI-FlowScorer:';
    const log  = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const err  = (...args) => console.error(LOG_PREFIX, ...args);

    // Retries/backoff (in ms)
    const MAX_ATTEMPTS   = 3;
    const BASE_DELAY     = 600;
    const JITTER         = 250;
    const MAX_CONCURRENT = 3;

    // Badge Colors (medium‑soft palette)
    const COLOR_BAD   = '#e67c73'; // softened red
    const COLOR_WARN  = '#ffd65c'; // medium-soft amber
    const COLOR_GOOD  = '#6fcf97'; // fresh green
    const COLOR_ERROR = '#6c757d'; // neutral error/unknown

    /****************************
     * PAGE GUARD
     ****************************/
    function isIlluminationPlus() {
        return (location.hash || '').toLowerCase().includes('illuminationplus');
    }
    if (!isIlluminationPlus()) {
        log('Not an illuminationplus page, exiting.');
        return;
    }
    log('🔥 AI Flow Scorer loaded on:', location.href);

    /****************************
     * WAIT HELPERS
     ****************************/
    function waitForBody(cb) {
        if (document.body) return cb();
        setTimeout(() => waitForBody(cb), 100);
    }

    function waitForGrid(cb) {
        const grid = document.querySelector('[data-tid="comp-grid"]');
        if (grid) return cb(grid);
        setTimeout(() => waitForGrid(cb), 1000);
    }

    /****************************
     * UTILS
     ****************************/
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

    function getPillsFrom(row, selector) {
        return Array.from(row.querySelectorAll(selector))
            .map(e => normalize(e.querySelector('[data-tid="elem-text"]')?.textContent ?? e.textContent))
            .filter(Boolean);
    }

    function getCloudWorkloadsFrom(row, selector) {
        return Array.from(row.querySelectorAll(selector))
            .map(e => {
                const title = normalize(e.querySelector('[data-tid="cloud-header-title"]')?.textContent);
                const subtitle = normalize(e.querySelector('[data-tid="cloud-header-subtitle"]')?.textContent);
                if (!title) return null;
                return subtitle ? `${title} (${subtitle})` : title;
            })
            .filter(Boolean);
    }

    /****************************
     * DECISION CELL RESOLVER
     ****************************/
    function getDecisionCell(row) {
        const selectors = [
            '[data-tid="comp-grid-column-reportedpolicy-policydecision"]', // Reported
            '[data-tid="comp-grid-column-policy-policydecision"]',         // Draft
            '[data-tid*="reportedpolicy-policydecision"]',
            '[data-tid*="policy-policydecision"]',
            '[data-tid*="policydecision"]'
        ];
        for (const sel of selectors) {
            const cell = row.querySelector(sel);
            if (cell) return cell;
        }
        return null;
    }

    /****************************
     * DATA EXTRACTION
     ****************************/
    function extractFlowData(row) {
        try {
            const id = row.getAttribute('data-handler-id') || '';
            const g  = (sel) => normalize(row.querySelector(sel)?.textContent || '');

            const sourceIPs = [
                ...getPillsFrom(row, '[data-tid*="source"] [data-tid*="allowlist"]'),
                ...getCloudWorkloadsFrom(row, '[data-tid*="source"] [data-tid="cloud-header"]'),
                ...getPillsFrom(row, '[data-tid*="source"] [data-tid*="workload"]')
            ];

            const targetIPs = [
                ...getPillsFrom(row, '[data-tid*="target"] [data-tid*="allowlist"]'),
                ...getCloudWorkloadsFrom(row, '[data-tid*="target"] [data-tid="cloud-header"]'),
                ...getPillsFrom(row, '[data-tid*="target"] [data-tid*="workload"]'),
                ...getPillsFrom(row, '[data-tid*="target"] [data-tid*="unmanaged"]')
            ];

            const payload = {
                id,
                // Source
                sourceIPs,
                sourceLabels:  getPillsFrom(row, '[data-tid*="sourcelabels"] a'),
                sourceProcess: g('[data-tid*="sourceprocess"]'),
                sourceUser:    g('[data-tid*="sourceuser"]'),
                // Target
                targetIPs,
                targetLabels:  getPillsFrom(row, '[data-tid*="targetlabels"] a'),
                targetProcess: g('[data-tid*="targetprocess"]'),
                targetUser:    g('[data-tid*="targetuser"]'),
                targetFQDN:    g('[data-tid*="targetfqdn"]'),
                // Service/Port (substring selector for robustness)
                services:     getPillsFrom(row, '[data-tid*="comp-pill-service"]'),
                portProtocol: g('[data-tid*="portprotocol"]'),
                // Flow metadata
                flows:         g('[data-tid*="flowsandbytes"]'),
                connections:   g('[data-tid*="connections"]'),
                firstDetected: g('[data-tid*="firstdetected"]'),
                lastDetected:  g('[data-tid*="lastdetected"]')
            };

            log('📦 Payload for row', id, payload);
            return payload;
        } catch (e) {
            err('❌ Extract failed', e);
            return null;
        }
    }

    /****************************
     * RENDERING
     ****************************/
    function renderBadge(row, text, bg, title) {
        const cell = getDecisionCell(row);
        if (!cell) return false;

        cell.querySelector('.score-badge')?.remove();

        const badge = document.createElement('div');
        badge.className = 'score-badge';
        badge.style.cssText = `
            display:inline-block;
            margin-left:6px;
            padding:2px 6px;
            border-radius:4px;
            font-weight:bold;
            font-size:12px;
            color:#fff;
            background:${bg};
        `;
        badge.textContent = text;
        if (title) badge.title = title;

        cell.appendChild(badge);
        return true;
    }

    function renderScore(row, score, reason) {
        const n = Number(score);
        let bg = COLOR_BAD, emoji = '❗';
        if (n >= 60) { bg = COLOR_GOOD; emoji = '✅'; }
        else if (n >= 30) { bg = COLOR_WARN; emoji = '⚠️'; }
        return renderBadge(row, `${emoji} ${n}`, bg, reason || '');
    }

    function renderError(row, reason) {
        return renderBadge(row, '⚠️ ERR', COLOR_ERROR, reason || 'Scoring failed');
    }

    function tryRenderStashed(row) {
        if (!row?.dataset) return;
        const { scoreValue, scoreReason } = row.dataset;
        if (scoreValue && row.dataset.scored !== '1') {
            const ok = renderScore(row, Number(scoreValue), scoreReason);
            if (ok) {
                row.dataset.scored = '1';
                delete row.dataset.scoreValue;
                delete row.dataset.scoreReason;
            }
        }
    }

    /****************************
     * NETWORK HELPERS
     ****************************/
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    function backoffDelay(attempt) {
        const exp   = Math.min(5, attempt);
        const base  = BASE_DELAY * Math.pow(2, exp);
        const jitter = Math.floor(Math.random() * JITTER);
        return base + jitter;
    }

    async function postWithTimeout(url, payload, timeoutMs = 8000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: ctrl.signal
            });
            clearTimeout(t);
            const json = await res.json().catch(() => ({}));
            return { ok: res.ok, status: res.status, data: json };
        } catch (e) {
            clearTimeout(t);
            return { ok: false, status: 0, data: null, error: e?.message || String(e) };
        }
    }

    async function sendScoreRequest(payload, attempt) {
        const canMessage = typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;

        const sendViaRuntime = () => new Promise(resolve => {
            try {
                chrome.runtime.sendMessage({ type: 'score', payload }, res => {
                    const lastErr = chrome.runtime?.lastError?.message;
                    if (lastErr) return resolve({ ok: false, data: null, error: lastErr });
                    if (!res)     return resolve({ ok: false, data: null, error: 'No response' });
                    resolve(res);
                });
            } catch (e) {
                resolve({ ok: false, data: null, error: e?.message || String(e) });
            }
        });

        const sendViaFetch = () => postWithTimeout(SCORE_API, payload, 9000);

        if (canMessage) {
            const res = await sendViaRuntime();
            if (res?.ok && res?.data) return res;
            warn(`Runtime messaging failed (attempt ${attempt + 1}):`, res?.error || res);
        }

        const res = await sendViaFetch();
        if (!res.ok) {
            return { ok: false, data: null, error: res.error || `HTTP ${res.status}` };
        }

        // Normalize to { ok, data } if backend returns raw { score, reason }
        const normalized = (res.data && typeof res.data === 'object')
            ? (res.data.ok !== undefined ? res.data : { ok: true, data: res.data })
            : { ok: false, data: null, error: 'Invalid JSON' };

        return normalized;
    }

    /****************************
     * SCORING QUEUE
     ****************************/
    const SCORE_QUEUE = [];
    let scoringActive = 0;

    function scoreRow(row) {
        if (row.dataset.scored === '1' || row.dataset.scoring === '1') return;
        const data = extractFlowData(row);
        if (!data) return;
        row.dataset.scoring = '1';
        SCORE_QUEUE.push({ row, data, attempts: 0 });
        runQueue();
    }

    function runQueue() {
        if (scoringActive >= MAX_CONCURRENT) return;
        if (!SCORE_QUEUE.length) return;

        const item = SCORE_QUEUE.shift();
        scoringActive++;
        handleQueueItem(item).finally(() => {
            scoringActive--;
            runQueue();
        });
    }

    async function handleQueueItem(item) {
        const { row, data } = item;
        for (let attempt = item.attempts; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                log(`📤 Sending row ${data.id} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
                const res = await sendScoreRequest(data, attempt);
                log(`📥 Response for row ${data.id}:`, res);

                if (res?.ok && res?.data) {
                    const ok = renderScore(row, Number(res.data.score), res.data.reason);
                    if (ok) {
                        row.dataset.scored = '1';
                    } else {
                        // Stash result; re-attempt injection on subsequent mutations
                        row.dataset.scoreValue  = String(res.data.score ?? '');
                        row.dataset.scoreReason = res.data.reason ?? '';
                        row.dataset.scored      = '0';
                    }
                    row.dataset.scoring = '0';
                    return;
                }

                const waitMs = backoffDelay(attempt);
                warn(`Scoring failed for row ${data.id}, backing off ${waitMs}ms:`, res?.error || res);
                await delay(waitMs);
            } catch (e) {
                const waitMs = backoffDelay(attempt);
                warn(`Exception scoring row ${data.id}, backing off ${waitMs}ms:`, e);
                await delay(waitMs);
            }
        }

        // Terminal failure
        renderError(row, 'Scoring failed after retries');
        row.dataset.scored = '1';
        row.dataset.scoring = '0';
    }

    /****************************
     * START SCORING
     ****************************/
    function startScoring() {
        waitForGrid(grid => {
            grid.querySelectorAll('div[data-tid="comp-grid-row"]').forEach(r => {
                scoreRow(r);
                tryRenderStashed(r);
            });

            new MutationObserver(mutations => {
                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        if (n?.nodeType === 1 && n.matches?.('div[data-tid="comp-grid-row"]')) {
                            scoreRow(n);
                            tryRenderStashed(n);
                        } else if (n?.nodeType === 1) {
                            n.querySelectorAll?.('div[data-tid="comp-grid-row"]').forEach(r => {
                                scoreRow(r);
                                tryRenderStashed(r);
                            });
                        }
                    }
                    if (m.target?.closest) {
                        const r = m.target.closest('div[data-tid="comp-grid-row"]');
                        if (r) tryRenderStashed(r);
                    }
                }
            }).observe(grid, { childList: true, subtree: true });
        });
    }

    /****************************
     * UI TOGGLE (Shadow DOM)
     ****************************/
    let started = false;
    let uiInjected = false;

    function createUIElement() {
        const host = document.createElement('div');
        host.id = 'ai-flow-scorer-ui';
        host.setAttribute('aria-live', 'polite');
        host.style.cssText = `
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            z-index: 2147483647 !important;
            pointer-events: auto !important;
        `;

        const shadow = host.attachShadow({ mode: 'open' });

        const wrap = document.createElement('div');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'AI Flow Scorer');
        wrap.style.cssText = `
            background: #ff6600 !important;
            color: #fff !important;
            border-radius: 10px !important;
            padding: 10px 14px !important;
            font-size: 14px !important;
            display: flex !important;
            gap: 8px !important;
            align-items: center !important;
            box-shadow: 0 2px 8px rgba(0,0,0,.3) !important;
        `;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'aiFlowScorerToggle';
        cb.checked = localStorage.getItem(STORAGE_KEY) === 'true';
        cb.title = 'By using this feature, you agree to Gemma Terms: https://ai.google.dev/gemma/terms';
        cb.setAttribute('aria-label', 'Enable AI Flow Scorer');
        cb.style.cssText = `
            cursor: pointer !important;
            width: 16px !important;
            height: 16px !important;
            margin: 0 !important;
        `;

        const label = document.createElement('label');
        label.htmlFor = cb.id;
        label.textContent = 'AI-FlowScorer';
        label.title = 'By using this feature, you agree to Gemma Terms: https://ai.google.dev/gemma/terms';
        label.style.cssText = `
            cursor: pointer !important;
            user-select: none !important;
            margin: 0 !important;
            font-weight: bold !important;
        `;

        wrap.append(cb, label);
        shadow.append(wrap);

        cb.addEventListener('change', () => {
            log('Checkbox changed:', cb.checked);
            localStorage.setItem(STORAGE_KEY, String(cb.checked));
            if (cb.checked && !started) {
                started = true;
                startScoring();
            }
        });

        if (cb.checked && !started) {
            started = true;
            startScoring();
        }

        return host;
    }

    function injectUI() {
        if (uiInjected) return;
        if (!document.body) {
            warn('❌ No body yet to inject UI!');
            return;
        }
        document.getElementById('ai-flow-scorer-ui')?.remove();

        const uiRoot = createUIElement();
        document.body.appendChild(uiRoot);
        uiInjected = true;
        log('🧩 UI injected successfully!');
    }

    function watchUI() {
        const observer = new MutationObserver(() => {
            const exists = document.getElementById('ai-flow-scorer-ui');
            if (!exists && uiInjected) {
                warn('⚠️ UI removed by page, re-injecting...');
                uiInjected = false;
                injectUI();
            }
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: false });
            log('👀 Watching for UI removal');
        }
    }

    /****************************
     * BOOTSTRAP
     ****************************/
    log('Starting bootstrap...');

    if (document.body) {
        injectUI();
        watchUI();
    }

    waitForBody(() => {
        injectUI();
        watchUI();

        // Heartbeat to recover from aggressive DOM resets
        setInterval(() => {
            const exists = document.getElementById('ai-flow-scorer-ui');
            if (!exists) {
                log('🔁 Interval check: UI missing, re-injecting');
                uiInjected = false;
                injectUI();
            }
        }, 2000);
    });
})();
