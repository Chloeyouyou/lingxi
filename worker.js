/**
 * LingXi — Cloudflare Worker
 * 代理后端 API，隐藏所有 Key；D1 持久化对话记忆：
 *   POST /chat        → DeepSeek chat completions (流式)
 *   POST /tts         → Coze TTS audio/speech (返回 MP3)
 *   POST /image       → Stability AI SD3.5-large image generations
 *   POST /jina        → Jina AI URL reader (隐藏 JINA_KEY)
 *   POST /db/save     → 保存一条消息到 D1
 *   POST /db/history  → 读取最近 50 条消息
 *   POST /db/clear    → 清空该用户全部消息
 *
 * Env secrets (set via wrangler secret put):
 *   DEEPSEEK_API_KEY, COZE_TTS_TOKEN, STABILITY_KEY, JINA_KEY
 */

const ALLOWED_ORIGINS = [
    'https://chloeyouyou.github.io',
    'http://localhost',
    'http://localhost:5500',
    'http://127.0.0.1',
    'http://127.0.0.1:5500',
    'null',
];

function cors(origin) {
    const ok = ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : 'null',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age':       '86400',
    };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') ?? 'null';

        // CORS preflight — handled before any routing so it always succeeds
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors(origin) });
        }

        // Wrap everything in a top-level try-catch so uncaught exceptions
        // still return CORS headers (otherwise browser sees a CORS error)
        try {
            return await handleRequest(request, env, origin);
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Internal error: ' + e.message }), {
                status: 500,
                headers: { ...cors(origin), 'Content-Type': 'application/json' },
            });
        }
    },
};

