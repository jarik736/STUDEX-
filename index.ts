// STUDEX: серверная часть. Одна функция принимает действия от Mini App.
// Секреты (BOT_TOKEN) хранятся только в Supabase. SUPABASE_URL и SERVICE_ROLE_KEY подставляются автоматически.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-init-data, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Err extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}
// deno-lint-ignore no-explicit-any
type Any = any;
type U = { id: string; number: number; tg_id: number; role: string; blocked: boolean };

const CATS = ["Рефераты и доклады", "Конспекты", "Чертежи и схемы", "Курсовые", "Контрольные и тесты", "Презентации"];
const TYPES = ["Объяснить тему", "Проверить и дать замечания", "Консультация", "Образец для ознакомления", "Помощь с оформлением"];
const TERMS = ["Сегодня", "3 дня", "Неделя", "Месяц"];
const CONTACT = /(\+?\d[\d\s\-()]{8,})|@\w{3,}|t\.me|https?:\/\//i;
const FILE_EXT = /\.(pdf|docx?|pptx?|xlsx?|txt|png|jpe?g|webp|dwg|dxf|zip)$/i;
const FILE_MAX = 10 * 1024 * 1024; // 10 МБ
const FILE_TTL_DAYS = 7; // файлы удаляются через 7 дней после закрытия заказа
// Общий объём всех файлов. Бесплатный лимит Supabase 1 ГБ, оставляем запас на недозагруженные файлы.
const STORAGE_LIMIT = Number(Deno.env.get("STORAGE_LIMIT_MB") ?? 900) * 1024 * 1024;
const MIME: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const STN = [
  "Согласование суммы", "Сумма предложена", "Ожидает оплаты", "Оплата сообщена", "В работе",
  "На проверке у администратора", "Одобрено · ждёт покупателя", "Выполнен", "Отменён",
];
const MOVES: Record<string, number[][]> = {
  buyer: [[0, 8], [1, 2], [1, 8], [2, 3], [2, 8], [6, 7]],
  seller: [[3, 4], [4, 5]],
  admin: [[5, 6], [5, 4]],
};
const fee = (a: number) => Math.round(a * 20) / 100;
const isAdmin = (u: U) => u.role === "admin" || u.role === "director";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Проверка данных Telegram (initData) ----------
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function verifyInitData(initData: string): Promise<{ id: number } | null> {
  if (!initData || !BOT) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac("WebAppData", BOT);
  const sig = hex(await hmac(secret, check));
  let diff = sig.length ^ hash.length;
  for (let i = 0; i < Math.min(sig.length, hash.length); i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  try {
    const user = JSON.parse(p.get("user") ?? "null");
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}
async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(d));
}

