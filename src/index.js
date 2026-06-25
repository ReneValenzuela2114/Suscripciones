// Worker: API + servir logos desde R2 + recordatorios diarios (cron).
// Todos los datos se guardan en D1. R2 solo almacena logos subidos.

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

/* ------------------------------- auth (HMAC) ------------------------------- */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function makeToken(env) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 días
  const payload = `${exp}`;
  const sig = await hmac(env.SESSION_SECRET || "dev-secret", payload);
  return `${payload}.${sig}`;
}
async function verifyToken(env, token) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(env.SESSION_SECRET || "dev-secret", payload);
  if (sig !== expected) return false;
  return Number(payload) > Date.now();
}

/* ------------------------------- helpers HTTP ------------------------------ */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

async function readSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = {};
  for (const r of results) s[r.key] = r.value;
  return s;
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

async function getFullState(env) {
  const settings = await readSettings(env);
  const { results: cats } = await env.DB.prepare(
    "SELECT * FROM categories ORDER BY sort_order ASC, id ASC"
  ).all();
  const { results: subs } = await env.DB.prepare(
    "SELECT * FROM subscriptions ORDER BY active DESC, manual_sort DESC, " +
    "CASE WHEN next_due_date IS NULL THEN 1 ELSE 0 END, next_due_date ASC, sort_order ASC, id ASC"
  ).all();

  // Adjuntar pagos de cada suscripción
  const { results: pays } = await env.DB.prepare(
    "SELECT * FROM payments ORDER BY due_date ASC"
  ).all();
  const byId = {};
  for (const s of subs) { s.payments = []; byId[s.id] = s; }
  for (const p of pays) if (byId[p.subscription_id]) byId[p.subscription_id].payments.push(p);

  // Días para vencer
  const today = todayISO();
  for (const s of subs) {
    s.days_until = s.next_due_date ? daysBetween(today, s.next_due_date) : null;
  }

  // Resumen de gasto en la moneda de visualización
  const disp = settings.display_currency || "GTQ";
  const rate = parseFloat(settings.exchange_rate || "7.8"); // GTQ por 1 USD
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
    return 1 / c; // month
  };

  let monthly = 0, paidThisMonth = 0, paidThisYear = 0;
  const ym = today.slice(0, 7), yr = today.slice(0, 4);
  for (const s of subs) {
    if (!s.active) continue;
    if (s.billing_type === "recurring") {
      monthly += conv(s.amount, s.currency) * monthlyFactor(s);
    }
  }
  for (const p of pays) {
    if (!p.paid || !p.paid_date) continue;
    const v = conv(p.amount, p.currency);
    if (p.paid_date.slice(0, 7) === ym) paidThisMonth += v;
    if (p.paid_date.slice(0, 4) === yr) paidThisYear += v;
  }
  // Estimado anual de manuales = pagos no pagados con due_date dentro de 12 meses
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
      ? { name: next.name, date: next.next_due_date, days: next.days_until,
          amount: next.amount, currency: next.currency }
      : null,
    active_count: subs.filter((s) => s.active).length,
  };

  return { settings, categories: cats, subscriptions: subs, summary, today };
}