async function handleRequest(request, env, origin) {
        const url    = new URL(request.url);

        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        if (!ALLOWED_ORIGINS.includes(origin)) {
            return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
                status: 403, headers: { ...cors(origin), 'Content-Type': 'application/json' },
            });
        }

        // ── Route: /chat  (DeepSeek) ─────────────────────────────
        if (url.pathname === '/chat' || url.pathname === '/') {
            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }

            const key = env.DEEPSEEK_API_KEY;
            let up;
            try {
                up = await fetch('https://api.deepseek.com/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                    body: JSON.stringify(body),
                });
            } catch (e) { return jsonErr(cors(origin), 502, 'DeepSeek fetch failed: ' + e.message); }

            const h = new Headers(cors(origin));
            const ct = up.headers.get('Content-Type');
            if (ct) h.set('Content-Type', ct);
            return new Response(up.body, { status: up.status, headers: h });
        }

        // ── Route: /tts  (Coze TTS) ──────────────────────────────
        if (url.pathname === '/tts') {
            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }

            const key = env.COZE_TTS_TOKEN;
            if (!key) return jsonErr(cors(origin), 500, 'COZE_TTS_TOKEN secret not set in Worker');
            let up;
            try {
                up = await fetch('https://api.coze.cn/v1/audio/speech', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                    body: JSON.stringify(body),
                });
            } catch (e) { return jsonErr(cors(origin), 502, 'Coze TTS fetch failed: ' + e.message); }

            const h = new Headers(cors(origin));
            // Coze returns audio/mpeg
            const ct = up.headers.get('Content-Type') || 'audio/mpeg';
            h.set('Content-Type', ct);
            return new Response(up.body, { status: up.status, headers: h });
        }

        // ── Route: /jina  (Jina AI URL reader) ──────────────────
        if (url.pathname === '/jina') {
            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }
            const { url: targetUrl } = body;
            if (!targetUrl) return jsonErr(cors(origin), 400, 'Missing url');
            const key = env.JINA_KEY;
            if (!key) return jsonErr(cors(origin), 500, 'JINA_KEY secret not set');
            let up;
            try {
                up = await fetch('https://r.jina.ai/' + targetUrl, {
                    headers: {
                        'Authorization': 'Bearer ' + key,
                        'Accept': 'text/plain',
                        'X-Return-Format': 'text',
                    },
                });
            } catch (e) { return jsonErr(cors(origin), 502, 'Jina fetch failed: ' + e.message); }
            const h = new Headers(cors(origin));
            h.set('Content-Type', 'text/plain; charset=utf-8');
            const text = await up.text();
            return new Response(text.slice(0, 3000), { status: up.status, headers: h });
        }

        // ── Route: /image  (Stability AI SD3.5-large) ────────────
        if (url.pathname === '/image') {
            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }

            const key = env.STABILITY_KEY;
            // Stability AI v2beta uses multipart/form-data
            const form = new FormData();
            form.append('prompt', body.prompt || '');
            form.append('model', 'sd3.5-large');
            form.append('output_format', 'png');
            if (body.negative_prompt) form.append('negative_prompt', body.negative_prompt);

            let up;
            try {
                up = await fetch('https://api.stability.ai/v2beta/stable-image/generate/sd3', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + key,
                        'Accept': 'application/json',
                    },
                    body: form,
                });
            } catch (e) { return jsonErr(cors(origin), 502, 'Stability AI fetch failed: ' + e.message); }

            const h = new Headers(cors(origin));
            h.set('Content-Type', 'application/json');
            const data = await up.text();
            return new Response(data, { status: up.status, headers: h });
        }

        // ── Route: /db/*  (D1 conversation memory) ──────────────
        if (url.pathname.startsWith('/db/')) {
            if (!env.DB) return jsonErr(cors(origin), 503, 'D1 not bound');
            await ensureTable(env.DB);

            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }

            const { user_id } = body;
            if (!user_id) return jsonErr(cors(origin), 400, 'Missing user_id');

            const h = new Headers(cors(origin));
            h.set('Content-Type', 'application/json');

            // POST /db/save
            if (url.pathname === '/db/save') {
                const { role, content } = body;
                if (!role || !content) return jsonErr(cors(origin), 400, 'Missing role/content');
                await env.DB.prepare(
                    'INSERT INTO messages (user_id, role, content, ts) VALUES (?, ?, ?, ?)'
                ).bind(user_id, role, content, Date.now()).run();
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
            }

            // POST /db/history
            if (url.pathname === '/db/history') {
                const result = await env.DB.prepare(
                    'SELECT role, content, ts FROM messages WHERE user_id = ? ORDER BY ts DESC LIMIT 50'
                ).bind(user_id).all();
                const messages = (result.results || []).reverse();
                return new Response(JSON.stringify({ messages }), { status: 200, headers: h });
            }

            // POST /db/clear
            if (url.pathname === '/db/clear') {
                await env.DB.prepare('DELETE FROM messages WHERE user_id = ?').bind(user_id).run();
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
            }

            // ── Wish routes ──────────────────────────────────────────
            if (url.pathname.startsWith('/db/wish/')) {
                await ensureWishTable(env.DB);

                // POST /db/wish/save
                if (url.pathname === '/db/wish/save') {
                    const { wish_text } = body;
                    if (!wish_text) return jsonErr(cors(origin), 400, 'Missing wish_text');
                    await env.DB.prepare(
                        'INSERT INTO wishes (user_id, wish_text, lit, created_at) VALUES (?, ?, 0, ?)'
                    ).bind(user_id, wish_text, Date.now()).run();
                    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
                }

                // POST /db/wish/list
                if (url.pathname === '/db/wish/list') {
                    const result = await env.DB.prepare(
                        'SELECT id, wish_text, lit, created_at FROM wishes WHERE user_id = ? ORDER BY created_at DESC'
                    ).bind(user_id).all();
                    return new Response(JSON.stringify({ wishes: result.results || [] }), { status: 200, headers: h });
                }

                // POST /db/wish/toggle
                if (url.pathname === '/db/wish/toggle') {
                    const { wish_id } = body;
                    if (!wish_id) return jsonErr(cors(origin), 400, 'Missing wish_id');
                    await env.DB.prepare(
                        'UPDATE wishes SET lit = CASE WHEN lit=0 THEN 1 ELSE 0 END WHERE id=? AND user_id=?'
                    ).bind(wish_id, user_id).run();
                    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
                }
            }
        }

        return new Response('Not Found', { status: 404 });
}

async function ensureWishTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS wishes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            wish_text  TEXT    NOT NULL,
            lit        INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_wish_user ON wishes(user_id)`),
    ]);
}

async function ensureTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS messages (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT    NOT NULL,
            role    TEXT    NOT NULL,
            content TEXT    NOT NULL,
            ts      INTEGER NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_ts ON messages(user_id, ts)`),
    ]);
}

function jsonErr(corsH, status, msg) {
    return new Response(JSON.stringify({ error: msg }), {
        status, headers: { ...corsH, 'Content-Type': 'application/json' },
    });
}