// ---------- Помощники ----------
async function getUser(tg: number): Promise<U | null> {
  const { data } = await db.from("users").select("*").eq("tg_id", tg).maybeSingle();
  return data as U | null;
}
async function register(tg: number, code?: string): Promise<U> {
  let hash: string | null = null;
  if (code) {
    const c = String(code).trim().toUpperCase();
    if (![25, 50, 75].includes(c.length) || !/^[A-Z2-9]+$/.test(c)) throw new Err("bad_code");
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await db.from("code_attempts").select("*", { count: "exact", head: true })
      .eq("tg_id", tg).gte("created_at", since);
    if ((count ?? 0) >= 10) throw new Err("rate_limited", 429);
    await db.from("code_attempts").insert({ tg_id: tg });
    hash = await sha256hex(c);
  }
  const { data, error } = await db.rpc("register_user", { p_tg: tg, p_hash: hash });
  if (error) {
    if (String(error.message).includes("bad_code")) throw new Err("bad_code");
    throw error;
  }
  return data as U;
}
async function audit(actor: U, action: string, details = "") {
  await db.from("audit_log").insert({ actor_id: actor.id, action, details });
}
async function notify(ids: string[], text: string) {
  if (!ids.length) return;
  await db.from("notifications").insert(ids.map((id) => ({ user_id: id, body: text })));
  const { data } = await db.from("users").select("tg_id").in("id", ids);
  if (!BOT) return;
  await Promise.allSettled((data ?? []).map((r: Any) =>
    fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: r.tg_id, text: `STUDEX: ${text}` }),
    })
  ));
}
async function adminIds(): Promise<string[]> {
  const { data } = await db.from("users").select("id").in("role", ["admin", "director"]).eq("blocked", false);
  return (data ?? []).map((x: Any) => x.id);
}
async function sysMsg(order_id: number, body: string) {
  await db.from("messages").insert({ order_id, kind: "system", body });
}
async function getOrder(id: number): Promise<Any> {
  const { data } = await db.from("orders").select("*").eq("id", Number(id)).maybeSingle();
  if (!data) throw new Err("not_found", 404);
  return data;
}
const sum = (r: Any, f = "amount") => (r.data ?? []).reduce((x: number, y: Any) => x + Number(y[f]), 0);
async function debtOf(sellerId: string) {
  const a = await db.from("ledger").select("amount").eq("user_id", sellerId).eq("kind", "commission");
  const b = await db.from("cash_payments").select("amount").eq("seller_id", sellerId);
  return sum(a) - sum(b);
}
async function createOrder(o: { title: string; category: string; buyer_id: string; seller_id: string }) {
  const { data, error } = await db.from("orders").insert(o).select().single();
  if (error) throw error;
  await db.from("order_status_history").insert({ order_id: data.id, status: 0, actor_id: o.buyer_id });
  await sysMsg(data.id, "Заказ создан. Продавец назовёт сумму.");
  await notify([o.seller_id], `Новый заказ №${data.id}`);
  return data;
}
async function complete(o: Any) {
  const amount = Number(o.amount);
  await db.from("ledger").upsert([
    { order_id: o.id, kind: "buyer_spent", user_id: o.buyer_id, amount },
    { order_id: o.id, kind: "seller_earned", user_id: o.seller_id, amount: amount - fee(amount) },
    { order_id: o.id, kind: "commission", user_id: o.seller_id, amount: fee(amount) },
  ], { onConflict: "order_id,kind", ignoreDuplicates: true });
  const { data: s } = await db.from("users").select("number").eq("id", o.seller_id).single();
  const debt = await debtOf(o.seller_id);
  await notify(
    await adminIds(),
    `Заказ №${o.id} выполнен. Продавец №${s?.number} должен платформе ${fee(amount)} BYN за этот заказ. Общий долг продавца: ${Math.max(debt, 0)} BYN`,
  );
}
async function move(o: Any, to: number, actor: U) {
  const { data } = await db.from("orders")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", o.id).eq("status", o.status).select().maybeSingle();
  if (!data) throw new Err("conflict", 409);
  await db.from("order_status_history").insert({ order_id: o.id, status: to, actor_id: actor.id });
  await sysMsg(o.id, STN[to]);
  if (to === 7) await complete(data);
  const n = `по заказу №${o.id}`;
  if (to === 2) await notify([o.seller_id], `Покупатель принял сумму ${n}`);
  if (to === 3) await notify([o.seller_id], `Покупатель сообщил об оплате ${n}`);
  if (to === 4 && o.status === 3) await notify([o.buyer_id], `Продавец подтвердил получение перевода ${n}`);
  if (to === 4 && o.status === 5) await notify([o.seller_id], `Заказ №${o.id} возвращён на доработку`);
  if (to === 5) await notify(await adminIds(), `Заказ №${o.id} ждёт проверки`);
  if (to === 6) {
    await notify([o.buyer_id], `Администратор одобрил заказ №${o.id}. Подтвердите получение`);
    await notify([o.seller_id], `Заказ №${o.id} одобрен, ждём подтверждения покупателя`);
  }
  if (to === 8) await notify([o.buyer_id, o.seller_id], `Заказ №${o.id} отменён`);
}
function text(v: unknown, min: number, max: number, field: string) {
  const s = String(v ?? "").trim();
  if (s.length < min || s.length > max) throw new Err("bad_" + field);
  if (CONTACT.test(s)) throw new Err("contacts");
  return s;
}

// Автоматическая очистка хранилища. Вызывается при каждой загрузке нового файла (need = его размер).
// 1) Удаляются файлы заказов, закрытых более FILE_TTL_DAYS дней назад.
// 2) Если новому файлу не хватает места (общий лимит STORAGE_LIMIT), удаляются самые старые файлы:
//    сначала из закрытых заказов, и только если их мало, из открытых.
async function dropFiles(rows: Any[]) {
  for (const c of chunks(rows, 100)) {
    await db.storage.from("files").remove(c.map((m) => m.file_path));
    await db.from("messages").update({ file_deleted: true, file_path: null }).in("id", c.map((m) => m.id));
  }
}
async function cleanup(need = 0) {
  const cutoff = new Date(Date.now() - FILE_TTL_DAYS * 86400_000).toISOString();
  const { data: old } = await db.from("orders").select("id").in("status", [7, 8]).lt("updated_at", cutoff).limit(200);
  if (old && old.length) {
    const ms = await all((a, b) => db.from("messages").select("id,file_path")
      .in("order_id", old.map((o: Any) => o.id)).eq("file_deleted", false).not("file_path", "is", null).order("id").range(a, b));
    await dropFiles(ms);
  }
  const live = await all((a, b) => db.from("messages").select("id,order_id,file_path,file_size")
    .eq("file_deleted", false).not("file_path", "is", null).order("id").range(a, b));
  let total = live.reduce((t: number, m: Any) => t + Number(m.file_size ?? 0), 0);
  if (total + need <= STORAGE_LIMIT) return;
  const closed = new Set<number>();
  for (const c of chunks([...new Set(live.map((m: Any) => m.order_id))] as number[], 100)) {
    const { data } = await db.from("orders").select("id").in("id", c).gte("status", 7);
    for (const o of data ?? []) closed.add(o.id);
  }
  const queue = [...live.filter((m: Any) => closed.has(m.order_id)), ...live.filter((m: Any) => !closed.has(m.order_id))];
  const victims: Any[] = [];
  for (const m of queue) {
    if (total + need <= STORAGE_LIMIT) break;
    victims.push(m);
    total -= Number(m.file_size ?? 0);
  }
  await dropFiles(victims);
}

