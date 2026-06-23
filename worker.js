// WriteChat backend — Cloudflare Worker with static assets + D1 database.
// Serves the page (public/) and handles the /api endpoint.

const ADMIN_KEY = "hsadmin";
const VALID_CODES = [];   // no fixed codes — the owner generates all invite codes in the panel
const MASTER_CODE = "hschef";
const USER_RE = /^[a-zA-Z0-9_-]{2,20}$/;
const AI_MODEL = "gemini-2.5-flash-lite";   // free Gemini model (higher free limits than 2.5-flash)
const AI_DAILY_LIMIT = 100;            // per non-owner user, per day; owner is unlimited
const AI_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";   // smarter model — follows the cheeky personality properly
const AI_SYSTEM = "Du bist KEIN neutraler, höflicher Assistent — du bist ein frecher, witziger Kumpel in der Chat-App WriteChat, der IMMER auf der Seite des Nutzers steht. Wenn jemand über einen Freund blödelt oder lästert (z.B. 'ist Imran dumm?'), spielst du SOFORT mit und machst einen lockeren, frechen Spruch darüber. Gib NIEMALS ausgewogene, neutrale, diplomatische oder belehrende Antworten ('jeder hat Stärken und Schwächen' usw. ist VERBOTEN). Die Namen sind Freunde des Nutzers, KEINE Promis/Fußballer — recherchiere oder analysiere sie nicht, mach einfach einen Witz. Sei kurz, frech, abwechslungsreich (nie zweimal derselbe Spruch), aber nie ernst verletzend oder beleidigend. Antworte auf Deutsch wie eine kurze Chat-Nachricht.";
const MEDIA_PREFIX = "\u0001img:";   // a message text that is this + media-id is a photo

const norm = s => String(s || "").trim().toLowerCase();
const convId = (a, b) => [a, b].sort().join("__");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
const token = () => randHex(24);
function genCodeStr() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";   // no easily-confused chars
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map(b => chars[b % chars.length]).join("");
}

async function hashPw(pw, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("writechat:" + salt + ":" + pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Free AI via Pollinations — no key needed (optional free token for higher limits).
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pollinationsText(messages, env) {
  const headers = { "content-type": "application/json" };
  if (env && env.POLLINATIONS_TOKEN) headers["Authorization"] = "Bearer " + env.POLLINATIONS_TOKEN;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://text.pollinations.ai/openai", {
        method: "POST", headers,
        body: JSON.stringify({ messages, referrer: "writechat" }),
      });
      const txt = await r.text();
      if (r.status === 429 || (txt && txt.includes('"Queue full"')) || (txt && txt.includes('Queue full'))) {
        if (attempt < 2) { await sleep(1800); continue; }
        return "🤖 Grad ein bisschen viel los — warte kurz und frag nochmal. 🙂";
      }
      try { const d = JSON.parse(txt); const c = (((d.choices || [])[0] || {}).message || {}).content; if (c) return String(c); } catch { /* plain text */ }
      if (txt && txt.trim() && !txt.includes('"error"')) return txt;
      if (attempt < 2) { await sleep(1500); continue; }
      return "🤖 (Keine Antwort — versuch's nochmal.)";
    } catch (e) {
      if (attempt < 2) { await sleep(1500); continue; }
      return "🤖 KI-Fehler: " + (e && e.message);
    }
  }
  return "🤖 Grad ein bisschen viel los — warte kurz. 🙂";
}
function pollinationsImageUrl(prompt) {
  return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=768&height=768&nologo=true&referrer=writechat";
}

