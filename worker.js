// WriteChat backend — Cloudflare Worker with static assets + D1 database.
// Serves the page (public/) and handles the /api endpoint.

const ADMIN_KEY = "hsadmin";
const VALID_CODES = [];   // no fixed codes — the owner generates all invite codes in the panel
const MASTER_CODE = "hschef";
const USER_RE = /^[a-zA-Z0-9_-]{2,20}$/;
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
      if (image.length > 900000) return json({ error: "Image too large." }, 400);
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

      return json({
        me: me.key, meName: me.display, partners, messages, announcements, isAdmin: me.key === ADMIN_KEY,
        groups, groupMessages, groupMeta, presence, reads, annReaders, now,
      });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message) }, 500);
  }
}
