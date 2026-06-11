// WriteChat backend for Cloudflare Pages Functions + D1 (SQLite database).
// Route: /api  (this file = functions/api.js)
// Needs a D1 binding named "DB" (set in Pages → Settings → Functions → D1 bindings).

const ADMIN_KEY = "hsadmin";
const VALID_CODES = ["tomate1", "tomate2", "tomate3", "tomate4", "tomate5", "tomate6", "tomate7", "tomate8", "tomate9", "tomate10"];
const MASTER_CODE = "hschef";
const USER_RE = /^[a-zA-Z0-9_-]{2,20}$/;

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

async function hashPw(pw, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("writechat:" + salt + ":" + pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequest(context) {
  const { request, env } = context;
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
    // ---------- register ----------
    if (action === "register") {
      const uname = String(body.username || "").trim();
      const pass = String(body.password || "");
      const key = norm(uname);
      if (!USER_RE.test(uname)) return json({ error: "Username: 2–20 letters, numbers, _ or - (no spaces)." }, 400);
      if (pass.length < 3) return json({ error: "Password must be at least 3 characters." }, 400);
      if (await DB.prepare("SELECT 1 FROM users WHERE key = ?").bind(key).first()) return json({ error: "That username is already taken." }, 400);

      const code = norm(body.code);
      const isMaster = code === MASTER_CODE;
      if (!isMaster) {
        if (!VALID_CODES.includes(code)) return json({ error: "Ungültiger Einladungscode." }, 403);
        if (await DB.prepare("SELECT 1 FROM invites WHERE code = ?").bind(code).first()) return json({ error: "Dieser Einladungscode wurde schon benutzt." }, 403);
      }

      const salt = randHex(16);
      const tk = token();
      await DB.prepare("INSERT INTO users (key, display, hash, salt, token, created) VALUES (?,?,?,?,?,?)")
        .bind(key, uname, await hashPw(pass, salt), salt, tk, now).run();
      if (!isMaster) await DB.prepare("INSERT INTO invites (code, used_by) VALUES (?,?)").bind(code, key).run();
      return json({ token: tk, username: uname, key });
    }

    // ---------- login ----------
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

    // ---------- search ----------
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

    // ---------- send ----------
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

    // ---------- announce (owner) ----------
    if (action === "announce") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can post announcements." }, 403);
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Empty announcement." }, 400);
      if (text.length > 4000) return json({ error: "Announcement too long." }, 400);
      await DB.prepare("INSERT INTO announcements (text, ts) VALUES (?,?)").bind(text, now).run();
      return json({ ok: true });
    }

    // ---------- list users (owner) ----------
    if (action === "listusers") {
      if (!me) return need();
      if (me.key !== ADMIN_KEY) return json({ error: "Only the owner can do that." }, 403);
      const { results } = await DB.prepare("SELECT key, display FROM users WHERE key != ? ORDER BY key").bind(me.key).all();
      return json({ users: results || [] });
    }

    // ---------- create group (owner) ----------
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

    // ---------- group send ----------
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

    // ---------- delete a direct message ----------
    if (action === "deletemsg") {
      if (!me) return need();
      const toKey = norm(body.to);
      const ts = Number(body.ts);
      const m = await DB.prepare(
        "SELECT id, sender FROM messages WHERE ts = ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) LIMIT 1"
      ).bind(ts, me.key, toKey, toKey, me.key).first();
      if (!m) return json({ error: "Message not found." }, 404);
      if (m.sender !== me.key && me.key !== ADMIN_KEY) return json({ error: "You can only delete your own messages." }, 403);
      await DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id).run();
      return json({ ok: true });
    }

    // ---------- delete a group message ----------
    if (action === "deletegroupmsg") {
      if (!me) return need();
      const id = String(body.groupId || "");
      if (!await DB.prepare("SELECT 1 FROM group_members WHERE gid = ? AND userkey = ?").bind(id, me.key).first())
        return json({ error: "You're not in this group." }, 403);
      const ts = Number(body.ts);
      const m = await DB.prepare("SELECT id, sender FROM group_messages WHERE gid = ? AND ts = ? LIMIT 1").bind(id, ts).first();
      if (!m) return json({ error: "Message not found." }, 404);
      if (m.sender !== me.key && me.key !== ADMIN_KEY) return json({ error: "You can only delete your own messages." }, 403);
      await DB.prepare("DELETE FROM group_messages WHERE id = ?").bind(m.id).run();
      return json({ ok: true });
    }

    // ---------- avatar ----------
    if (action === "setavatar") {
      if (!me) return need();
      const image = String(body.image || "");
      if (!image.startsWith("data:image/")) return json({ error: "Invalid image." }, 400);
      if (image.length > 900000) return json({ error: "Image too large." }, 400);
      await DB.prepare("INSERT INTO avatars (userkey, image) VALUES (?,?) ON CONFLICT(userkey) DO UPDATE SET image = excluded.image")
        .bind(me.key, image).run();
      return json({ ok: true });
    }
    if (action === "getavatar") {
      if (!me) return need();
      const r = await DB.prepare("SELECT image FROM avatars WHERE userkey = ?").bind(norm(body.user)).first();
      return json({ image: r ? r.image : null });
    }

    // ---------- delete account (owner) ----------
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

    // ---------- owner renames a user ----------
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

    // ---------- change my display name ----------
    if (action === "setname") {
      if (!me) return need();
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 24) return json({ error: "Name must be 1–24 characters." }, 400);
      await DB.prepare("UPDATE users SET display = ? WHERE key = ?").bind(name, me.key).run();
      return json({ ok: true, name });
    }

    // ---------- owner deletes a group ----------
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

    // ---------- mark seen ----------
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

    // ---------- sync ----------
    if (action === "sync") {
      if (!me) return need();
      if (body.touch) {
        await DB.prepare("INSERT INTO presence (userkey, ts) VALUES (?,?) ON CONFLICT(userkey) DO UPDATE SET ts = excluded.ts")
          .bind(me.key, now).run();
      }

      // direct-chat partners (last message each); JOIN users hides deleted accounts
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

      // my groups (last message each)
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

      // open direct chat messages
      let messages = [];
      const chatWith = norm(body.chatWith);
      if (chatWith) {
        presKeys.add(chatWith);
        messages = ((await DB.prepare(
          "SELECT sender, recipient, text, ts FROM messages WHERE (sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1) ORDER BY ts ASC"
        ).bind(me.key, chatWith).all()).results || []).map(m => ({ from: m.sender, to: m.recipient, text: m.text, ts: m.ts }));
      }

      // open group messages + meta
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

      // presence for everyone shown
      const presence = {};
      const pk = [...presKeys];
      if (pk.length) {
        const ph = pk.map(() => "?").join(",");
        const pr = (await DB.prepare(`SELECT userkey, ts FROM presence WHERE userkey IN (${ph})`).bind(...pk).all()).results || [];
        for (const r of pr) presence[r.userkey] = r.ts;
      }

      // announcements (last 50)
      const annRows = (await DB.prepare("SELECT text, ts FROM (SELECT text, ts, id FROM announcements ORDER BY id DESC LIMIT 50) ORDER BY id ASC").all()).results || [];
      const announcements = annRows.map(a => ({ text: a.text, ts: a.ts }));

      // read markers for the open conversation/group
      let reads = null;
      let scopeKey = null;
      if (chatWith) scopeKey = convId(me.key, chatWith);
      else if (groupWith && groupMeta) scopeKey = groupWith;
      if (scopeKey) {
        reads = {};
        const rr = (await DB.prepare("SELECT userkey, ts FROM reads WHERE scope = ?").bind(scopeKey).all()).results || [];
        for (const r of rr) reads[r.userkey] = r.ts;
      }

      // who has seen announcements (owner only)
      let annReaders = null;
      if (me.key === ADMIN_KEY) {
        const rr = (await DB.prepare("SELECT r.userkey, u.display, r.ts FROM reads r JOIN users u ON u.key = r.userkey WHERE r.scope = 'announce'").all()).results || [];
        annReaders = rr.map(r => ({ key: r.userkey, name: r.display, ts: r.ts }));
      }

      return json({
        me: me.key, partners, messages, announcements, isAdmin: me.key === ADMIN_KEY,
        groups, groupMessages, groupMeta, presence, reads, annReaders, now,
      });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message) }, 500);
  }
}
