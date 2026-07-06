// Worker: API multiusuario + recordatorios diarios (cron).
// Todos los datos se guardan en D1, separados por usuario. Los logos se toman
// automáticamente del favicon del dominio (no se almacenan archivos, no usa R2).

const enc = new TextEncoder();

/* ----------------------------- utilidades fecha ---------------------------- */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmtISO(dt) {
  return dt.toISOString().slice(0, 10);
}
function addInterval(iso, unit, count) {
  const dt = parseISO(iso);
  if (unit === "week") {
    dt.setUTCDate(dt.getUTCDate() + 7 * count);
    return fmtISO(dt);
  }
  // month / year: sumar meses respetando fin de mes (sin desbordar a marzo)
  const months = unit === "year" ? 12 * count : count;
  const day = dt.getUTCDate();
  dt.setUTCDate(1);
  dt.setUTCMonth(dt.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, lastDay));
  return fmtISO(dt);
}
function daysBetween(aISO, bISO) {
  return Math.round((parseISO(bISO) - parseISO(aISO)) / 86400000);
}
// Avanza una fecha recurrente hasta que sea >= hoy
function rollForward(iso, unit, count) {
  let cur = iso;
  let guard = 0;
  while (daysBetween(todayISO(), cur) < 0 && guard < 600) {
    cur = addInterval(cur, unit, count);
    guard++;
  }
  return cur;
}

/* ------------------------- auth: hash + token (HMAC) ----------------------- */
function bytesToB64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
function b64url(str) { return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(str) { return atob(str.replace(/-/g, "+").replace(/_/g, "/")); }

// Contraseñas: PBKDF2-SHA256, 100k iteraciones, salt aleatorio por usuario.
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256
  );
  return { hash: bytesToB64(new Uint8Array(bits)), salt: bytesToB64(salt) };
}
async function verifyPassword(password, hashB64, saltB64) {
  const { hash } = await hashPassword(password, saltB64);
  return hash === hashB64;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeToken(env, uid) {
  const payload = b64url(JSON.stringify({ uid, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }));
  const sig = await hmac(env.SESSION_SECRET || "dev-secret", payload);
  return `${payload}.${sig}`;
}
async function verifyToken(env, token) {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET || "dev-secret", payload);
  if (sig !== expected) return null;
  try {
    const o = JSON.parse(b64urlDecode(payload));
    if (o.exp > Date.now()) return o; // { uid, exp }
  } catch (e) {}
  return null;
}

/* ------------------------------- helpers HTTP ------------------------------ */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const SETTING_DEFAULTS = {
  display_currency: "GTQ", exchange_rate: "7.8", reminder_days: "3",
  notify_phone: "", notify_channel: "app", hero_theme: "violeta",
};
async function readSettings(env, uid) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM user_settings WHERE user_id=?"
  ).bind(uid).all();
  const s = {};
  for (const r of results) s[r.key] = r.value;
  return { ...SETTING_DEFAULTS, ...s };
}

// Crea las categorías por defecto de un usuario nuevo.
async function seedUserCategories(env, uid) {
  await env.DB.prepare("INSERT INTO categories (user_id, name, color, sort_order) VALUES (?,?,?,0)")
    .bind(uid, "Suscripciones", "#8b5cf6").run();
  await env.DB.prepare("INSERT INTO categories (user_id, name, color, sort_order) VALUES (?,?,?,1)")
    .bind(uid, "Pagos mensuales", "#06b6d4").run();
}

/* ----------------------- lógica de cola / pagos ---------------------------- */
// Recalcula next_due_date de una suscripción manual a partir de sus pagos.
async function recomputeManualDue(env, subId) {
  const row = await env.DB.prepare(
    "SELECT MIN(due_date) AS d FROM payments WHERE subscription_id=? AND paid=0"
  ).bind(subId).first();
  await env.DB.prepare("UPDATE subscriptions SET next_due_date=? WHERE id=?")
    .bind(row?.d || null, subId).run();
}

// Verifica que una suscripción pertenezca al usuario; devuelve la fila o null.
async function ownedSub(env, id, uid) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE id=? AND user_id=?").bind(id, uid).first();
}

