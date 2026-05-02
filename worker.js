/**
 * LingXi — Cloudflare Worker
 * 代理三个后端 API，隐藏所有 Key：
 *   POST /chat   → DeepSeek chat completions (流式)
 *   POST /tts    → Coze TTS audio/speech (返回 MP3)
 *   POST /image  → SiliconFlow image generations
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

        // ── Route: /image  (SiliconFlow) ─────────────────────────
        if (url.pathname === '/image') {
            let body;
            try { body = await request.json(); }
            catch { return jsonErr(cors(origin), 400, 'Invalid JSON'); }

            const key = env.SILICONFLOW_KEY;
            let up;
            try {
                up = await fetch('https://api.siliconflow.cn/v1/images/generations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                    body: JSON.stringify(body),
                });
            } catch (e) { return jsonErr(cors(origin), 502, 'SiliconFlow fetch failed: ' + e.message); }

            const h = new Headers(cors(origin));
            h.set('Content-Type', 'application/json');
            const data = await up.text();
            return new Response(data, { status: up.status, headers: h });
        }

        return new Response('Not Found', { status: 404 });
    },
};

function jsonErr(corsH, status, msg) {
    return new Response(JSON.stringify({ error: msg }), {
        status, headers: { ...corsH, 'Content-Type': 'application/json' },
    });
}
