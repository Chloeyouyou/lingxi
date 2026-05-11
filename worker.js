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
                const { role, content, session_id: sid } = body;
                if (!role || !content) return jsonErr(cors(origin), 400, 'Missing role/content');
                await env.DB.prepare(
                    'INSERT INTO messages (user_id, role, content, ts, session_id) VALUES (?, ?, ?, ?, ?)'
                ).bind(user_id, role, content, Date.now(), sid || null).run();
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
            }

            // POST /db/history
            if (url.pathname === '/db/history') {
                const { session_id: sid } = body;
                let result;
                if (sid) {
                    result = await env.DB.prepare(
                        'SELECT role, content, ts FROM messages WHERE user_id = ? AND session_id = ? ORDER BY ts DESC LIMIT 50'
                    ).bind(user_id, sid).all();
                } else {
                    result = await env.DB.prepare(
                        'SELECT role, content, ts FROM messages WHERE user_id = ? AND session_id IS NULL ORDER BY ts DESC LIMIT 50'
                    ).bind(user_id).all();
                }
                const messages = (result.results || []).reverse();
                return new Response(JSON.stringify({ messages }), { status: 200, headers: h });
            }

            // POST /db/sessions  — list all archived sessions
            if (url.pathname === '/db/sessions') {
                const result = await env.DB.prepare(
                    `SELECT session_id, MIN(ts) as started, MAX(ts) as ended, COUNT(*) as msg_count
                     FROM messages WHERE user_id = ? GROUP BY session_id ORDER BY started DESC LIMIT 30`
                ).bind(user_id).all();
                return new Response(JSON.stringify({ sessions: result.results || [] }), { status: 200, headers: h });
            }

            // POST /db/clear  — delete only current session's messages
            if (url.pathname === '/db/clear') {
                const { session_id: sid } = body;
                if (sid) {
                    await env.DB.prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?').bind(user_id, sid).run();
                } else {
                    await env.DB.prepare('DELETE FROM messages WHERE user_id = ? AND session_id IS NULL').bind(user_id).run();
                }
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

                // ── Wish note routes ─────────────────────────────────
                if (url.pathname.startsWith('/db/wish/note/')) {
                    await ensureWishNotesTable(env.DB);

                    // POST /db/wish/note/save
                    if (url.pathname === '/db/wish/note/save') {
                        const { wish_text, direction, note_text, created_at } = body;
                        if (!note_text) return jsonErr(cors(origin), 400, 'Missing note_text');
                        await env.DB.prepare(
                            'INSERT INTO wish_notes (user_id, wish_text, direction, note_text, created_at) VALUES (?, ?, ?, ?, ?)'
                        ).bind(user_id, wish_text || '', direction || '', note_text, created_at || Date.now()).run();
                        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
                    }

                    // POST /db/wish/note/list
                    if (url.pathname === '/db/wish/note/list') {
                        const result = await env.DB.prepare(
                            'SELECT wish_text, direction, note_text, created_at FROM wish_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
                        ).bind(user_id).all();
                        return new Response(JSON.stringify({ notes: result.results || [] }), { status: 200, headers: h });
                    }
                }

                // ── Profile refresh ───────────────────────────────────
                if (url.pathname === '/db/profile/refresh') {
                    await ensureSummaryTable(env.DB);
                    await ensureWishNotesTable(env.DB);
                    await ensureWishSessionTable(env.DB);
                    const key = env.DEEPSEEK_API_KEY;

                    // 拉最近30条对话消息
                    const msgResult = await env.DB.prepare(
                        'SELECT role, content FROM messages WHERE user_id = ? ORDER BY ts DESC LIMIT 30'
                    ).bind(user_id).all();
                    const recentMsgs = (msgResult.results || []).reverse();

                    // 拉最近10条愿望笔记
                    const noteResult = await env.DB.prepare(
                        'SELECT wish_text, direction, note_text FROM wish_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
                    ).bind(user_id).all();
                    const notes = noteResult.results || [];

                    // 拉最近10条已归档愿望会话
                    const sessionResult = await env.DB.prepare(
                        'SELECT wish_text, direction, depth, steps_done, avoid_types FROM wish_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
                    ).bind(user_id).all();
                    const sessions = sessionResult.results || [];

                    if (recentMsgs.length === 0 && notes.length === 0 && sessions.length === 0)
                        return new Response(JSON.stringify({ ok: true, summary: '' }), { status: 200, headers: h });

                    // 拼成富文本背景
                    let contextBlock = '';

                    if (sessions.length > 0) {
                        contextBlock += '\n\n用户的愿望历史（已完成/归档）：\n' + sessions.map(s => {
                            const avoids = (() => { try { return JSON.parse(s.avoid_types || '[]'); } catch { return []; } })();
                            return `愿望："${s.wish_text}"，方向：${s.direction || '未选'}，类型：${s.depth === 'short' ? '短期' : '长期'}，完成${s.steps_done}步${avoids.length ? '，回避类型：' + avoids.join('、') : ''}`;
                        }).join('\n');
                    }

                    if (notes.length > 0) {
                        contextBlock += '\n\n用户的步骤反馈笔记（行动中的真实感受）：\n' + notes.map(n => `[${n.wish_text}${n.direction ? '·' + n.direction : ''}] ${n.note_text}`).join('\n');
                    }

                    let summaryText = '';
                    try {
                        const up = await fetch('https://api.deepseek.com/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                            body: JSON.stringify({
                                model: 'deepseek-chat', stream: false, max_tokens: 200,
                                messages: [
                                    { role: 'system', content: '根据以下对话记录、愿望历史和行动笔记，提炼该用户的简短画像，包括：常提到的话题、情绪模式、隐含欲望、行动风格、回避倾向。用四到五个短句列出，不超过150字，不加解释。' },
                                    ...recentMsgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
                                    ...(contextBlock ? [{ role: 'user', content: contextBlock }] : []),
                                ],
                            }),
                        });
                        const data = await up.json();
                        summaryText = data?.choices?.[0]?.message?.content?.trim() || '';
                    } catch (e) { return jsonErr(cors(origin), 502, 'Profile refresh failed: ' + e.message); }

                    await env.DB.prepare(
                        'INSERT INTO summaries (user_id, summary_text, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET summary_text=excluded.summary_text, updated_at=excluded.updated_at'
                    ).bind(user_id, summaryText, Date.now()).run();
                    return new Response(JSON.stringify({ ok: true, summary: summaryText }), { status: 200, headers: h });
                }

                // ── Wish session archive routes ───────────────────────
                if (url.pathname.startsWith('/db/wish/session/')) {
                    await ensureWishSessionTable(env.DB);

                    // POST /db/wish/session/save
                    if (url.pathname === '/db/wish/session/save') {
                        const { wish_text, direction, scope_json, depth, depth_label, steps_done, avoid_types, coaching_json, steps_json, created_at, ended_at } = body;
                        if (!wish_text) return jsonErr(cors(origin), 400, 'Missing wish_text');
                        // 兼容旧表：补列
                        try { await env.DB.prepare('ALTER TABLE wish_sessions ADD COLUMN coaching_json TEXT DEFAULT \'[]\'').run(); } catch (_) {}
                        try { await env.DB.prepare('ALTER TABLE wish_sessions ADD COLUMN steps_json TEXT DEFAULT \'[]\'').run(); } catch (_) {}
                        await env.DB.prepare(
                            'INSERT INTO wish_sessions (user_id, wish_text, direction, scope_json, depth, depth_label, steps_done, avoid_types, coaching_json, steps_json, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                        ).bind(user_id, wish_text, direction || '', scope_json || '{}', depth || '', depth_label || '', steps_done || 0, avoid_types || '[]', coaching_json || '[]', steps_json || '[]', created_at || Date.now(), ended_at || Date.now()).run();
                        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
                    }

                    // POST /db/wish/session/list
                    if (url.pathname === '/db/wish/session/list') {
                        const result = await env.DB.prepare(
                            'SELECT id, wish_text, direction, scope_json, depth, depth_label, steps_done, avoid_types, coaching_json, steps_json, created_at, ended_at FROM wish_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
                        ).bind(user_id).all();
                        return new Response(JSON.stringify({ sessions: result.results || [] }), { status: 200, headers: h });
                    }

                    // POST /db/wish/session/analysis
                    if (url.pathname === '/db/wish/session/analysis') {
                        const { sessions } = body;
                        if (!Array.isArray(sessions) || sessions.length === 0)
                            return jsonErr(cors(origin), 400, 'Missing sessions');
                        const key = env.DEEPSEEK_API_KEY;
                        const summary = sessions.map(s => {
                            const avoids = (() => { try { return JSON.parse(s.avoid_types || '[]'); } catch { return []; } })();
                            return `愿望："${s.wish_text}"，方向：${s.direction || '未选'}，类型：${s.depth || '?'}，完成${s.steps_done}步${avoids.length ? '，回避：' + avoids.join('、') : ''}`;
                        }).join('\n');
                        let analysisText = '';
                        try {
                            const up = await fetch('https://api.deepseek.com/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                                body: JSON.stringify({
                                    model: 'deepseek-chat', stream: false, max_tokens: 300,
                                    messages: [
                                        { role: 'system', content: '根据用户的愿望历史，生成一段简短洞察（150字内）：他/她的愿望集中在哪些主题；倾向于哪种类型的目标；回避了哪些类型的行动；长期 vs 短期目标的偏好。语气轻描淡写，像朋友说话，不要分析腔。' },
                                        { role: 'user', content: summary },
                                    ],
                                }),
                            });
                            const data = await up.json();
                            analysisText = data?.choices?.[0]?.message?.content?.trim() || '';
                        } catch (e) { return jsonErr(cors(origin), 502, 'Analysis fetch failed: ' + e.message); }
                        return new Response(JSON.stringify({ analysis: analysisText }), { status: 200, headers: h });
                    }
                }
            }

            // ── Route: /db/summarize  ────────────────────────────
            // 接收对话片段，合并 wish_notes + wish_sessions 后生成统一画像
            if (url.pathname === '/db/summarize') {
                const { messages } = body;
                if (!Array.isArray(messages) || messages.length === 0)
                    return jsonErr(cors(origin), 400, 'Missing messages');
                await ensureSummaryTable(env.DB);
                await ensureWishNotesTable(env.DB);
                await ensureWishSessionTable(env.DB);
                const key = env.DEEPSEEK_API_KEY;

                // 同时拉取愿望笔记和归档记录补充画像
                const [noteResult, sessionResult] = await Promise.all([
                    env.DB.prepare('SELECT wish_text, direction, note_text FROM wish_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 8').bind(user_id).all(),
                    env.DB.prepare('SELECT wish_text, direction, depth, steps_done, avoid_types FROM wish_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 8').bind(user_id).all(),
                ]);
                const notes = noteResult.results || [];
                const sessions = sessionResult.results || [];

                let contextBlock = '';
                if (sessions.length > 0) {
                    contextBlock += '\n愿望历史：\n' + sessions.map(s => {
                        const av = (() => { try { return JSON.parse(s.avoid_types || '[]'); } catch { return []; } })();
                        return `"${s.wish_text}" 方向:${s.direction||'—'} 类型:${s.depth==='short'?'短期':'长期'} 完成${s.steps_done}步${av.length?` 回避:${av.join('、')}` : ''}`;
                    }).join('\n');
                }
                if (notes.length > 0) {
                    contextBlock += '\n行动笔记：\n' + notes.map(n => `[${n.wish_text}] ${n.note_text}`).join('\n');
                }

                let summaryText = '';
                try {
                    const up = await fetch('https://api.deepseek.com/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                        body: JSON.stringify({
                            model: 'deepseek-chat', stream: false, max_tokens: 200,
                            messages: [
                                { role: 'system', content: '根据以下对话记录、愿望历史和行动笔记，提炼该用户的简短画像：常谈话题、情绪模式、隐含欲望、行动风格、回避倾向。用四到五个短句，不超过120字，不加解释。' },
                                ...messages,
                                ...(contextBlock ? [{ role: 'user', content: contextBlock }] : []),
                            ],
                        }),
                    });
                    const data = await up.json();
                    summaryText = data?.choices?.[0]?.message?.content?.trim() || '';
                } catch (e) { return jsonErr(cors(origin), 502, 'Summarize fetch failed: ' + e.message); }

                await env.DB.prepare(
                    'INSERT INTO summaries (user_id, summary_text, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET summary_text=excluded.summary_text, updated_at=excluded.updated_at'
                ).bind(user_id, summaryText, Date.now()).run();
                return new Response(JSON.stringify({ ok: true, summary: summaryText }), { status: 200, headers: h });
            }

            // ── Route: /db/summary/get  ──────────────────────────
            if (url.pathname === '/db/summary/get') {
                await ensureSummaryTable(env.DB);
                const result = await env.DB.prepare(
                    'SELECT summary_text FROM summaries WHERE user_id = ?'
                ).bind(user_id).first();
                return new Response(JSON.stringify({ summary: result?.summary_text || '' }), { status: 200, headers: h });
            }

            // ── Route: /db/event  ────────────────────────────────
            if (url.pathname === '/db/event') {
                await ensureEventTable(env.DB);
                const { event_type, ts, meta } = body;
                if (!event_type) return jsonErr(cors(origin), 400, 'Missing event_type');
                await env.DB.prepare(
                    'INSERT INTO events (user_id, event_type, ts, meta) VALUES (?, ?, ?, ?)'
                ).bind(user_id, event_type, ts || Date.now(), meta ? JSON.stringify(meta) : null).run();
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
            }
        }

        return new Response('Not Found', { status: 404 });
}