async function getFullState(env, uid) {
  const settings = await readSettings(env, uid);
  const me = await env.DB.prepare("SELECT id, username, is_admin FROM users WHERE id=?").bind(uid).first();
  const { results: cats } = await env.DB.prepare(
    "SELECT * FROM categories WHERE user_id=? ORDER BY sort_order ASC, id ASC"
  ).bind(uid).all();
  const { results: subs } = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE user_id=? ORDER BY active DESC, " +
    "CASE WHEN next_due_date IS NULL THEN 1 ELSE 0 END, next_due_date ASC, id ASC"
  ).bind(uid).all();
  const { results: pays } = await env.DB.prepare(
    "SELECT * FROM payments WHERE user_id=? ORDER BY due_date ASC"
  ).bind(uid).all();

  const byId = {};
  for (const s of subs) { s.payments = []; byId[s.id] = s; }
  for (const p of pays) if (byId[p.subscription_id]) byId[p.subscription_id].payments.push(p);

  const today = todayISO();
  for (const s of subs) {
    s.days_until = s.next_due_date ? daysBetween(today, s.next_due_date) : null;
  }

  const disp = settings.display_currency || "GTQ";
  const rate = parseFloat(settings.exchange_rate || "7.8");
  const conv = (amount, cur) => {
    if (cur === disp) return amount;
    if (cur === "USD" && disp === "GTQ") return amount * rate;
    if (cur === "GTQ" && disp === "USD") return amount / rate;
    return amount;
  };
  const monthlyFactor = (s) => {
    const c = s.interval_count || 1;
    if (s.interval_unit === "week") return (52 / 12) / c;
    if (s.interval_unit === "year") return 1 / (12 * c);
    return 1 / c;
  };

  let monthly = 0, paidThisMonth = 0, paidThisYear = 0;
  const ym = today.slice(0, 7), yr = today.slice(0, 4);
  for (const s of subs) {
    if (!s.active) continue;
    if (s.billing_type === "recurring") monthly += conv(s.amount, s.currency) * monthlyFactor(s);
  }
  for (const p of pays) {
    if (!p.paid || !p.paid_date) continue;
    const v = conv(p.amount, p.currency);
    if (p.paid_date.slice(0, 7) === ym) paidThisMonth += v;
    if (p.paid_date.slice(0, 4) === yr) paidThisYear += v;
  }
  let manualYear = 0;
  const limit = addInterval(today, "year", 1);
  for (const s of subs) {
    if (!s.active || s.billing_type !== "manual") continue;
    for (const p of s.payments) {
      if (!p.paid && daysBetween(today, p.due_date) >= 0 && daysBetween(p.due_date, limit) >= 0)
        manualYear += conv(p.amount, p.currency);
    }
  }

  const next = subs.find((s) => s.active && s.next_due_date);
  const summary = {
    display_currency: disp,
    monthly_recurring: monthly,
    yearly_estimate: monthly * 12 + manualYear,
    paid_this_month: paidThisMonth,
    paid_this_year: paidThisYear,
    next_payment: next
      ? { name: next.name, date: next.next_due_date, days: next.days_until, amount: next.amount, currency: next.currency }
      : null,
    active_count: subs.filter((s) => s.active).length,
  };

  return { me, settings, categories: cats, subscriptions: subs, summary, today };
}