/* --------------------------------- API ------------------------------------ */
async function handleApi(request, env, path) {
  const method = request.method;
  let m;

  // Login no requiere token
  if (path === "/api/login" && method === "POST") {
    const { password } = await request.json().catch(() => ({}));
    const expected = env.APP_PASSWORD || "1234";
    if (password === expected) return json({ token: await makeToken(env) });
    return json({ error: "Contraseña incorrecta" }, 401);
  }

  // El resto requiere token válido
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!(await verifyToken(env, token))) return json({ error: "No autorizado" }, 401);

  // Estado completo
  if (path === "/api/state" && method === "GET") {
    return json(await getFullState(env));
  }

  // Settings
  if (path === "/api/settings" && method === "PUT") {
    const body = await request.json();
    const allowed = ["display_currency", "exchange_rate", "reminder_days", "notify_phone", "notify_channel", "hero_theme"];
    for (const k of allowed) {
      if (k in body) {
        await env.DB.prepare(
          "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).bind(k, String(body[k])).run();
      }
    }
    return json({ ok: true });
  }

  // Enviar un aviso de prueba ahora mismo
  if (path === "/api/test-notify" && method === "POST") {
    const st = await readSettings(env);
    const phone = (st.notify_phone || "").trim();
    const channel = st.notify_channel || "app";
    if (channel === "app") return json({ ok: false, error: "El canal está en 'App'. Elige WhatsApp o SMS para enviar avisos." }, 400);
    if (!phone) return json({ ok: false, error: "Falta tu número en Ajustes." }, 400);
    const body = "✅ Prueba de tu app de Suscripciones: ¡los recordatorios funcionan! Aquí te avisaré de tus próximos pagos.";
    const r = channel === "whatsapp" ? await sendWhatsApp(env, phone, body) : await sendSMS(env, phone, body);
    if (r.ok) return json({ ok: true });
    return json({ ok: false, error: r.error || "No se pudo enviar." }, 400);
  }

  // Categorías
  if (path === "/api/categories" && method === "POST") {
    const b = await request.json();
    if (!b.name || !b.name.trim()) return json({ error: "Falta el nombre" }, 400);
    const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM categories").first();
    const res = await env.DB.prepare(
      "INSERT INTO categories (name, color, sort_order) VALUES (?,?,?)"
    ).bind(b.name.trim(), b.color || "#6366f1", max.n).run();
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
      if (sets.length) { vals.push(id); await env.DB.prepare(`UPDATE categories SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE subscriptions SET category_id=NULL WHERE category_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM categories WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
  }

  // Crear suscripción
  if (path === "/api/subscriptions" && method === "POST") {
    const b = await request.json();
    let nextDue = b.next_due_date || null;
    if (b.billing_type === "recurring" && nextDue) {
      nextDue = rollForward(nextDue, b.interval_unit || "month", b.interval_count || 1);
    }
    const res = await env.DB.prepare(
      `INSERT INTO subscriptions
       (name, category_id, icon_type, icon_value, color, amount, currency, billing_type,
        interval_unit, interval_count, anchor_date, next_due_date, reminder_days, notify, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      b.name, b.category_id ?? null, b.icon_type || "emoji", b.icon_value || "💳", b.color || "#6366f1",
      b.amount || 0, b.currency || "GTQ", b.billing_type || "recurring",
      b.interval_unit || "month", b.interval_count || 1, b.anchor_date || null,
      b.billing_type === "manual" ? null : nextDue,
      b.reminder_days ?? null, b.notify === 0 ? 0 : 1, b.notes || null
    ).run();
    const id = res.meta.last_row_id;
    // Pagos iniciales para tipo manual
    if (b.billing_type === "manual" && Array.isArray(b.payments)) {
      for (const p of b.payments) {
        await env.DB.prepare(
          "INSERT INTO payments (subscription_id, due_date, amount, currency) VALUES (?,?,?,?)"
        ).bind(id, p.due_date, p.amount ?? b.amount ?? 0, p.currency || b.currency || "GTQ").run();
      }
      await recomputeManualDue(env, id);
    }
    return json({ id });
  }

  // Rutas con id: /api/subscriptions/:id ...
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "PUT") {
      const b = await request.json();
      const fields = ["name","category_id","icon_type","icon_value","color","amount","currency",
        "billing_type","interval_unit","interval_count","anchor_date","next_due_date",
        "reminder_days","notify","notes","active"];
      const sets = [], vals = [];
      for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
      if (sets.length) {
        vals.push(id);
        await env.DB.prepare(`UPDATE subscriptions SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
      }
      if (b.billing_type === "manual") await recomputeManualDue(env, id);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM payments WHERE subscription_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
  }

  // Marcar como pagado el ciclo actual (recurrente) y avanzar la cola
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/pay$/)) && method === "POST") {
    const id = Number(m[1]);
    const s = await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(id).first();
    if (!s) return json({ error: "No existe" }, 404);
    if (s.billing_type === "recurring") {
      const due = s.next_due_date || todayISO();
      await env.DB.prepare(
        "INSERT INTO payments (subscription_id, due_date, amount, currency, paid, paid_date) VALUES (?,?,?,?,1,?)"
      ).bind(id, due, s.amount, s.currency, todayISO()).run();
      const newDue = addInterval(due, s.interval_unit, s.interval_count || 1);
      await env.DB.prepare("UPDATE subscriptions SET next_due_date=?, last_reminded=NULL WHERE id=?")
        .bind(newDue, id).run();
    } else {
      // manual: marcar el próximo pago pendiente
      const p = await env.DB.prepare(
        "SELECT * FROM payments WHERE subscription_id=? AND paid=0 ORDER BY due_date ASC LIMIT 1"
      ).bind(id).first();
      if (p) {
        await env.DB.prepare("UPDATE payments SET paid=1, paid_date=? WHERE id=?")
          .bind(todayISO(), p.id).run();
      }
      await env.DB.prepare("UPDATE subscriptions SET last_reminded=NULL WHERE id=?").bind(id).run();
      await recomputeManualDue(env, id);
    }
    return json({ ok: true });
  }

  // Agregar pago manual a una suscripción
  if ((m = path.match(/^\/api\/subscriptions\/(\d+)\/payments$/)) && method === "POST") {
    const id = Number(m[1]);
    const b = await request.json();
    await env.DB.prepare(
      "INSERT INTO payments (subscription_id, due_date, amount, currency) VALUES (?,?,?,?)"
    ).bind(id, b.due_date, b.amount || 0, b.currency || "GTQ").run();
    await recomputeManualDue(env, id);
    return json({ ok: true });
  }

  // Eliminar un pago
  if ((m = path.match(/^\/api\/payments\/(\d+)$/)) && method === "DELETE") {
    const pid = Number(m[1]);
    const p = await env.DB.prepare("SELECT subscription_id FROM payments WHERE id=?").bind(pid).first();
    await env.DB.prepare("DELETE FROM payments WHERE id=?").bind(pid).run();
    if (p) await recomputeManualDue(env, p.subscription_id);
    return json({ ok: true });
  }

  // Marcar/desmarcar un pago específico
  if ((m = path.match(/^\/api\/payments\/(\d+)\/pay$/)) && method === "POST") {
    const pid = Number(m[1]);
    const b = await request.json().catch(() => ({}));
    const paid = b.paid === false ? 0 : 1;
    await env.DB.prepare("UPDATE payments SET paid=?, paid_date=? WHERE id=?")
      .bind(paid, paid ? todayISO() : null, pid).run();
    const p = await env.DB.prepare("SELECT subscription_id FROM payments WHERE id=?").bind(pid).first();
    if (p) await recomputeManualDue(env, p.subscription_id);
    return json({ ok: true });
  }

  // Reordenar manualmente (drag)
  if (path === "/api/reorder" && method === "POST") {
    const { order } = await request.json();
    let i = 0;
    for (const id of order) {
      await env.DB.prepare("UPDATE subscriptions SET sort_order=?, manual_sort=1 WHERE id=?")
        .bind(i++, id).run();
    }
    return json({ ok: true });
  }
  // Volver a orden automático por fecha
  if (path === "/api/reorder/auto" && method === "POST") {
    await env.DB.prepare("UPDATE subscriptions SET manual_sort=0").run();
    return json({ ok: true });
  }

  // Subir logo a R2
  if (path === "/api/logo" && method === "POST") {
    const ct = request.headers.get("Content-Type") || "image/png";
    const ext = ct.includes("png") ? "png" : ct.includes("svg") ? "svg" :
      ct.includes("webp") ? "webp" : "jpg";
    const key = `logo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: ct } });
    return json({ key, url: `/logo/${key}` });
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
async function sendSMS(env, to, body) {
  return twilioSend(env, to, env.TWILIO_FROM, body);
}
async function sendWhatsApp(env, to, body) {
  // Número del sandbox de WhatsApp por defecto si no se configura otro
  const from = env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
  return twilioSend(env, `whatsapp:${to}`, from, body);
}

async function runReminders(env) {
  const settings = await readSettings(env);
  const defDays = parseInt(settings.reminder_days || "3", 10);
  const phone = settings.notify_phone;
  const channel = settings.notify_channel || "app";
  const today = todayISO();
  const { results: subs } = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE active=1 AND next_due_date IS NOT NULL"
  ).all();

  const due = [];
  for (const s of subs) {
    if (s.notify === 0) continue; // aviso desactivado para esta suscripción
    const rd = s.reminder_days ?? defDays;
    const d = daysBetween(today, s.next_due_date);
    if (d <= rd && s.last_reminded !== s.next_due_date) {
      due.push(s);
    }
  }
  if (!due.length) return;

  if ((channel === "sms" || channel === "whatsapp") && phone) {
    for (const s of due) {
      const d = daysBetween(today, s.next_due_date);
      const cuando = d < 0 ? `VENCIDO hace ${-d} día(s)` : d === 0 ? "vence HOY" : `vence en ${d} día(s)`;
      const body = `🔔 Recordatorio de pago: ${s.name} ${cuando} (${s.currency} ${s.amount}). Fecha: ${s.next_due_date}.`;
      if (channel === "whatsapp") await sendWhatsApp(env, phone, body);
      else await sendSMS(env, phone, body);
    }
  }
  // Marcar como avisado (también si el canal es 'app', para no recontar)
  for (const s of due) {
    await env.DB.prepare("UPDATE subscriptions SET last_reminded=? WHERE id=?")
      .bind(s.next_due_date, s.id).run();
  }
}

/* --------------------------------- router ---------------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }

    if (path.startsWith("/logo/")) {
      const key = decodeURIComponent(path.slice("/logo/".length));
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response("No encontrado", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Resto: archivos estáticos del frontend
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
