/**
 * LingXi — Cloudflare Worker Proxy for DeepSeek API
 *
 * 部署步骤见下方 README，或参考项目说明文档。
 * API Key 存储在 Cloudflare 环境变量 DEEPSEEK_API_KEY 中（更安全），
 * 同时保留一个硬编码备用值（仅供首次测试）。
 */

// ── 允许访问的来源 ──────────────────────────────────────────
// 把 YOUR_GITHUB_USERNAME 替换成你的 GitHub 用户名
const ALLOWED_ORIGINS = [
    'https://YOUR_GITHUB_USERNAME.github.io',   // ← 改成你的 GitHub Pages 地址
    'http://localhost',
    'http://localhost:5500',
    'http://127.0.0.1',
    'http://127.0.0.1:5500',
    'null',   // 本地 file:// 直接打开时的 Origin
];

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// ── CORS 响应头 ──────────────────────────────────────────────
function corsHeaders(origin) {
    const allowed = ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  allowed ? origin : 'null',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age':       '86400',
    };
}

// ── 主处理逻辑 ───────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') ?? 'null';

        // CORS 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin),
            });
        }

        // 只接受 POST
        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        // 来源校验
        if (!ALLOWED_ORIGINS.includes(origin)) {
            return new Response('Forbidden', {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Origin not allowed: ' + origin }),
            });
        }

        // 读取请求体
        let body;
        try {
            body = await request.json();
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
                status: 400,
                headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            });
        }

        // API Key：优先读 Cloudflare 环境变量（更安全），否则用硬编码备用值
        const apiKey = env.DEEPSEEK_API_KEY;

        // 转发请求到 DeepSeek
        let upstream;
        try {
            upstream = await fetch(DEEPSEEK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': 'Bearer ' + apiKey,
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + err.message }), {
                status: 502,
                headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            });
        }

        // 把 DeepSeek 的响应（含流式）原样返回给前端
        const respHeaders = new Headers(corsHeaders(origin));
        const ct = upstream.headers.get('Content-Type');
        if (ct) respHeaders.set('Content-Type', ct);

        return new Response(upstream.body, {
            status:     upstream.status,
            statusText: upstream.statusText,
            headers:    respHeaders,
        });
    },
};