/* --------------------------- API (autenticación) --------------------------- */
async function handleAuth(request, env, path, method) {
  // ¿Hay que configurar el primer admin? (público)
  if (path === "/api/status" && method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return json({ needs_setup: (row?.n || 0) === 0 });
  }

  // Setup del primer admin: reclama los datos existentes. (público, una sola vez)
  if (path === "/api/setup" && method === "POST") {
    const { username, password, setup_key } = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if ((row?.n || 0) > 0) return json({ error: "Ya existe una cuenta. Inicia sesión." }, 400);
    if (setup_key !== (env.APP_PASSWORD || "1234")) return json({ error: "Clave maestra incorrecta." }, 401);
    if (!username || username.trim().length < 3) return json({ error: "Usuario mínimo 3 caracteres." }, 400);
    if (!password || password.length < 4) return json({ error: "Contraseña mínimo 4 caracteres." }, 400);
    const { hash, salt } = await hashPassword(password);
    const res = await env.DB.prepare(
      "INSERT INTO users (username, pass_hash, pass_salt, is_admin) VALUES (?,?,?,1)"
    ).bind(username.trim(), hash, salt).run();
    const uid = res.meta.last_row_id;
    // Reclamar todos los datos existentes (huérfanos) para este admin.
    await env.DB.prepare("UPDATE subscriptions SET user_id=? WHERE user_id IS NULL").bind(uid).run();
    await env.DB.prepare("UPDATE payments SET user_id=? WHERE user_id IS NULL").bind(uid).run();
    await env.DB.prepare("UPDATE categories SET user_id=? WHERE user_id IS NULL").bind(uid).run();
    // Migrar ajustes globales antiguos (si existen) a los del usuario.
    try {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_settings (user_id, key, value) SELECT ?, key, value FROM settings"
      ).bind(uid).run();
    } catch (e) {}
    // Si no quedó ninguna categoría, sembrar las por defecto.
    const catCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE user_id=?").bind(uid).first();
    if ((catCount?.n || 0) === 0) await seedUserCategories(env, uid);
    return json({ token: await makeToken(env, uid), me: { id: uid, username: username.trim(), is_admin: 1 } });
  }

  // Login (público)
  if (path === "/api/login" && method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    const u = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind((username || "").trim()).first();
    if (!u || !(await verifyPassword(password || "", u.pass_hash, u.pass_salt))) {
      return json({ error: "Usuario o contraseña incorrectos." }, 401);
    }
    return json({ token: await makeToken(env, u.id), me: { id: u.id, username: u.username, is_admin: u.is_admin } });
  }

  return null; // no era ruta de auth
}