async function ensureSummaryTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS summaries (
            user_id      TEXT PRIMARY KEY,
            summary_text TEXT NOT NULL,
            updated_at   INTEGER NOT NULL
        )`),
    ]);
}

async function ensureEventTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            event_type TEXT    NOT NULL,
            ts         INTEGER NOT NULL,
            meta       TEXT    DEFAULT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_event_user ON events(user_id, ts)`),
    ]);
}

async function ensureWishNotesTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS wish_notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            wish_text  TEXT    DEFAULT '',
            direction  TEXT    DEFAULT '',
            note_text  TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_note_user ON wish_notes(user_id, created_at)`),
    ]);
}

async function ensureWishSessionTable(db) {
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS wish_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT    NOT NULL,
            wish_text   TEXT    NOT NULL,
            direction   TEXT    DEFAULT '',
            scope_json  TEXT    DEFAULT '{}',
            depth       TEXT    DEFAULT '',
            depth_label TEXT    DEFAULT '',
            steps_done  INTEGER DEFAULT 0,
            avoid_types TEXT    DEFAULT '[]',
            coaching_json TEXT  DEFAULT '[]',
            steps_json  TEXT    DEFAULT '[]',
            created_at  INTEGER NOT NULL,
            ended_at    INTEGER
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_session_user ON wish_sessions(user_id, created_at)`),
    ]);
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
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            role       TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            ts         INTEGER NOT NULL,
            session_id TEXT    DEFAULT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_ts ON messages(user_id, ts)`),
    ]);
    // Migration for existing tables: add session_id column if absent
    try { await db.prepare('ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT NULL').run(); } catch (_) {}
}

function jsonErr(corsH, status, msg) {
    return new Response(JSON.stringify({ error: msg }), {
        status, headers: { ...corsH, 'Content-Type': 'application/json' },
    });
}