// ---------- Действия ----------
const handlers: Record<string, (u: U, b: Any) => Promise<Any>> = {
  async offer_new(u, b) {
    if (u.role !== "seller") throw new Err("forbidden", 403);
    if (!CATS.includes(b.category)) throw new Err("bad_category");
    const { error } = await db.from("offers").insert({
      seller_id: u.id,
      title: text(b.title, 5, 120, "title"),
      category: b.category,
      description: text(b.description, 10, 2000, "description"),
      term: TERMS.includes(b.term) || /^\d+ д/.test(String(b.term)) ? String(b.term) : "1 день",
      format: ["Чат", "PDF", "DOCX", "Чат + файл", "PPTX"].includes(b.format) ? b.format : "Чат",
    });
    if (error) throw error;
  },
  async order_new(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    const { data: of } = await db.from("offers").select("*").eq("id", Number(b.offer)).eq("hidden", false).maybeSingle();
    if (!of) throw new Err("not_found", 404);
    const { data: s } = await db.from("users").select("blocked").eq("id", of.seller_id).single();
    if (s?.blocked) throw new Err("not_found", 404);
    const o = await createOrder({ title: of.title, category: of.category, buyer_id: u.id, seller_id: of.seller_id });
    return { id: o.id };
  },
  async ad_new(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    if (!CATS.includes(b.category) || !TYPES.includes(b.type) || !TERMS.includes(b.term)) throw new Err("bad_request");
    const { error } = await db.from("ads").insert({
      buyer_id: u.id,
      title: text(b.title, 5, 120, "title"),
      category: b.category,
      description: text(b.description, 20, 2000, "description"),
      term: b.term,
      type: b.type,
    });
    if (error) throw error;
  },
  async ad_respond(u, b) {
    if (u.role !== "seller") throw new Err("forbidden", 403);
    const { data: ad } = await db.from("ads").select("*").eq("id", Number(b.ad)).eq("status", "open").eq("hidden", false).maybeSingle();
    if (!ad) throw new Err("not_found", 404);
    await db.from("ad_responses").upsert({ ad_id: ad.id, seller_id: u.id }, { onConflict: "ad_id,seller_id", ignoreDuplicates: true });
    await notify([ad.buyer_id], "Новый отклик на ваше объявление");
  },
  async ad_pick(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    const { data: ad } = await db.from("ads").select("*").eq("id", Number(b.ad)).eq("buyer_id", u.id).eq("status", "open").maybeSingle();
    if (!ad) throw new Err("not_found", 404);
    const { data: s } = await db.from("users").select("id").eq("number", Number(b.seller)).eq("role", "seller").eq("blocked", false).maybeSingle();
    if (!s) throw new Err("not_found", 404);
    const { data: r } = await db.from("ad_responses").select("ad_id").eq("ad_id", ad.id).eq("seller_id", s.id).maybeSingle();
    if (!r) throw new Err("forbidden", 403);
    const { data: closed } = await db.from("ads").update({ status: "closed" }).eq("id", ad.id).eq("status", "open").select().maybeSingle();
    if (!closed) throw new Err("conflict", 409);
    const o = await createOrder({ title: ad.title, category: ad.category, buyer_id: u.id, seller_id: s.id });
    return { id: o.id };
  },
  async propose(u, b) {
    const o = await getOrder(b.order);
    const amount = Number(b.amount);
    if (o.seller_id !== u.id || o.status !== 0 || o.amount_set) throw new Err("forbidden", 403);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Err("bad_amount");
    const { data } = await db.from("orders").update({ amount, amount_set: true, status: 1, updated_at: new Date().toISOString() })
      .eq("id", o.id).eq("status", 0).eq("amount_set", false).select().maybeSingle();
    if (!data) throw new Err("conflict", 409);
    await db.from("order_status_history").insert({ order_id: o.id, status: 1, actor_id: u.id });
    await sysMsg(o.id, "Продавец назвал сумму");
    await notify([o.buyer_id], `Продавец назвал сумму по заказу №${o.id}`);
  },
  async step(u, b) {
    const o = await getOrder(b.order);
    const to = Number(b.to);
    const kind = isAdmin(u) ? "admin" : o.buyer_id === u.id ? "buyer" : o.seller_id === u.id ? "seller" : null;
    if (!kind || !MOVES[kind].some(([f, t]) => f === o.status && t === to)) throw new Err("forbidden", 403);
    await move(o, to, u);
    if (kind === "admin") await audit(u, STN[to], `заказ №${o.id}`);
  },
  async rate(u, b) {
    const o = await getOrder(b.order);
    const r = Number(b.rating);
    if (o.buyer_id !== u.id || o.status !== 7 || o.rating || !(r >= 1 && r <= 5)) throw new Err("forbidden", 403);
    await db.from("orders").update({ rating: Math.round(r) }).eq("id", o.id).is("rating", null);
  },
  async send(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id && o.seller_id !== u.id) throw new Err("forbidden", 403);
    const body = text(b.text, 1, 2000, "message");
    const { data: ins, error } = await db.from("messages").insert({ order_id: o.id, sender_id: u.id, kind: "user", body }).select().single();
    if (error) throw error;
    await notify([o.buyer_id === u.id ? o.seller_id : o.buyer_id], `Новое сообщение в заказе №${o.id}`);
    return { m: [msgOut(ins, o)], light: true };
  },
  // Полное описание предложения или объявления (в списках приходит только начало)
  async item_get(u, b) {
    const table = b.kind === "ad" ? "ads" : "offers";
    const { data, error } = await db.from(table).select("*").eq("id", Number(b.id)).maybeSingle();
    if (error) throw error;
    if (!data) throw new Err("not_found", 404);
    const owner = table === "ads" ? data.buyer_id : data.seller_id;
    if (data.hidden && !isAdmin(u) && owner !== u.id) throw new Err("not_found", 404);
    return { d: data.description, light: true };
  },
  // Лёгкое обновление открытого чата: только новые сообщения и признаки изменения заказа
  async chat_poll(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id && o.seller_id !== u.id) throw new Err("forbidden", 403);
    const { data, error } = await db.from("messages").select("*").eq("order_id", o.id).gt("id", Number(b.after) || 0).order("id").limit(200);
    if (error) throw error;
    return { m: (data ?? []).map((m: Any) => msgOut(m, o)), st: o.status, amt: o.amount === null ? null : Number(o.amount), set: o.amount_set, light: true };
  },
  async file_prepare(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id && o.seller_id !== u.id) throw new Err("forbidden", 403);
    if (o.status >= 7) throw new Err("forbidden", 403);
    const name = String(b.name ?? "").replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 100);
    const size = Number(b.size);
    if (!FILE_EXT.test(name) || !(size > 0) || size > FILE_MAX) throw new Err("bad_file");
    if (CONTACT.test(name)) throw new Err("contacts");
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await db.from("messages").select("*", { count: "exact", head: true })
      .eq("sender_id", u.id).not("file_name", "is", null).gte("created_at", since);
    if ((count ?? 0) >= 20) throw new Err("rate_limited", 429);
    try { await cleanup(size); } catch (e) { console.error("cleanup", e); }
    const ext = name.split(".").pop()!.toLowerCase();
    const path = `${o.id}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await db.storage.from("files").createSignedUploadUrl(path);
    if (error || !data) throw error ?? new Error("upload_url");
    return { up: { path, url: data.signedUrl, name }, light: true };
  },
  async file_done(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id && o.seller_id !== u.id) throw new Err("forbidden", 403);
    if (o.status >= 7) throw new Err("forbidden", 403);
    const path = String(b.path ?? "");
    const m = new RegExp(`^${o.id}/([0-9a-f-]{36}\\.[a-z0-9]{2,5})$`).exec(path);
    if (!m) throw new Err("bad_file");
    const name = String(b.name ?? "").replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 100);
    if (!FILE_EXT.test(name) || CONTACT.test(name)) throw new Err("bad_file");
    const { data: ls } = await db.storage.from("files").list(String(o.id), { limit: 5, search: m[1] });
    const f = (ls ?? []).find((x: Any) => x.name === m[1]);
    if (!f) throw new Err("bad_file");
    const size = Number(f.metadata?.size ?? 0);
    if (!(size > 0) || size > FILE_MAX) {
      await db.storage.from("files").remove([path]);
      throw new Err("bad_file");
    }
    const { data: dup } = await db.from("messages").select("id").eq("file_path", path).maybeSingle();
    if (dup) throw new Err("conflict", 409);
    const ext = name.split(".").pop()!.toLowerCase();
    const { data: ins, error: e2 } = await db.from("messages").insert({
      order_id: o.id, sender_id: u.id, kind: "user", body: name,
      file_path: path, file_name: name, file_size: size, file_type: MIME[ext] ?? "application/octet-stream",
    }).select().single();
    if (e2) throw e2;
    await notify([o.buyer_id === u.id ? o.seller_id : o.buyer_id], `Новый файл в заказе №${o.id}`);
    return { m: [msgOut(ins, o)], light: true };
  },
  async file_url(u, b) {
    const { data: m } = await db.from("messages").select("order_id,file_path,file_name,file_type,file_deleted").eq("id", Number(b.msg)).maybeSingle();
    if (!m || !m.file_name) throw new Err("not_found", 404);
    const o = await getOrder(m.order_id);
    const member = o.buyer_id === u.id || o.seller_id === u.id;
    if (!member && !isAdmin(u)) throw new Err("forbidden", 403);
    if (m.file_deleted || !m.file_path) throw new Err("gone", 410);
    // Две ссылки на 10 минут: для просмотра и для скачивания под настоящим именем файла
    const [view, dl] = await Promise.all([
      db.storage.from("files").createSignedUrl(m.file_path, 600),
      db.storage.from("files").createSignedUrl(m.file_path, 600, { download: m.file_name }),
    ]);
    if (view.error || !view.data) throw view.error ?? new Error("signed_url");
    const data = view.data;
    if (!member) await audit(u, "Просмотр файла", `заказ №${o.id}`);
    return { file: { url: data.signedUrl, dl: dl.data?.signedUrl ?? data.signedUrl, name: m.file_name, type: m.file_type }, light: true };
  },
  async users_find(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const q = String(b.q ?? "").replace(/\D/g, "").slice(0, 12);
    if (!q) return { found: [], light: true };
    const { data, error } = await db.rpc("find_users", { q });
    if (error) throw error;
    return { found: (data ?? []).map((x: Any) => ({ n: Number(x.number), r: x.role, bl: x.blocked })), light: true };
  },
  async chat_open(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const o = await getOrder(b.order);
    await audit(u, "Просмотр переписки", `заказ №${o.id}, причина: проверка`);
    return { chat: o.id };
  },
  async complain(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id || o.status !== 6) throw new Err("forbidden", 403);
    const { data: ex } = await db.from("complaints").select("id").eq("order_id", o.id).eq("status", "open").maybeSingle();
    if (ex) return;
    await db.from("complaints").insert({ order_id: o.id, buyer_id: u.id });
    await notify(await adminIds(), `Новая жалоба по заказу №${o.id}`);
  },
  async decide(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const { data: c } = await db.from("complaints").select("*").eq("id", Number(b.id)).eq("status", "open").maybeSingle();
    if (!c) throw new Err("not_found", 404);
    const o = await getOrder(c.order_id);
    const r = String(b.r);
    if (!["b", "s", "x"].includes(r)) throw new Err("bad_request");
    if (r !== "x" && o.status === 6) await move(o, r === "b" ? 8 : 7, u);
    await db.from("complaints").update({ status: "closed", resolution: r }).eq("id", c.id);
    await audit(u, "Решение по жалобе", `заказ №${o.id}: ${r === "b" ? "в пользу покупателя" : r === "s" ? "в пользу продавца" : "закрыта"}`);
  },
  async cash(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new Err("bad_amount");
    const { data: s } = await db.from("users").select("id,number").eq("number", Number(b.seller)).eq("role", "seller").maybeSingle();
    if (!s) throw new Err("not_found", 404);
    await db.from("cash_payments").insert({ seller_id: s.id, amount, admin_id: u.id });
    await audit(u, "Получено наличными", `${amount} BYN от продавца №${s.number}`);
  },
  async block(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const { data: t } = await db.from("users").select("*").eq("number", Number(b.number)).maybeSingle();
    if (!t || t.id === u.id || t.role === "director" || (t.role === "admin" && u.role !== "director")) throw new Err("forbidden", 403);
    await db.from("users").update({ blocked: !t.blocked }).eq("id", t.id);
    await audit(u, t.blocked ? "Разблокирован" : "Заблокирован", `пользователь №${t.number}`);
  },
  async hide(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const m = /^([oa])(\d+)$/.exec(String(b.key));
    if (!m) throw new Err("bad_request");
    const tbl = m[1] === "o" ? "offers" : "ads";
    const { data: r } = await db.from(tbl).select("hidden").eq("id", Number(m[2])).maybeSingle();
    if (!r) throw new Err("not_found", 404);
    await db.from(tbl).update({ hidden: !r.hidden }).eq("id", Number(m[2]));
    await audit(u, r.hidden ? "Показано" : "Скрыто", String(b.key));
  },
};

// ---------- Снимок данных для пользователя ----------
// База отдаёт максимум 1000 строк за запрос и молча обрезает остальное, поэтому большие выборки читаются
// страницами (all), суммы считаются в базе (rpc), а администратор видит окно последних заказов.
const CLOSED_OWN = 100; // сколько закрытых заказов приходит покупателю и продавцу в списках
const CLOSED_WINDOW = 300; // сколько закрытых заказов видит администратор в списках; остальные находятся поиском по номеру

async function all(q: (a: number, b: number) => PromiseLike<Any>): Promise<Any[]> {
  const out: Any[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
function chunks<T>(a: T[], n: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n));
  return r;
}
async function usersByIds(ids: string[]): Promise<Map<string, Any>> {
  const m = new Map<string, Any>();
  const parts = await Promise.all(chunks([...new Set(ids)], 100).map(async (c) => {
    const { data, error } = await db.from("users").select("id,number,role,blocked").in("id", c);
    if (error) throw error;
    return data ?? [];
  }));
  for (const p of parts) for (const x of p) m.set(x.id, x);
  return m;
}

async function shortHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cut = (t: string) => (t.length > 120 ? t.slice(0, 120) + "…" : t);

// Сообщение в том виде, в каком его получает приложение (i нужен для дозагрузки только новых сообщений)
function msgOut(m: Any, o: Any) {
  return {
    i: m.id,
    w: m.kind === "system" ? "x" : m.sender_id === o.buyer_id ? "b" : "s", t: m.body, at: m.created_at,
    ...(m.file_name ? { f: { id: m.id, n: m.file_name, s: Number(m.file_size ?? 0), t: m.file_type, gone: !!m.file_deleted } } : {}),
  };
}

async function snapshot(u: U, chatOrder?: number, findOrder?: number, have = "") {
  const adm = isAdmin(u);
  const ok = (r: Any): Any => {
    if (r.error) throw r.error;
    return r.data;
  };

  // Этап 1: всё, что не зависит друг от друга, запрашивается одновременно.
  const ordersP: Promise<Any[]> = adm
    ? Promise.all([
      all((a, b) => db.from("orders").select("*").lte("status", 6).order("id", { ascending: false }).range(a, b)),
      (async () => ok(await db.from("orders").select("*").in("status", [7, 8]).order("id", { ascending: false }).limit(CLOSED_WINDOW)))(),
    ]).then(([active, closed]) => [...active, ...(closed ?? [])])
    : Promise.all([
      all((a, b) => db.from("orders").select("*").eq(u.role === "seller" ? "seller_id" : "buyer_id", u.id).lte("status", 6).order("id", { ascending: false }).range(a, b)),
      (async () => ok(await db.from("orders").select("*").eq(u.role === "seller" ? "seller_id" : "buyer_id", u.id).in("status", [7, 8]).order("id", { ascending: false }).limit(CLOSED_OWN)))(),
    ]).then(([active, closed]) => [...active, ...(closed ?? [])]);
  const offersP = (async () => {
    let q = db.from("offers").select("*");
    if (!adm) q = q.eq("hidden", false);
    return ok(await q.order("id", { ascending: false }).limit(500)) ?? [];
  })();
  const adsP = (async () => {
    let q = db.from("ads").select("*").eq("status", "open");
    if (!adm) q = q.eq("hidden", false);
    return ok(await q.order("id", { ascending: false }).limit(300)) ?? [];
  })();
  const adminP = adm ? (async () => {
    const cols = "id,number,role,blocked";
    const [rest, bl, rec, cm, al, t] = await Promise.all([
      all((a, b) => db.from("users").select(cols).neq("role", "buyer").order("number").range(a, b)),
      db.from("users").select(cols).eq("blocked", true).order("number").limit(500),
      db.from("users").select(cols).eq("role", "buyer").order("number", { ascending: false }).limit(100),
      db.from("complaints").select("id,order_id").eq("status", "open").limit(200),
      db.from("audit_log").select("action,details,created_at").order("id", { ascending: false }).limit(100),
      db.rpc("admin_totals"),
    ]);
    return { rest, bl: bl.data ?? [], rec: rec.data ?? [], cm: cm.data ?? [], al: al.data ?? [], t: ok(t) ?? [] };
  })() : Promise.resolve(null);
  const buysP = u.role === "buyer"
    ? (async () => (await db.from("orders").select("*", { count: "exact", head: true }).eq("buyer_id", u.id).eq("status", 7)).count ?? 0)()
    : Promise.resolve(0);
  const [orders0, offs, ads, stR, fnR, nt, lg, adminD, buys]: Any[] = await Promise.all([
    ordersP, offersP, adsP, db.rpc("seller_stats"), db.rpc("seller_fin"),
    (async () => (await db.from("notifications").select("body,created_at").eq("user_id", u.id).order("id", { ascending: false }).limit(50)).data ?? [])(),
    all((a, b) => db.from("ledger").select("*").eq("user_id", u.id).neq("kind", "commission").order("id").range(a, b)),
    adminP, buysP,
  ]);
  const st = ok(stR), fn = ok(fnR);
  const myOrders: Any[] = [...orders0];

  // Заказ, который открыли по номеру или чат которого открыт, добавляется, даже если он вне окна.
  await Promise.all([chatOrder, findOrder].map(async (id) => {
    if (id && !myOrders.some((o) => o.id === id)) {
      const { data: o } = await db.from("orders").select("*").eq("id", id).maybeSingle();
      if (o && (adm || o.buyer_id === u.id || o.seller_id === u.id) && !myOrders.some((x) => x.id === o.id)) myOrders.push(o);
    }
  }));
  myOrders.sort((x, y) => y.id - x.id);

  // Этап 2: отклики, сообщения и номера людей, которые показываются на экране
  const mids = adm ? (chatOrder ? [chatOrder] : []) : myOrders.filter((o) => o.status < 7 || o.id === chatOrder).map((o) => o.id);
  const respP: Promise<Any[]> = Promise.all(chunks(ads.map((a: Any) => a.id), 100).map(async (c) =>
    ok(await db.from("ad_responses").select("ad_id,seller_id").in("ad_id", c)) ?? [])).then((x) => x.flat());
  const msgsP: Promise<Any[]> = Promise.all(chunks(mids, 50).map((c) =>
    all((a, b) => db.from("messages").select("*").in("order_id", c).order("id").range(a, b)))).then((x) => x.flat());
  const [resp, ms, um] = await Promise.all([
    respP, msgsP,
    usersByIds([
      ...myOrders.flatMap((o) => [o.buyer_id, o.seller_id]),
      ...offs.map((o: Any) => o.seller_id),
      ...ads.map((a: Any) => a.buyer_id),
    ]),
  ]);
  const missing = resp.map((r) => r.seller_id).filter((id) => !um.has(id));
  if (missing.length) for (const [k, v] of await usersByIds(missing)) um.set(k, v);
  const num = (id: string): number | undefined => um.get(id)?.number;
  const isBlocked = (id: string) => !!um.get(id)?.blocked;

  // Статистика продавцов и учёт комиссии посчитаны в базе
  const stat = new Map<string, { k: number; rs: number; rc: number }>();
  for (const x of st ?? []) stat.set(x.seller_id, { k: Number(x.sales), rs: Number(x.rsum), rc: Number(x.rcnt) });
  const avg = (id: string) => {
    const s = stat.get(id);
    return s && s.rc ? Math.round((s.rs / s.rc) * 10) / 10 : null;
  };
  const acc: Record<number, number> = {};
  const cs: Record<number, number> = {};
  for (const x of fn ?? []) {
    if (adm || x.seller_id === u.id) {
      acc[x.number] = Number(x.accrued);
      cs[x.number] = Number(x.paid);
    }
  }
  const sc: Record<number, number> = {};
  for (const x of st ?? []) if (adm || x.seller_id === u.id) sc[x.number] = Number(x.sales);

  const offers = offs.filter((o: Any) => adm || !isBlocked(o.seller_id)).map((o: Any) => ({
    id: o.id, t: o.title, c: o.category, d: cut(o.description), ...(o.description.length > 120 ? { dd: 1 } : {}),
    tm: o.term, f: o.format, s: num(o.seller_id),
  }));
  const adsOut = ads.filter((a: Any) => adm || a.buyer_id === u.id || !isBlocked(a.buyer_id)).map((a: Any) => ({
    id: a.id, t: a.title, c: a.category, d: cut(a.description), ...(a.description.length > 120 ? { dd: 1 } : {}),
    tm: a.term, ty: a.type, b: num(a.buyer_id),
    rs: resp.filter((r) => r.ad_id === a.id).map((r) => num(r.seller_id)),
  }));
  // Рейтинги и число продаж приходят отдельной маленькой таблицей, чтобы списки не менялись при каждом заказе
  const rt: Record<number, [number | string, number]> = {};
  for (const x of st ?? []) rt[x.number] = [Number(x.rcnt) ? Math.round((Number(x.rsum) / Number(x.rcnt)) * 10) / 10 : "—", Number(x.sales)];
  // Если у приложения уже есть такие же списки, они не отправляются повторно
  const lh = await shortHash(JSON.stringify([offers, adsOut]));

  // Сообщения: только по незакрытым заказам и по тому чату, который открыт
  const msgs: Record<number, Any[]> = {};
  const byId = new Map<number, Any>(myOrders.map((o) => [o.id, o]));
  for (const m of ms) {
    const o = byId.get(m.order_id);
    if (!o) continue;
    (msgs[m.order_id] ??= []).push(msgOut(m, o));
  }

  // Личный финансовый журнал
  const titles = new Map<number, string>(myOrders.map((o) => [o.id, o.title]));
  const led = lg.map((l: Any) => ({
    o: l.order_id, w: l.kind === "buyer_spent" ? "b" : "s", s: u.number, a: Number(l.amount), t: titles.get(l.order_id) ?? "",
  }));

  // Только для администраторов
  let usersOut: Any[] = [], cmp: Any[] = [], audit: Any[] = [], tot: Any = null;
  const hid: string[] = [];
  if (adm && adminD) {
    const seen = new Map<string, Any>();
    for (const x of [...adminD.rest, ...adminD.bl, ...adminD.rec]) seen.set(x.id, x);
    usersOut = [...seen.values()].sort((x, y) => x.number - y.number);
    cmp = adminD.cm.map((c: Any) => ({ id: c.id, o: c.order_id, open: true }));
    audit = adminD.al.map((a: Any) => ({ t: a.details ? `${a.action}: ${a.details}` : a.action, at: a.created_at }));
    for (const o of offs) if (o.hidden) hid.push("o" + o.id);
    for (const a of ads) if (a.hidden) hid.push("a" + a.id);
    const r = adminD.t[0];
    tot = { n: Number(r?.n ?? 0), d: Number(r?.d ?? 0), c: Number(r?.c ?? 0), sales: Number(r?.sales ?? 0) };
  }

  const sx = u.role === "seller" ? stat.get(u.id) : undefined;
  const stats = {
    buys: Number(buys) || 0,
    sales: sx ? sx.k : 0,
    avg: sx ? avg(u.id) : null,
  };
  return {
    me: { number: u.number, role: u.role },
    users: usersOut.map((x) => ({ n: x.number, r: x.role, bl: x.blocked })),
    admins: u.role === "director" ? usersOut.filter((x) => x.role === "admin").map((x) => ({ n: x.number, bl: x.blocked })) : [],
    ...(lh !== have ? { offers, ads: adsOut } : {}), lh, rt,
    orders: myOrders.map((o) => ({
      id: o.id, t: o.title, c: o.category, b: num(o.buyer_id), s: num(o.seller_id), st: o.status,
      amt: o.amount === null ? null : Number(o.amount), set: o.amount_set, rv: o.rating ?? 0,
    })),
    msgs, led, cs, acc, sc, tot, cmp, audit, hid, stats,
    nt: nt.map((x: Any) => ({ t: x.body, at: x.created_at })),
  };
}

// ---------- Вход ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const tg = await verifyInitData(req.headers.get("x-init-data") ?? "");
    if (!tg) throw new Err("auth", 401);
    let u = await getUser(tg.id);
    if (body.action === "register") u = await register(tg.id, body.code);
    if (!u) {
      if (body.action !== "state") throw new Err("not_registered", 401);
      return json({ state: { me: null } });
    }
    if (u.blocked) throw new Err("blocked", 403);
    let extra: Any = {};
    if (body.action !== "state" && body.action !== "register") {
      const h = handlers[body.action];
      if (!h) throw new Err("unknown");
      extra = (await h(u, body)) ?? {};
    }
    if (extra.light) {
      const { light: _l, ...rest } = extra;
      return json(rest);
    }
    const chat = body.action === "state" ? Number(body.chat) || undefined : extra.chat;
    const find = body.action === "state" ? Number(body.find) || undefined : undefined;
    return json({ ...extra, state: await snapshot(u, chat, find, String(body.lh ?? "")) });
  } catch (e) {
    if (e instanceof Err) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
