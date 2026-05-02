/**
 * LingXi — Cloudflare Worker
 * 代理后端 API，隐藏所有 Key；D1 持久化对话记忆：
 *   POST /chat        → DeepSeek chat completions (流式)
 *   POST /tts         → Coze TTS audio/speech (返回 MP3)
 *   POST /image       → Stability AI SD3.5-large image generations
 *   POST /db/save     → 保存一条消息到 D1
 *   POST /db/history  → 读取最近 50 条消息
 *   POST /db/clear    → 清空该用户全部消息
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
        const url    = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors(origin) });
        }

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
        }

        return new Response('Not Found', { status: 404 });
    },
};

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