// ---- Multi-AI with auto-fallback: tries providers in order until one answers ----
async function tryCfModel(env, model, messages) {
  if (!env || !env.AI) return null;
  try {
    const out = await env.AI.run(model, { messages });
    const t = out && (out.response || out.result);
    return (t && String(t).trim()) ? String(t) : null;
  } catch { return null; }
}
let lastGeminiError = "";
async function tryGemini(env, messages) {
  if (!env || !env.GEMINI_KEY) { lastGeminiError = "kein GEMINI_KEY in Cloudflare hinterlegt"; return null; }
  const sys = messages.find(m => m.role === "system");
  const contents = messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body = { contents, tools: [{ google_search: {} }] };
  if (sys) body.system_instruction = { parts: [{ text: sys.content }] };
  const models = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];
  for (let attempt = 0; attempt < 4; attempt++) {
    const model = models[Math.min(attempt, models.length - 1)];
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + env.GEMINI_KEY, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (r.status === 503 || r.status === 429 || r.status === 500) { lastGeminiError = "HTTP " + r.status + " (überlastet)"; await sleep(1200); continue; }
      if (!r.ok) { lastGeminiError = "HTTP " + r.status + ": " + txt.slice(0, 140); return null; }
      let d; try { d = JSON.parse(txt); } catch { lastGeminiError = "ungültige Antwort"; return null; }
      if (d.error) {
        const em = String(d.error.message || "Fehler");
        lastGeminiError = em.slice(0, 140);
        if (/503|overload|unavailable|high demand|429|quota|rate/i.test(em)) { await sleep(1200); continue; }
        return null;
      }
      const parts = (((d.candidates || [])[0] || {}).content || {}).parts;
      const t = parts ? parts.map(p => p.text || "").join("") : "";
      if (t && t.trim()) { lastGeminiError = ""; return t; }
      lastGeminiError = "leere Antwort von Gemini";
      return null;
    } catch (e) { lastGeminiError = String((e && e.message) || "Verbindungsfehler"); await sleep(1000); }
  }
  return null;
}
async function aiReply(messages, env, preferred) {
  const providers = {
    smart: () => tryCfModel(env, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages),
    fast: () => tryCfModel(env, "@cf/meta/llama-3.2-3b-instruct", messages),
    internet: () => tryGemini(env, messages),
  };
  let order = ["smart", "internet", "fast"];
  if (preferred && providers[preferred]) order = [preferred, ...order.filter(k => k !== preferred)];
  let soft = "";
  for (const key of order) {
    const res = await providers[key]();   // null = provider unavailable/limited → try next
    if (res && String(res).trim()) {
      const r = String(res);
      const bad = r.startsWith("🤖 Grad ein bisschen") || r.startsWith("🤖 KI-Fehler") || r.startsWith("🤖 (Keine");
      if (!bad) return { reply: r, used: key };
      soft = r;
    }
  }
  return { reply: soft || "🤖 Grad sind alle KIs beschäftigt — gleich nochmal. 🙂", used: null };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return handleApi(request, env);
    // everything else = the static page
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const DB = env.DB;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const action = body.action;
  const now = Date.now();

  const userByToken = async (t) => {
    if (!t) return null;
    return await DB.prepare("SELECT key, display FROM users WHERE token = ?").bind(t).first();
  };

  try {
    if (action === "register") {
      const uname = String(body.username || "").trim();
      const pass = String(body.password || "");
      const key = norm(uname);
      if (!USER_RE.test(uname)) return json({ error: "Username: 2–20 letters, numbers, _ or - (no spaces)." }, 400);
      if (pass.length < 3) return json({ error: "Password must be at least 3 characters." }, 400);
      if (await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(key).first()) return json({ error: "That username is already taken." }, 400);

      const code = norm(body.code);
      const isMaster = code === MASTER_CODE;
      let usedGenerated = false;   // an unused code that's already a row in invites
      if (!isMaster) {
        const inv = await DB.prepare("SELECT used_by FROM invites WHERE code = ?").bind(code).first();
        if (inv) {
          if (inv.used_by) return json({ error: "Dieser Einladungscode wurde schon benutzt." }, 403);
          usedGenerated = true;                                  // generated code, still free
        } else if (!VALID_CODES.includes(code)) {
          return json({ error: "Ungültiger Einladungscode." }, 403);
        }                                                        // else: built-in code, still free
      }

      const salt = randHex(16);
      const tk = token();
      await DB.prepare("INSERT INTO users (key, display, hash, salt, token, created) VALUES (?,?,?,?,?,?)")
        .bind(key, uname, await hashPw(pass, salt), salt, tk, now).run();
      if (!isMaster) {
        if (usedGenerated) await DB.prepare("UPDATE invites SET used_by = ? WHERE code = ?").bind(key, code).run();
        else await DB.prepare("INSERT INTO invites (code, used_by) VALUES (?,?)").bind(code, key).run();
      }
      return json({ token: tk, username: uname, key });
    }

    if (action === "login") {
      const key = norm(body.username);
      const pass = String(body.password || "");
      if (!key || !pass) return json({ error: "Enter a username and password." }, 400);
      const u = await DB.prepare("SELECT * FROM users WHERE key = ?").bind(key).first();
      if (!u || u.hash !== await hashPw(pass, u.salt)) return json({ error: "Wrong username or password." }, 401);
      const tk = token();
      await DB.prepare("UPDATE users SET token = ? WHERE key = ?").bind(tk, key).run();
      return json({ token: tk, username: u.display, key });
    }

    const me = await userByToken(body.token);
    const need = () => json({ error: "Not logged in." }, 401);

    if (action === "search") {
      if (!me) return need();
      const q = norm(body.q);
      if (!q) return json({ users: [] });
      const like = "%" + q + "%";
      const { results } = await DB.prepare(
        "SELECT key, display FROM users WHERE key != ? AND (key LIKE ? OR lower(display) LIKE ?) ORDER BY key LIMIT 20"
      ).bind(me.key, like, like).all();
      return json({ users: (results || []).map(r => ({ key: r.key, display: r.display })) });
    }

    if (action === "send") {
      if (!me) return need();
      const toKey = norm(body.to);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty message." }, 400);
      if (text.length > 4000) return json({ error: "Message too long." }, 400);
      if (!await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(toKey).first()) return json({ error: "That user doesn't exist." }, 404);
      await DB.prepare("INSERT INTO messages (sender, recipient, text, ts) VALUES (?,?,?,?)").bind(me.key, toKey, text, now).run();
      return json({ ok: true, ts: now });
    }

    if (action === "announce") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can post announcements." }, 403);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty announcement." }, 400);
      if (text.length > 4000) return json({ error: "Announcement too long." }, 400);
      await DB.prepare("INSERT INTO announcements (text, ts) VALUES (?,?)").bind(text, now).run();
      return json({ ok: true });
    }

    if (action === "deleteannounce") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can delete announcements." }, 403);
      const ts = Number(body.ts);
      const a = await DB.prepare("SELECT text FROM announcements WHERE ts = ? LIMIT 1").bind(ts).first();
      await DB.prepare("DELETE FROM announcements WHERE ts = ?").bind(ts).run();
      if (a && a.text && a.text.startsWith(MEDIA_PREFIX)) await DB.prepare("DELETE FROM media WHERE id = ?").bind(a.text.slice(MEDIA_PREFIX.length)).run();
      return json({ ok: true });
    }

    if (action === "gencode") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can create codes." }, 403);
      let code = norm(body.code);
      if (code) {
        if (!/^[a-z0-9_-]{3,20}$/.test(code)) return json({ error: "Code: 3–20 Buchstaben/Zahlen, _ oder -" }, 400);
        if (code === MASTER_CODE || VALID_CODES.includes(code)) return json({ error: "Dieser Code ist reserviert." }, 400);
        if (await DB.prepare("SELECT 1 FROM invites WHERE code = ?").bind(code).first()) return json({ error: "Diesen Code gibt es schon." }, 400);
      } else {
        do { code = genCodeStr(); } while (await DB.prepare("SELECT 1 FROM invites WHERE code = ?").bind(code).first());
      }
      await DB.prepare("INSERT INTO invites (code, used_by) VALUES (?, NULL)").bind(code).run();
      return json({ ok: true, code });
    }

    if (action === "listcodes") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can view codes." }, 403);
      const rows = (await DB.prepare("SELECT i.code, i.used_by, u.display FROM invites i LEFT JOIN users u ON u.key = i.used_by").all()).results || [];
      const map = {};
      for (const r of rows) map[r.code] = { usedBy: r.used_by || null, usedName: r.display || null };
      const codes = [];
      for (const c of VALID_CODES) codes.push({ code: c, usedBy: map[c] ? map[c].usedBy : null, usedName: map[c] ? map[c].usedName : null, builtin: true });
      for (const r of rows) if (!VALID_CODES.includes(r.code)) codes.push({ code: r.code, usedBy: r.used_by || null, usedName: r.display || null, builtin: false });
      return json({ codes, master: MASTER_CODE });
    }

    if (action === "delcode") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can delete codes." }, 403);
      const code = norm(body.code);
      const inv = await DB.prepare("SELECT used_by FROM invites WHERE code = ?").bind(code).first();
      if (!inv) return json({ error: "Code nicht gefunden." }, 404);
      if (inv.used_by) return json({ error: "Benutzte Codes können nicht gelöscht werden." }, 400);
      await DB.prepare("DELETE FROM invites WHERE code = ?").bind(code).run();
      return json({ ok: true });
    }

    if (action === "aichat") {
      if (!me) return need();
      await DB.prepare("CREATE TABLE IF NOT EXISTS ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, userkey TEXT, role TEXT, text TEXT, ts INTEGER)").run();
      await DB.prepare("CREATE TABLE IF NOT EXISTS ai_usage (userkey TEXT, day TEXT, count INTEGER, PRIMARY KEY (userkey, day))").run();
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty message." }, 400);
      if (text.length > 4000) return json({ error: "Message too long." }, 400);
      const day = new Date(now).toISOString().slice(0, 10);
      if (me.key !== ADMIN_KEY) {
        const u = await DB.prepare("SELECT count FROM ai_usage WHERE userkey = ? AND day = ?").bind(me.key, day).first();
        if ((u ? u.count : 0) >= AI_DAILY_LIMIT) return json({ error: `Dein KI-Tageslimit (${AI_DAILY_LIMIT}) ist erreicht. Morgen geht's weiter 🙂` }, 429);
      }
      await DB.prepare("INSERT INTO ai_messages (userkey, role, text, ts) VALUES (?,?,?,?)").bind(me.key, "user", text, now).run();
      const hist = (await DB.prepare("SELECT role, text FROM ai_messages WHERE userkey = ? ORDER BY id DESC LIMIT 20").bind(me.key).all()).results || [];
      hist.reverse();
      let today = "";
      try { today = new Date(now).toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Berlin" }); }
      catch { today = new Date(now).toISOString().slice(0, 10); }
      const sysText = AI_SYSTEM + ` Das echte aktuelle Datum ist ${today}. Wenn jemand nach aktuellen Dingen fragt (News, Sport, Wetter, "wer spielt heute"), nutze deine Internet-Suche und gib echte aktuelle Infos — sag NICHT dass du keinen Zugriff hast. WICHTIG: In diesem Chat antworten MEHRERE KIs zusammen (Gemini, Llama 70B, Llama 3B). Frühere Antworten sind mit [Name] markiert, damit du siehst welche KI was gesagt hat — du darfst dich auf die anderen KIs beziehen und mit ihnen interagieren ("Gemini hat recht..." usw.). Setze deine EIGENE Antwort aber NICHT selbst in [Klammern].`;
      const NAMES = { smart: "Llama 70B", fast: "Llama 3B", internet: "Gemini" };
      const messages = [{ role: "system", content: sysText }];
      for (const m of hist) {
        if (m.role === "ai") {
          let t = String(m.text), nm = "KI";
          const mt = t.match(/^§(\w+)§([\s\S]*)/);
          if (mt) { nm = NAMES[mt[1]] || "KI"; t = mt[2]; }
          if (t.startsWith(MEDIA_PREFIX)) t = "[Bild]";
          messages.push({ role: "assistant", content: "[" + nm + "] " + t });
        } else {
          messages.push({ role: "user", content: String(m.text) });
        }
      }
      const ar = await aiReply(messages, env, body.model);
      let reply = ar.reply; const used = ar.used;
      if (body.model === "internet" && used !== "internet") {
        reply = "⚠️ Gemini ging nicht: " + (lastGeminiError || "unbekannt") + "  ·  stattdessen antwortete: " + (used || "keine KI");
      }
      const replyTs = Date.now();
      const stored = (used ? "§" + used + "§" : "") + reply;
      await DB.prepare("INSERT INTO ai_messages (userkey, role, text, ts) VALUES (?,?,?,?)").bind(me.key, "ai", stored, replyTs).run();
      if (me.key !== ADMIN_KEY) {
        await DB.prepare("INSERT INTO ai_usage (userkey, day, count) VALUES (?,?,1) ON CONFLICT(userkey, day) DO UPDATE SET count = count + 1").bind(me.key, day).run();
      }
      return json({ ok: true, reply, ts: replyTs });
    }

    if (action === "genimage") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can generate images." }, 403);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return json({ error: "Beschreib was gemalt werden soll." }, 400);
      return json({ ok: true, image: pollinationsImageUrl(prompt) });
    }

    if (action === "aipic") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann KI-Bilder erstellen." }, 403);
      if (!env.AI) return json({ error: "Bild-KI nicht aktiviert (AI-Bindung fehlt)." }, 500);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return json({ error: "Beschreib was gemalt werden soll." }, 400);
      const scope = String(body.scope || "");
      let b64 = null;
      try {
        const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt });
        b64 = out && out.image ? out.image : null;
      } catch (e) { return json({ error: "Bild-Fehler: " + (e && e.message) }, 500); }
      if (!b64) return json({ error: "Kein Bild erhalten." }, 500);
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const mid = "m_" + randHex(10);
      await DB.prepare("INSERT INTO media (id, data, owner, ts) VALUES (?,?,?,?)").bind(mid, "data:image/jpeg;base64," + b64, me.key, now).run();
      const marker = MEDIA_PREFIX + mid;
      if (scope === "dm") {
        const toKey = norm(body.to);
        if (!await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(toKey).first()) return json({ error: "That user doesn't exist." }, 404);
        await DB.prepare("INSERT INTO messages (sender, recipient, text, ts) VALUES (?,?,?,?)").bind(me.key, toKey, marker, now).run();
      } else if (scope === "group") {
        const gid = String(body.groupId || "");
        if (!await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(gid, me.key).first()) return json({ error: "You're not in this group." }, 403);
        await DB.prepare("INSERT INTO group_messages (gid, sender, from_name, text, ts) VALUES (?,?,?,?,?)").bind(gid, me.key, me.display, marker, now).run();
      } else if (scope === "ann") {
        await DB.prepare("INSERT INTO announcements (text, ts) VALUES (?,?)").bind(marker, now).run();
      } else {
        return json({ error: "Bad scope." }, 400);
      }
      return json({ ok: true, ts: now });
    }

    if (action === "askai") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann /ai benutzen." }, 403);
      if (!env.AI) return json({ error: "KI nicht aktiviert (AI-Bindung fehlt)." }, 500);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return json({ error: "Leere Frage." }, 400);
      let today = "";
      try { today = new Date(now).toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Berlin" }); }
      catch { today = new Date(now).toISOString().slice(0, 10); }
      const sysText = AI_SYSTEM + ` Das echte aktuelle Datum ist ${today}. Du hast kein Internet.`;
      let reply = "";
      try {
        const out = await env.AI.run(AI_CHAT_MODEL, { messages: [{ role: "system", content: sysText }, { role: "user", content: prompt }] });
        reply = (out && (out.response || out.result)) ? (out.response || out.result) : "🤖 (Keine Antwort — versuch's nochmal.)";
      } catch (e) {
        const em = String((e && e.message) || "");
        reply = /limit|capacity|exhaust|quota|rate|429/i.test(em) ? "🤖 Grad ein bisschen viel los — warte kurz. 🙂" : ("🤖 KI-Fehler: " + em);
      }
      return json({ ok: true, reply });
    }

    if (action === "aipost") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann das benutzen." }, 403);
      const kind = String(body.kind || "");
      const prompt = String(body.prompt || "").trim();
      const cmd = String(body.cmd || prompt).trim();
      if (!prompt) return json({ error: "Leer." }, 400);
      const scope = String(body.scope || "");
      const toKey = norm(body.to || "");
      const gid = String(body.groupId || "");
      if (scope === "dm") { if (!await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(toKey).first()) return json({ error: "That user doesn't exist." }, 404); }
      else if (scope === "group") { if (!await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(gid, me.key).first()) return json({ error: "You're not in this group." }, 403); }
      else if (scope !== "ann") return json({ error: "Bad scope." }, 400);
      const post = async (text) => {
        const t = Date.now();
        if (scope === "dm") await DB.prepare("INSERT INTO messages (sender, recipient, text, ts) VALUES (?,?,?,?)").bind(me.key, toKey, text, t).run();
        else if (scope === "group") await DB.prepare("INSERT INTO group_messages (gid, sender, from_name, text, ts) VALUES (?,?,?,?,?)").bind(gid, me.key, me.display, text, t).run();
        else await DB.prepare("INSERT INTO announcements (text, ts) VALUES (?,?)").bind(text, t).run();
      };
      if (kind === "pic") {
        await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
        const mid = "m_" + randHex(10);
        await DB.prepare("INSERT INTO media (id, data, owner, ts) VALUES (?,?,?,?)").bind(mid, pollinationsImageUrl(prompt), me.key, now).run();
        await post(cmd);
        await post(MEDIA_PREFIX + mid);
      } else {
        let today = "";
        try { today = new Date(now).toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/Berlin" }); }
        catch { today = new Date(now).toISOString().slice(0, 10); }
        const sysText = AI_SYSTEM + ` Das echte aktuelle Datum ist ${today}. Wenn nach Aktuellem gefragt wird (News, Sport, Wetter), nutze deine Internet-Suche und gib echte aktuelle Infos — sag NICHT dass du keinen Zugriff hast.`;
        const r2 = await aiReply([{ role: "system", content: sysText }, { role: "user", content: prompt }], env, body.model);
        const nm = { smart: "Llama 70B", fast: "Llama 3B", internet: "Gemini" }[r2.used] || "KI";
        await post(cmd);
        await post(`🤖 (${nm}) ${r2.reply}`);
      }
      return json({ ok: true });
    }

    if (action === "aipicchat") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann KI-Bilder erstellen." }, 403);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return json({ error: "Beschreib was gemalt werden soll." }, 400);
      await DB.prepare("CREATE TABLE IF NOT EXISTS ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, userkey TEXT, role TEXT, text TEXT, ts INTEGER)").run();
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const mid = "m_" + randHex(10);
      await DB.prepare("INSERT INTO media (id, data, owner, ts) VALUES (?,?,?,?)").bind(mid, pollinationsImageUrl(prompt), me.key, now).run();
      await DB.prepare("INSERT INTO ai_messages (userkey, role, text, ts) VALUES (?,?,?,?)").bind(me.key, "user", "🎨 " + prompt, now).run();
      await DB.prepare("INSERT INTO ai_messages (userkey, role, text, ts) VALUES (?,?,?,?)").bind(me.key, "ai", MEDIA_PREFIX + mid, Date.now()).run();
      return json({ ok: true });
    }

    if (action === "aiclear") {
      if (!me) return need();
      await DB.prepare("CREATE TABLE IF NOT EXISTS ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, userkey TEXT, role TEXT, text TEXT, ts INTEGER)").run();
      await DB.prepare("DELETE FROM ai_messages WHERE userkey = ?").bind(me.key).run();
      return json({ ok: true });
    }

    if (action === "listusers") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can do that." }, 403);
      const { results } = await DB.prepare("SELECT key, display FROM users WHERE key != ? ORDER BY key").bind(me.key).all();
      return json({ users: results || [] });
    }

    if (action === "creategroup") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can create groups." }, 403);
      const name = String(body.name || "").trim();
      if (name.length < 1 || name.length > 50) return json({ error: "Group name must be 1–50 characters." }, 400);
      const want = new Set([me.key]);
      for (const m of (Array.isArray(body.members) ? body.members : [])) want.add(norm(m));
      const members = [];
      for (const k of want) if (await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(k).first()) members.push(k);
      if (members.length < 2) return json({ error: "Pick at least one member." }, 400);
      const id = "g_" + randHex(8);
      await DB.prepare("INSERT INTO groups (id, name, created_by, created) VALUES (?,?,?,?)").bind(id, name, me.key, now).run();
      await DB.batch(members.map(k => DB.prepare("INSERT INTO group_members (gid, userkey) VALUES (?,?)").bind(id, k)));
      return json({ ok: true, id, name });
    }

    if (action === "addmembers") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can add members." }, 403);
      const id = String(body.groupId || "");
      if (!await DB.prepare("SELECT 1 FROM groups WHERE id = ?").bind(id).first()) return json({ error: "Group not found." }, 404);
      const want = [];
      for (const m of (Array.isArray(body.members) ? body.members : [])) {
        const k = norm(m);
        if (k && !want.includes(k) && await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(k).first()) want.push(k);
      }
      if (!want.length) return json({ error: "Pick at least one member." }, 400);
      await DB.batch(want.map(k => DB.prepare("INSERT OR IGNORE INTO group_members (gid, userkey) VALUES (?,?)").bind(id, k)));
      return json({ ok: true, added: want.length });
    }

    if (action === "kickmember") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can remove members." }, 403);
      const id = String(body.groupId || "");
      const target = norm(body.user);
      if (!target) return json({ error: "No user given." }, 400);
      if (target === ADMIN_KEY) return json({ error: "Du kannst dich nicht selbst entfernen." }, 400);
      await DB.prepare("DELETE FROM group_members WHERE gid = ? AND userkey = ?").bind(id, target).run();
      return json({ ok: true });
    }

    if (action === "groupsend") {
      if (!me) return need();
      const id = String(body.groupId || "");
      if (!await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(id, me.key).first())
        return json({ error: "You're not in this group." }, 403);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty message." }, 400);
      if (text.length > 4000) return json({ error: "Message too long." }, 400);
      await DB.prepare("INSERT INTO group_messages (gid, sender, from_name, text, ts) VALUES (?,?,?,?,?)")
        .bind(id, me.key, me.display, text, now).run();
      return json({ ok: true, ts: now });
    }

    if (action === "deletemsg") {
      if (!me) return need();
      const toKey = norm(body.to);
      const ts = Number(body.ts);
      const m = await DB.prepare(
        "SELECT id, sender, text FROM messages WHERE ts = ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) LIMIT 1"
      ).bind(ts, me.key, toKey, toKey, me.key).first();
      if (!m) return json({ error: "Message not found." }, 404);
      if (m.sender !== me.key && me.key !== ADMIN_KEY) return json({ error: "You can only delete your own messages." }, 403);
      await DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id).run();
      if (m.text && m.text.startsWith(MEDIA_PREFIX)) await DB.prepare("DELETE FROM media WHERE id = ?").bind(m.text.slice(MEDIA_PREFIX.length)).run();
      return json({ ok: true });
    }

    if (action === "deletegroupmsg") {
      if (!me) return need();
      const id = String(body.groupId || "");
      if (!await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(id, me.key).first())
        return json({ error: "You're not in this group." }, 403);
      const ts = Number(body.ts);
      const m = await DB.prepare("SELECT id, sender, text FROM group_messages WHERE gid = ? AND ts = ? LIMIT 1").bind(id, ts).first();
      if (!m) return json({ error: "Message not found." }, 404);
      if (m.sender !== me.key && me.key !== ADMIN_KEY) return json({ error: "You can only delete your own messages." }, 403);
      await DB.prepare("DELETE FROM group_messages WHERE id = ?").bind(m.id).run();
      if (m.text && m.text.startsWith(MEDIA_PREFIX)) await DB.prepare("DELETE FROM media WHERE id = ?").bind(m.text.slice(MEDIA_PREFIX.length)).run();
      return json({ ok: true });
    }

    if (action === "editmsg") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann Nachrichten bearbeiten." }, 403);
      const toKey = norm(body.to);
      const ts = Number(body.ts);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty message." }, 400);
      if (text.length > 4000) return json({ error: "Message too long." }, 400);
      const m = await DB.prepare("SELECT id FROM messages WHERE ts = ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) LIMIT 1").bind(ts, me.key, toKey, toKey, me.key).first();
      if (!m) return json({ error: "Message not found." }, 404);
      await DB.prepare("UPDATE messages SET text = ? WHERE id = ?").bind(text, m.id).run();
      return json({ ok: true });
    }

    if (action === "editgroupmsg") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Nur der Owner kann Nachrichten bearbeiten." }, 403);
      const gid = String(body.groupId || "");
      const ts = Number(body.ts);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty message." }, 400);
      if (text.length > 4000) return json({ error: "Message too long." }, 400);
      const m = await DB.prepare("SELECT id FROM group_messages WHERE gid = ? AND ts = ? LIMIT 1").bind(gid, ts).first();
      if (!m) return json({ error: "Message not found." }, 404);
      await DB.prepare("UPDATE group_messages SET text = ? WHERE id = ?").bind(text, m.id).run();
      return json({ ok: true });
    }

    if (action === "editannounce") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can edit announcements." }, 403);
      const ts = Number(body.ts);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty announcement." }, 400);
      if (text.length > 4000) return json({ error: "Announcement too long." }, 400);
      const a = await DB.prepare("SELECT id FROM announcements WHERE ts = ? LIMIT 1").bind(ts).first();
      if (!a) return json({ error: "Announcement not found." }, 404);
      await DB.prepare("UPDATE announcements SET text = ? WHERE id = ?").bind(text, a.id).run();
      return json({ ok: true });
    }

    if (action === "setavatar") {
      if (!me) return need();
      let target = me.key;
      if (body.user && norm(body.user) !== me.key) {
        if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can change other people's photos." }, 403);
        target = norm(body.user);
      }
      const image = String(body.image || "");
      if (!image.startsWith("data:image/")) return json({ error: "Invalid image." }, 400);
      if (image.length > 900000) return json({ error: "Image too large." }, 400);
      await DB.prepare("INSERT INTO avatars (userkey, image) VALUES (?,?) ON CONFLICT(userkey) DO UPDATE SET image = excluded.image")
        .bind(target, image).run();
      return json({ ok: true });
    }
    if (action === "deleteavatar") {
      if (!me) return need();
      let target = me.key;
      if (body.user && norm(body.user) !== me.key) {
        if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can remove other people's photos." }, 403);
        target = norm(body.user);
      }
      await DB.prepare("DELETE FROM avatars WHERE userkey = ?").bind(target).run();
      return json({ ok: true });
    }
    if (action === "getavatar") {
      if (!me) return need();
      const r = await DB.prepare("SELECT image FROM avatars WHERE userkey = ?").bind(norm(body.user)).first();
      return json({ image: r ? r.image : null });
    }

    if (action === "uploadmedia") {
      if (!me) return need();
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const image = String(body.image || "");
      if (!image.startsWith("data:image/")) return json({ error: "Invalid image." }, 400);
      if (image.length > 2500000) return json({ error: "Image too large." }, 400);
      const id = "m_" + randHex(10);
      await DB.prepare("INSERT INTO media (id, data, owner, ts) VALUES (?,?,?,?)").bind(id, image, me.key, now).run();
      return json({ ok: true, id });
    }
    if (action === "getmedia") {
      if (!me) return need();
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const r = await DB.prepare("SELECT data FROM media WHERE id = ?").bind(String(body.id || "")).first();
      return json({ image: r ? r.data : null });
    }
    if (action === "mediastats") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can see stats." }, 403);
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const r = await DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM media").first();
      return json({ count: r ? r.n : 0, bytes: r ? r.bytes : 0 });
    }

    if (action === "stats") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can see stats." }, 403);
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const one = async (sql, ...b) => (await DB.prepare(sql).bind(...b).first()) || {};
      const users = await one("SELECT COUNT(*) AS n FROM users");
      const msgs = await one("SELECT COUNT(*) AS n FROM messages");
      const gmsgs = await one("SELECT COUNT(*) AS n FROM group_messages");
      const grps = await one("SELECT COUNT(*) AS n FROM groups");
      const anns = await one("SELECT COUNT(*) AS n FROM announcements");
      const codes = await one("SELECT COUNT(*) AS n, COUNT(used_by) AS u FROM invites");
      const online = await one("SELECT COUNT(*) AS n FROM presence WHERE ts > ?", now - 20000);
      const med = await one("SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS bytes FROM media");
      const top = (await DB.prepare(
        "SELECT u.display AS name, COUNT(*) AS c FROM messages m JOIN users u ON u.key = m.sender GROUP BY m.sender ORDER BY c DESC LIMIT 5"
      ).all()).results || [];
      let aiTotal = 0, aiToday = 0;
      try {
        const at = await one("SELECT COUNT(*) AS n FROM ai_messages WHERE role = 'user'");
        aiTotal = at.n || 0;
        const day = new Date(now).toISOString().slice(0, 10);
        const ad = await one("SELECT COALESCE(SUM(count), 0) AS n FROM ai_usage WHERE day = ?", day);
        aiToday = ad.n || 0;
      } catch { /* ai tables not created yet */ }
      return json({
        users: users.n || 0, messages: msgs.n || 0, groupMessages: gmsgs.n || 0,
        groups: grps.n || 0, announcements: anns.n || 0,
        codesUsed: codes.u || 0, codesFree: (codes.n || 0) - (codes.u || 0),
        online: online.n || 0, photos: med.n || 0, bytes: med.bytes || 0,
        aiTotal, aiToday,
        topUsers: top.map(t => ({ name: t.name, count: t.c })),
      });
    }

    if (action === "clearmedia") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can clear photos." }, 403);
      await DB.prepare("CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT, owner TEXT, ts INTEGER)").run();
      const cnt = await DB.prepare("SELECT COUNT(*) AS n FROM media").first();
      const like = MEDIA_PREFIX + "%";
      await DB.batch([
        DB.prepare("DELETE FROM messages WHERE text LIKE ?").bind(like),
        DB.prepare("DELETE FROM group_messages WHERE text LIKE ?").bind(like),
        DB.prepare("DELETE FROM announcements WHERE text LIKE ?").bind(like),
        DB.prepare("DELETE FROM media"),
      ]);
      return json({ ok: true, removed: cnt ? cnt.n : 0 });
    }

    if (action === "deleteuser") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can delete accounts." }, 403);
      const target = norm(body.user);
      if (!target) return json({ error: "No user given." }, 400);
      if (target === ADMIN_KEY) return json({ error: "You can't delete the owner account." }, 400);
      if (!await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(target).first()) return json({ error: "User not found." }, 404);
      await DB.batch([
        DB.prepare("DELETE FROM users WHERE key = ?").bind(target),
        DB.prepare("DELETE FROM avatars WHERE userkey = ?").bind(target),
        DB.prepare("DELETE FROM presence WHERE userkey = ?").bind(target),
        DB.prepare("DELETE FROM reads WHERE userkey = ?").bind(target),
        DB.prepare("DELETE FROM group_members WHERE userkey = ?").bind(target),
        DB.prepare("DELETE FROM messages WHERE sender = ? OR recipient = ?").bind(target, target),
      ]);
      return json({ ok: true });
    }

    if (action === "renameuser") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can rename others." }, 403);
      const target = norm(body.user);
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 24) return json({ error: "Name must be 1–24 characters." }, 400);
      if (!await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(target).first()) return json({ error: "User not found." }, 404);
      await DB.prepare("UPDATE users SET display = ? WHERE key = ?").bind(name, target).run();
      return json({ ok: true, name });
    }

    if (action === "setname") {
      if (!me) return need();
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 24) return json({ error: "Name must be 1–24 characters." }, 400);
      await DB.prepare("UPDATE users SET display = ? WHERE key = ?").bind(name, me.key).run();
      return json({ ok: true, name });
    }

    if (action === "deletegroup") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can delete groups." }, 403);
      const id = String(body.groupId || "");
      if (!await DB.prepare("SELECT 1 FROM groups WHERE id = ?").bind(id).first()) return json({ error: "Group not found." }, 404);
      await DB.batch([
        DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
        DB.prepare("DELETE FROM group_members WHERE gid = ?").bind(id),
        DB.prepare("DELETE FROM group_messages WHERE gid = ?").bind(id),
        DB.prepare("DELETE FROM reads WHERE scope = ?").bind(id),
      ]);
      return json({ ok: true });
    }

    if (action === "markseen") {
      if (!me) return need();
      const scope = String(body.scope || "");
      let scopeKey = null;
      if (scope === "dm") { const o = norm(body.id); if (o) scopeKey = convId(me.key, o); }
      else if (scope === "group") { if (body.id) scopeKey = String(body.id); }
      else if (scope === "ann") scopeKey = "announce";
      if (!scopeKey) return json({ error: "Bad scope." }, 400);
      await DB.prepare("INSERT INTO reads (scope, userkey, ts) VALUES (?,?,?) ON CONFLICT(scope, userkey) DO UPDATE SET ts = excluded.ts")
        .bind(scopeKey, me.key, now).run();
      return json({ ok: true });
    }

    if (action === "typing") {
      if (!me) return need();
      await DB.prepare("CREATE TABLE IF NOT EXISTS typing (scope TEXT, userkey TEXT, ts INTEGER, PRIMARY KEY (scope, userkey))").run();
      const scope = String(body.scope || "");
      let scopeKey = null;
      if (scope === "dm") { const o = norm(body.id); if (o) scopeKey = convId(me.key, o); }
      else if (scope === "group") { if (body.id) scopeKey = String(body.id); }
      if (!scopeKey) return json({ error: "Bad scope." }, 400);
      if (body.stop) {
        await DB.prepare("DELETE FROM typing WHERE scope = ? AND userkey = ?").bind(scopeKey, me.key).run();
        return json({ ok: true });
      }
      await DB.prepare("INSERT INTO typing (scope, userkey, ts) VALUES (?,?,?) ON CONFLICT(scope, userkey) DO UPDATE SET ts = excluded.ts")
        .bind(scopeKey, me.key, now).run();
      return json({ ok: true });
    }

    if (action === "sync") {
      if (!me) return need();
      if (body.touch) {
        await DB.prepare("INSERT INTO presence (userkey, ts) VALUES (?,?) ON CONFLICT(userkey) DO UPDATE SET ts = excluded.ts")
          .bind(me.key, now).run();
      }

      const partRows = (await DB.prepare(
        `SELECT p.other, p.last, p.ts, p.lastfrom, u.display FROM (
           SELECT CASE WHEN sender = ?1 THEN recipient ELSE sender END AS other,
                  text AS last, MAX(ts) AS ts, sender AS lastfrom
           FROM messages WHERE sender = ?1 OR recipient = ?1 GROUP BY other
         ) p JOIN users u ON u.key = p.other`
      ).bind(me.key).all()).results || [];
      const partners = {};
      const presKeys = new Set();
      for (const r of partRows) { partners[r.other] = { last: r.last, ts: r.ts, name: r.display, from: r.lastfrom }; presKeys.add(r.other); }

      const grpRows = (await DB.prepare(
        `SELECT g.id, g.name,
           (SELECT text FROM group_messages WHERE gid = g.id ORDER BY ts DESC LIMIT 1) AS last,
           (SELECT from_name FROM group_messages WHERE gid = g.id ORDER BY ts DESC LIMIT 1) AS lastname,
           (SELECT ts FROM group_messages WHERE gid = g.id ORDER BY ts DESC LIMIT 1) AS ts,
           (SELECT sender FROM group_messages WHERE gid = g.id ORDER BY ts DESC LIMIT 1) AS lastfrom
         FROM groups g JOIN group_members gm ON gm.gid = g.id AND gm.userkey = ?1`
      ).bind(me.key).all()).results || [];
      const groups = {};
      for (const g of grpRows) groups[g.id] = { name: g.name, ts: g.ts || 0, last: g.lastname ? g.lastname + ": " + g.last : "", from: g.lastfrom || "" };

      let messages = [];
      const chatWith = norm(body.chatWith);
      if (chatWith) {
        presKeys.add(chatWith);
        messages = ((await DB.prepare(
          "SELECT sender, recipient, text, ts FROM messages WHERE (sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1) ORDER BY ts ASC"
        ).bind(me.key, chatWith).all()).results || []).map(m => ({ from: m.sender, to: m.recipient, text: m.text, ts: m.ts }));
      }

      let groupMessages = null, groupMeta = null;
      const groupWith = String(body.groupWith || "");
      if (groupWith && await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(groupWith, me.key).first()) {
        groupMessages = ((await DB.prepare("SELECT sender, from_name, text, ts FROM group_messages WHERE gid = ? ORDER BY ts ASC").bind(groupWith).all()).results || [])
          .map(m => ({ from: m.sender, fromName: m.from_name, text: m.text, ts: m.ts }));
        const g = await DB.prepare("SELECT name FROM groups WHERE id = ?").bind(groupWith).first();
        const mem = (await DB.prepare("SELECT u.key, u.display FROM group_members gm JOIN users u ON u.key = gm.userkey WHERE gm.gid = ?").bind(groupWith).all()).results || [];
        for (const m of mem) presKeys.add(m.key);
        groupMeta = { id: groupWith, name: g ? g.name : "Group", members: mem.map(m => ({ key: m.key, name: m.display })) };
      }

      const presence = {};
      const pk = [...presKeys];
      if (pk.length) {
        const ph = pk.map(() => "?").join(",");
        const pr = (await DB.prepare(`SELECT userkey, ts FROM presence WHERE userkey IN (${ph})`).bind(...pk).all()).results || [];
        for (const r of pr) presence[r.userkey] = r.ts;
      }

      const annRows = (await DB.prepare("SELECT text, ts FROM (SELECT text, ts, id FROM announcements ORDER BY id DESC LIMIT 50) ORDER BY id ASC").all()).results || [];
      const announcements = annRows.map(a => ({ text: a.text, ts: a.ts }));

      let reads = null;
      let scopeKey = null;
      if (chatWith) scopeKey = convId(me.key, chatWith);
      else if (groupWith && groupMeta) scopeKey = groupWith;
      if (scopeKey) {
        reads = {};
        const rr = (await DB.prepare("SELECT userkey, ts FROM reads WHERE scope = ?").bind(scopeKey).all()).results || [];
        for (const r of rr) reads[r.userkey] = r.ts;
      }

      let annReaders = null;
      if (me.key === ADMIN_KEY) {
        const rr = (await DB.prepare("SELECT r.userkey, u.display, r.ts FROM reads r JOIN users u ON u.key = r.userkey WHERE r.scope = 'announce'").all()).results || [];
        annReaders = rr.map(r => ({ key: r.userkey, name: r.display, ts: r.ts }));
      }

      let aiMessages = null;
      if (body.aiOpen) {
        try {
          aiMessages = ((await DB.prepare("SELECT role, text, ts FROM ai_messages WHERE userkey = ? ORDER BY id ASC LIMIT 200").bind(me.key).all()).results || [])
            .map(m => ({ role: m.role, text: m.text, ts: m.ts }));
        } catch { aiMessages = []; }
      }

      let typing = [];   // who is typing in the open conversation right now
      try {
        const ts = chatWith ? convId(me.key, chatWith) : (groupWith && groupMeta ? groupWith : null);
        if (ts) {
          const tr = (await DB.prepare(
            "SELECT u.display FROM typing t JOIN users u ON u.key = t.userkey WHERE t.scope = ? AND t.userkey != ? AND t.ts > ?"
          ).bind(ts, me.key, now - 3000).all()).results || [];
          typing = tr.map(r => r.display);
        }
      } catch { typing = []; }

      return json({
        me: me.key, meName: me.display, partners, messages, announcements, isAdmin: me.key === ADMIN_KEY,
        groups, groupMessages, groupMeta, presence, reads, annReaders, typing, aiMessages, now,
      });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message) }, 500);
  }
}