/* ------------------------------ API (con sesión) --------------------------- */
async function handleApi(request, env, path, method, uid) {
  let m;

  if (path === "/api/state" && method === "GET") {
    return json(await getFullState(env, uid));
  }

  // ---- Ajustes del usuario ----
  if (path === "/api/settings" && method === "PUT") {
    const body = await request.json();
    const allowed = ["display_currency", "exchange_rate", "reminder_days", "notify_phone", "notify_channel", "hero_theme"];
    for (const k of allowed) {
      if (k in body) {
        await env.DB.prepare(
          "INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?) " +
          "ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value"
        ).bind(uid, k, String(body[k])).run();
      }
    }
    return json({ ok: true });
  }

  if (path === "/api/test-notify" && method === "POST") {
    const st = await readSettings(env, uid);
    const phone = (st.notify_phone || "").trim();
    const channel = st.notify_channel || "app";
    if (channel === "app") return json({ ok: false, error: "El canal está en 'App'. Elige WhatsApp o SMS para enviar avisos." }, 400);
    if (!phone) return json({ ok: false, error: "Falta tu número en Ajustes." }, 400);
    const body = "✅ Prueba de tu app de Suscripciones: ¡los recordatorios funcionan!";
    const r = channel === "whatsapp" ? await sendWhatsApp(env, phone, body) : await sendSMS(env, phone, body);
    return r.ok ? json({ ok: true }) : json({ ok: false, error: r.error || "No se pudo enviar." }, 400);
  }

  // ---- Gestión de usuarios (solo admin) ----
  if (path === "/api/users") {
    const me = await env.DB.prepare("SELECT is_admin FROM users WHERE id=?").bind(uid).first();
    if (!me?.is_admin) return json({ error: "Solo el administrador puede gestionar usuarios." }, 403);
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, username, is_admin, created_at FROM users ORDER BY id ASC"
      ).all();
      return json({ users: results });
    }
    if (method === "POST") {
      const { username, password, is_admin } = await request.json().catch(() => ({}));
      if (!username || username.trim().length < 3) return json({ error: "Usuario mínimo 3 caracteres." }, 400);
      if (!password || password.length < 4) return json({ error: "Contraseña mínimo 4 caracteres." }, 400);
      const exists = await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username.trim()).first();
      if (exists) return json({ error: "Ese usuario ya existe." }, 400);
      const { hash, salt } = await hashPassword(password);
      const res = await env.DB.prepare(
        "INSERT INTO users (username, pass_hash, pass_salt, is_admin) VALUES (?,?,?,?)"
      ).bind(username.trim(), hash, salt, is_admin ? 1 : 0).run();
      await seedUserCategories(env, res.meta.last_row_id);
      return json({ id: res.meta.last_row_id });
    }
  }
  if ((m = path.match(/^\/api\/users\/(\d+)$/))) {
    const me = await env.DB.prepare("SELECT is_admin FROM users WHERE id=?").bind(uid).first();
    if (!me?.is_admin) return json({ error: "Solo el administrador puede gestionar usuarios." }, 403);
    const targetId = Number(m[1]);
    if (method === "PUT") { // cambiar contraseña
      const { password } = await request.json().catch(() => ({}));
      if (!password || password.length < 4) return json({ error: "Contraseña mínimo 4 caracteres." }, 400);
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(hash, salt, targetId).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      if (targetId === uid) return json({ error: "No puedes borrar tu propia cuenta." }, 400);
      // borrar todos los datos del usuario
      await env.DB.prepare("DELETE FROM payments WHERE user_id=?").bind(targetId).run();
      await env.DB.prepare("DELETE FROM subscriptions WHERE user_id=?").bind(targetId).run();
      await env.DB.prepare("DELETE FROM categories WHERE user_id=?").bind(targetId).run();
      await env.DB.prepare("DELETE FROM user_settings WHERE user_id=?").bind(targetId).run();
      await env.DB.prepare("DELETE FROM users WHERE id=?").bind(targetId).run();
      return json({ ok: true });
    }
  }

  // ---- Categorías ----
  if (path === "/api/categories" && method === "POST") {
    const b = await request.json();
    if (!b.name || !b.name.trim()) return json({ error: "Falta el nombre" }, 400);
    const max = await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM categories WHERE user_id=?"
    ).bind(uid).first();
    const res = await env.DB.prepare(
      "INSERT INTO categories (user_id, name, color, sort_order) VALUES (?,?,?,?)"
    ).bind(uid, b.name.trim(), b.color || "#6366f1", max.n).run();
    return json({ id: res.meta.last_row_id });
  }
  if ((m = path.match(/^\/api\/categories\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "PUT") {
      const b = await request.json();
      const sets = [], vals = [];
      if ("name" in b) { sets.push("name=?"); vals.push(b.name); }
      if ("color" in b) { sets.push("color=?"); vals.push(b.color); }
      if ("sort_order" in b) { sets.push("sort_order=?"); vals.push(b.sort_order); }
      if (sets.length) { vals.push(id, uid); await env.DB.prepare(`UPDATE categories SET ${sets.join(",")} WHERE id=? AND user_id=?`).bind(...vals).run(); }
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE subscriptions SET category_id=NULL WHERE category_id=? AND user_id=?").bind(id, uid).run();
      await env.DB.prepare("DELETE FROM categories WHERE id=? AND user_id=?").bind(id, uid).run();
      return json({ ok: true });
    }
  }

  // ---- Crear suscripción ----
  if (path === "/api/subscriptions" && method === "POST") {
    const b = await request.json();
    let nextDue = b.next_due_date || null;
    if (b.billing_type === "recurring" && nextDue) {
      nextDue = rollForward(nextDue, b.interval_unit || "month", b.interval_count || 1);
    }
    const res = await env.DB.prepare(
      `INSERT INTO subscriptions
       (user_id, name, category_id, icon_type, icon_value, color, amount, currency, billing_type,
        interval_unit, interval_count, anchor_date, next_due_date, reminder_days, notify, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      uid, b.name, b.category_id ?? null, b.icon_type || "emoji", b.icon_value || "💳", b.color || "#6366f1",
      b.amount || 0, b.currency || "GTQ", b.billing_type || "recurring",
      b.interval_unit || "month", b.interval_count || 1, b.anchor_date || null,
      b.billing_type === "manual" ? null : nextDue,
      b.reminder_days ?? null, b.notify === 0 ? 0 : 1, b.notes || null
    ).run();
    const id = res.meta.last_row_id;
    if (b.billing_type === "manual" && Array.isArray(b.payments)) {
      for (const p of b.payments) {
        if (!p.due_date) continue;
        await env.DB.prepare(
          "INSERT INTO payments (user_id, subscription_id, due_date, amount, currency) VALUES (?,?,?,?,?)"
        ).bind(uid, id, p.due_date, p.amount ?? b.amount ?? 0, p.currency || b.currency || "GTQ").run();
      }
      await recomputeManualDue(env, id);
    }
    return json({ id });
  }

  // ---- Suscripción por id ----
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)$/))) {
    const id = Number(m[1]);
    if (!(await ownedSub(env, id, uid))) return json({ error: "No existe" }, 404);
    if (method === "PUT") {
      const b = await request.json();
      const fields = ["name", "category_id", "icon_type", "icon_value", "color", "amount", "currency",
        "billing_type", "interval_unit", "interval_count", "anchor_date", "next_due_date",
        "reminder_days", "notify", "notes", "active"];
      const sets = [], vals = [];
      for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
      if (sets.length) {
        vals.push(id, uid);
        await env.DB.prepare(`UPDATE subscriptions SET ${sets.join(",")} WHERE id=? AND user_id=?`).bind(...vals).run();
      }
      if (b.billing_type === "manual") await recomputeManualDue(env, id);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM payments WHERE subscription_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM subscriptions WHERE id=? AND user_id=?").bind(id, uid).run();
      return json({ ok: true });
    }
  }

  // ---- Marcar pagado (avanza la cola) ----
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/pay$/)) && method === "POST") {
    const id = Number(m[1]);
    const s = await ownedSub(env, id, uid);
    if (!s) return json({ error: "No existe" }, 404);
    if (s.billing_type === "recurring") {
      const due = s.next_due_date || todayISO();
      await env.DB.prepare(
        "INSERT INTO payments (user_id, subscription_id, due_date, amount, currency, paid, paid_date) VALUES (?,?,?,?,?,1,?)"
      ).bind(uid, id, due, s.amount, s.currency, todayISO()).run();
      const newDue = addInterval(due, s.interval_unit, s.interval_count || 1);
      await env.DB.prepare("UPDATE subscriptions SET next_due_date=?, last_reminded=NULL WHERE id=?").bind(newDue, id).run();
    } else {
      const p = await env.DB.prepare(
        "SELECT * FROM payments WHERE subscription_id=? AND paid=0 ORDER BY due_date ASC LIMIT 1"
      ).bind(id).first();
      if (p) await env.DB.prepare("UPDATE payments SET paid=1, paid_date=? WHERE id=?").bind(todayISO(), p.id).run();
      await env.DB.prepare("UPDATE subscriptions SET last_reminded=NULL WHERE id=?").bind(id).run();
      await recomputeManualDue(env, id);
    }
    return json({ ok: true });
  }

  // ---- Deshacer el último pago ----
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/undo-pay$/)) && method === "POST") {
    const id = Number(m[1]);
    const s = await ownedSub(env, id, uid);
    if (!s) return json({ error: "No existe" }, 404);
    let undone = false;
    if (s.billing_type === "recurring") {
      const p = await env.DB.prepare(
        "SELECT * FROM payments WHERE subscription_id=? AND paid=1 ORDER BY id DESC LIMIT 1"
      ).bind(id).first();
      if (p) {
        await env.DB.prepare("DELETE FROM payments WHERE id=?").bind(p.id).run();
        await env.DB.prepare("UPDATE subscriptions SET next_due_date=?, last_reminded=NULL WHERE id=?").bind(p.due_date, id).run();
        undone = true;
      }
    } else {
      const p = await env.DB.prepare(
        "SELECT * FROM payments WHERE subscription_id=? AND paid=1 ORDER BY paid_date DESC, id DESC LIMIT 1"
      ).bind(id).first();
      if (p) {
        await env.DB.prepare("UPDATE payments SET paid=0, paid_date=NULL WHERE id=?").bind(p.id).run();
        await recomputeManualDue(env, id);
        undone = true;
      }
    }
    return json({ ok: true, undone });
  }

  // ---- Reemplazar pagos no pagados (sincroniza el formulario) ----
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/payments\/replace$/)) && method === "POST") {
    const id = Number(m[1]);
    if (!(await ownedSub(env, id, uid))) return json({ error: "No existe" }, 404);
    const b = await request.json();
    await env.DB.prepare("DELETE FROM payments WHERE subscription_id=? AND paid=0").bind(id).run();
    for (const p of (b.payments || [])) {
      if (!p.due_date) continue;
      await env.DB.prepare(
        "INSERT INTO payments (user_id, subscription_id, due_date, amount, currency) VALUES (?,?,?,?,?)"
      ).bind(uid, id, p.due_date, p.amount || 0, p.currency || "GTQ").run();
    }
    await recomputeManualDue(env, id);
    return json({ ok: true });
  }

  // ---- Agregar un pago manual ----
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/payments$/)) && method === "POST") {
    const id = Number(m[1]);
    if (!(await ownedSub(env, id, uid))) return json({ error: "No existe" }, 404);
    const b = await request.json();
    await env.DB.prepare(
      "INSERT INTO payments (user_id, subscription_id, due_date, amount, currency) VALUES (?,?,?,?,?)"
    ).bind(uid, id, b.due_date, b.amount || 0, b.currency || "GTQ").run();
    await recomputeManualDue(env, id);
    return json({ ok: true });
  }

  // ---- Pagos individuales (verificando dueño) ----
  if ((m = path.match(/^\/api\/payments\/(\d+)$/)) && method === "DELETE") {
    const pid = Number(m[1]);
    const p = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND user_id=?").bind(pid, uid).first();
    if (!p) return json({ error: "No existe" }, 404);
    await env.DB.prepare("DELETE FROM payments WHERE id=?").bind(pid).run();
    await recomputeManualDue(env, p.subscription_id);
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/payments\/(\d+)\/pay$/)) && method === "POST") {
    const pid = Number(m[1]);
    const p = await env.DB.prepare("SELECT * FROM payments WHERE id=? AND user_id=?").bind(pid, uid).first();
    if (!p) return json({ error: "No existe" }, 404);
    const b = await request.json().catch(() => ({}));
    const paid = b.paid === false ? 0 : 1;
    await env.DB.prepare("UPDATE payments SET paid=?, paid_date=? WHERE id=?").bind(paid, paid ? todayISO() : null, pid).run();
    await recomputeManualDue(env, p.subscription_id);
    return json({ ok: true });
  }

  return json({ error: "Ruta no encontrada" }, 404);
}

/* --------------------------- recordatorios (cron) -------------------------- */
async function twilioSend(env, To, From, body) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN) return { ok: false, error: "Faltan credenciales de Twilio (TWILIO_SID/TWILIO_TOKEN)." };
  if (!From || !To) return { ok: false, error: "Falta el número de origen o destino." };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`;
  const form = new URLSearchParams({ To, From, Body: body });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (res.ok) return { ok: true };
  let detail = "";
  try { const j = await res.json(); detail = j.message || JSON.stringify(j); } catch (e) {}
  return { ok: false, error: `Twilio (${res.status}): ${detail}` };
}
async function sendSMS(env, to, body) { return twilioSend(env, to, env.TWILIO_FROM, body); }
async function sendWhatsApp(env, to, body) {
  const from = env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
  return twilioSend(env, `whatsapp:${to}`, from, body);
}

async function runReminders(env) {
  const today = todayISO();
  const { results: users } = await env.DB.prepare("SELECT id FROM users").all();
  for (const u of users) {
    const settings = await readSettings(env, u.id);
    const defDays = parseInt(settings.reminder_days || "3", 10);
    const phone = settings.notify_phone;
    const channel = settings.notify_channel || "app";
    const { results: subs } = await env.DB.prepare(
      "SELECT * FROM subscriptions WHERE user_id=? AND active=1 AND next_due_date IS NOT NULL"
    ).bind(u.id).all();

    const due = [];
    for (const s of subs) {
      if (s.notify === 0) continue;
      const rd = s.reminder_days ?? defDays;
      const d = daysBetween(today, s.next_due_date);
      if (d <= rd && s.last_reminded !== s.next_due_date) due.push(s);
    }
    if (!due.length) continue;

    if ((channel === "sms" || channel === "whatsapp") && phone) {
      for (const s of due) {
        const d = daysBetween(today, s.next_due_date);
        const cuando = d < 0 ? `VENCIDO hace ${-d} día(s)` : d === 0 ? "vence HOY" : `vence en ${d} día(s)`;
        const body = `🔔 Recordatorio de pago: ${s.name} ${cuando} (${s.currency} ${s.amount}). Fecha: ${s.next_due_date}.`;
        if (channel === "whatsapp") await sendWhatsApp(env, phone, body);
        else await sendSMS(env, phone, body);
      }
    }
    for (const s of due) {
      await env.DB.prepare("UPDATE subscriptions SET last_reminded=? WHERE id=?").bind(s.next_due_date, s.id).run();
    }
  }
}

/* --------------------------------- router ---------------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path.startsWith("/api/")) {
      try {
        // Rutas públicas (status / setup / login)
        const authResp = await handleAuth(request, env, path, method);
        if (authResp) return authResp;

        // El resto requiere sesión válida
        const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const session = await verifyToken(env, bearer);
        if (!session) return json({ error: "No autorizado" }, 401);

        return await handleApi(request, env, path, method, session.uid);
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500);
      }
    }

    // Archivos estáticos del frontend
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
