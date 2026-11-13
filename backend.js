/* STUDEX: связь интерфейса с настоящим сервером (Supabase Edge Function "api").
   Подключается после основного скрипта и заменяет демо-действия на запросы к серверу. */
(function () {
  const C = window.STUDEX || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const INIT = (tg && tg.initData) || '';
  const API = (C.SUPABASE_URL || '') + '/functions/v1/api';
  const RN = { buyer: 'Покупатель', seller: 'Продавец', admin: 'Администратор', director: 'Директор' };
  const ERR = {
    bad_code: 'Неверный код или он уже использован',
    rate_limited: 'Слишком много попыток. Попробуйте позже',
    contacts: 'Обмен контактами запрещён правилами платформы',
    forbidden: 'Это действие вам недоступно',
    blocked: 'Аккаунт заблокирован',
    conflict: 'Данные уже изменились. Попробуйте ещё раз',
    not_found: 'Не найдено',
    auth: 'Откройте приложение через Telegram',
    bad_title: 'Заголовок: от 5 до 120 символов',
    bad_description: 'Описание слишком короткое или длинное',
    bad_amount: 'Введите корректную сумму',
    bad_message: 'Сообщение пустое или слишком длинное',
    bad_file: 'Файл не принят: формат не поддерживается, он больше 10 МБ или не загрузился',
    gone: 'Файл удалён по сроку хранения',
  };
  const errMsg = (e) => ERR[e && e.error] || 'Что-то пошло не так. Попробуйте ещё раз';
  let ME = null, busy = false, sig = '';

  async function call(action, data) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.ANON_KEY, Authorization: 'Bearer ' + C.ANON_KEY, 'x-init-data': INIT },
      body: JSON.stringify(Object.assign({ action }, data || {})),
    });
    const j = await r.json().catch(() => ({ error: 'server' }));
    if (!r.ok || j.error) throw j;
    return j;
  }
  const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);

  function apply(j) {
    const s = j.state;
    if (!s || !s.me) { ME = null; return; }
    ME = s.me;
    const top0 = S.st && S.st[S.st.length - 1];
    const keepId = top0 && (top0.v === 'order' || top0.v === 'chat') ? top0.id : null;
    const keepObj = keepId ? (S.orders || []).find((o) => o.id == keepId) : null;
    S.users = (s.users || []).map((u) => ({ n: u.n, r: RN[u.r], bl: u.bl }));
    P.length = 0;
    (s.offers || []).forEach((o) => P.push(o));
    S.ads = s.ads || [];
    S.orders = s.orders || [];
    if (keepObj && !S.orders.some((o) => o.id == keepObj.id)) S.orders.push(keepObj);
    S.tot = s.tot || null;
    S.acc = s.acc || {};
    S.sc = s.sc || {};
    S.msgs = {};
    Object.keys(s.msgs || {}).forEach((k) => { S.msgs[k] = s.msgs[k].map((m) => m.f ? [m.w, m.t, hm(m.at), { id: m.f.id, n: m.f.n, s: m.f.gone ? 'файл удалён' : fs(m.f.s), t: m.f.t, gone: m.f.gone }] : [m.w, m.t, hm(m.at)]); });
    S.led = s.led || [];
    S.cs = s.cs || {};
    S.cmp = s.cmp || [];
    S.audit = (s.audit || []).map((a) => a.t + ' · ' + hm(a.at));
    S.nt = (s.nt || []).map((x) => ({ h: hm(x.at), t: x.t }));
    S.hid = s.hid || [];
    ADL.length = 0;
    S.ab = {};
    (s.admins || []).forEach((a) => { ADL.push([a.n, 'Администратор №' + a.n]); S.ab[a.n] = a.bl; });
    S.mystats = s.stats || {};
  }
  function enter() {
    S.dir = ME.role === 'director';
    S.role = S.dir ? 'admin' : ME.role;
    S.tab = NAV[S.role][0][0];
    S.st = [];
  }
  async function act(action, data, ok) {
    if (busy) return null;
    busy = true;
    try {
      const j = await call(action, data);
      apply(j);
      if (ok) toast(ok);
      busy = false;
      return j;
    } catch (e) {
      toast(errMsg(e));
      busy = false;
      return null;
    } finally {
      draw();
    }
  }
  const openOrder = (id) => { S.st = [{ v: 'order', id }]; S.tab = 'orders'; };

  // Экран загрузки и ошибок
  const draw1 = draw;
  window.draw = function () {
    if (S.loading || S.fatal) {
      const m = document.getElementById('mn');
      document.getElementById('hd').innerHTML = '';
      document.getElementById('ft').innerHTML = '';
      m.style.padding = '8px 18px';
      m.innerHTML = '<div class="sw">' + cap(80) + '<h1 style="font-size:24px;margin-top:12px">STUDEX</h1><p class="mu" style="margin-top:8px">' + (S.fatal || 'Загрузка…') + '</p></div>';
      return;
    }
    draw1();
  };

  // Убираем демо-элементы
  const strip = (h) => h
    .replace(/<h2>Роль в демо<\/h2>(<button class="chip[^>]*>[^<]*<\/button>)+/g, '')
    .replace(/В демо она ничего не копирует\./g, '');
  ['settings', 'sys'].forEach((k) => { const f = V[k]; V[k] = (...a) => strip(f(...a)); });
  window.setRole = function () {};
  const regDraw0 = regDraw;
  window.regDraw = function () {
    regDraw0();
    document.querySelectorAll('#mn p').forEach((p) => { if (p.textContent.indexOf('Демо') === 0) p.remove(); });
  };

  // Действия через сервер
  window.order = async (pid) => { const j = await act('order_new', { offer: pid }, 'Заказ создан'); if (j) { openOrder(j.id); draw(); } };
  window.publish = async function () {
    const d = S.dr;
    if (!d.t || d.t.trim().length < 5) return toast('Заголовок: минимум 5 символов');
    if (!d.d || d.d.trim().length < 20) return toast('Опишите задачу подробнее: минимум 20 символов');
    if (bad(d.t + ' ' + d.d)) return toast('Контакты в объявлении запрещены');
    if (!d.ok) return toast('Подтвердите условия академической честности');
    const j = await act('ad_new', { title: d.t.trim(), category: d.c || CATS[0][0], description: d.d.trim(), term: d.tm || TM[1], type: d.ty || TY[0] }, 'Объявление опубликовано');
    if (j) { S.dr = {}; S.st = []; S.tab = 'catalog'; S.seg = 'ad'; draw(); }
  };
  window.respond = (id) => act('ad_respond', { ad: id }, 'Отклик отправлен');
  window.pick = async (aid, s) => { const j = await act('ad_pick', { ad: aid, seller: s }, 'Исполнитель выбран'); if (j) { openOrder(j.id); S.tab = 'profile'; draw(); } };
  window.propose = function (id) {
    const v = parseFloat(document.getElementById('am').value);
    if (!(v > 0)) return toast('Введите сумму больше нуля');
    return act('propose', { order: id, amount: v }, 'Сумма отправлена покупателю');
  };
  window.o_ = (id) => act('step', { order: id, to: 8 }, 'Вы отказались от суммы, заказ отменён');
  window.step = (id, st, t) => act('step', { order: id, to: st }, t);
  window.rate = (id, n) => act('rate', { order: id, rating: n }, 'Спасибо за отзыв');
  window.cash = function (n) {
    const v = parseFloat(document.getElementById('cs').value);
    if (!(v > 0)) return toast('Введите сумму больше нуля');
    return act('cash', { seller: n, amount: v }, 'Запись добавлена');
  };
  window.block = (n) => act('block', { number: n }, 'Готово');
  window.hide = (k) => act('hide', { key: k });
  window.complain = (id) => act('complain', { order: id }, 'Жалоба отправлена администратору');
  window.decide = (cid, r) => act('decide', { id: cid, r: r }, 'Решение сохранено');
  window.adminChat = async (id) => { const j = await act('chat_open', { order: id }); if (j) { S.st.push({ v: 'chat', id }); draw(); } };
  window.bulk = async function () {
    if (!S.bc) { S.bc = true; draw(); setTimeout(() => { if (S.bc) { S.bc = false; draw(); } }, 4000); return; }
    S.bc = false;
    for (const o of S.orders.filter((x) => x.st === 5)) {
      try { apply(await call('step', { order: o.id, to: 6 })); } catch (e) { toast(errMsg(e)); break; }
    }
    toast('Заказы утверждены');
    draw();
  };
  const chatRefresh = (id) => {
    const ms = document.getElementById('ms');
    if (ms) { ms.innerHTML = msgs(id, S.role === 'seller' ? 's' : 'b'); document.getElementById('mn').scrollTop = 1e5; }
  };
  window.attach = async function (id, el) {
    const f = el.files && el.files[0];
    el.value = '';
    if (!f || busy) return;
    if (!/\.(pdf|docx?|pptx?|xlsx?|txt|png|jpe?g|webp|dwg|dxf|zip)$/i.test(f.name)) return toast('Этот формат не поддерживается');
    if (f.size > 10485760) return toast('Файл больше 10 МБ');
    if (bad(f.name)) return toast('Уберите контакты из названия файла');
    busy = true;
    toast('Загрузка файла…');
    try {
      const p = (await call('file_prepare', { order: id, name: f.name, size: f.size })).up;
      const fd = new FormData();
      fd.append('cacheControl', '3600');
      fd.append('', f);
      const r = await fetch(p.url, { method: 'PUT', headers: { apikey: C.ANON_KEY, 'x-upsert': 'false' }, body: fd });
      if (!r.ok) { console.error('upload', r.status, await r.text().catch(() => '')); throw { error: 'bad_file' }; }
      apply(await call('file_done', { order: id, path: p.path, name: p.name }));
      chatRefresh(id);
      toast('Файл отправлен');
    } catch (e) { toast(errMsg(e)); }
    busy = false;
  };
  window.pv = async function (id, i) {
    const f = S.msgs[id] && S.msgs[id][i] && S.msgs[id][i][3];
    if (!f) return;
    if (f.gone) return toast('Файл удалён по сроку хранения');
    let file;
    try { file = (await call('file_url', { msg: f.id })).file; } catch (e) { return toast(errMsg(e)); }
    const t = f.t || '';
    let b = '';
    try {
      const blob = await (await fetch(file.url)).blob();
      if (t.startsWith('image/')) b = '<img src="' + URL.createObjectURL(blob) + '" style="max-width:100%;border-radius:12px" alt="">';
      else if (t === 'application/pdf') b = '<iframe src="' + URL.createObjectURL(new Blob([blob], { type: t })) + '" style="width:100%;height:70vh;border:0;border-radius:12px;background:#fff"></iframe>';
      else if (t.startsWith('text/')) b = '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.5">' + esc((await blob.text()).slice(0, 20000)) + '</pre>';
    } catch (e) { /* покажем только кнопку открытия */ }
    if (!b) b = '<div class="card mu">Предпросмотр для этого формата недоступен. Откройте файл в браузере.</div>';
    window.__fu = file.url; window.__fd = file.dl || file.url; window.__fm = f.id; window.__ft = Date.now();
    const e = document.createElement('div');
    e.id = 'pvw';
    e.innerHTML = '<div class="row" style="padding:12px 16px"><button class="rb" aria-label="Закрыть" onclick="document.getElementById(\'pvw\').remove()">' + ic('back') + '</button><b class="sp" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(file.name) + '</b></div><div style="flex:1;overflow:auto;padding:0 16px 20px">' + b + '<button class="btn" style="margin-top:12px" onclick="__fo(\'dl\')">Скачать файл</button><button class="btn" style="margin-top:8px;background:transparent;color:var(--tx,#f5f5f7);border:1px solid rgba(255,255,255,.25)" onclick="__fo(\'open\')">Открыть в браузере</button></div>';
    document.getElementById('app').appendChild(e);
  };
  // Ссылка действует недолго, поэтому перед открытием при необходимости запрашивается новая
  window.__fo = async function (kind) {
    try {
      if (Date.now() - window.__ft > 240000) {
        const fresh = (await call('file_url', { msg: window.__fm })).file;
        window.__fu = fresh.url; window.__fd = fresh.dl || fresh.url; window.__ft = Date.now();
      }
    } catch (e) { return toast(errMsg(e)); }
    const u = kind === 'dl' ? window.__fd : window.__fu;
    if (window.Telegram && Telegram.WebApp && Telegram.WebApp.openLink) Telegram.WebApp.openLink(u); else window.open(u);
  };
  window.send = async function (id) {
    const i = document.getElementById('mi'), t = i.value.trim();
    if (!t) return;
    if (bad(t)) return toast('Обмен контактами запрещён правилами платформы');
    i.value = '';
    try {
      apply(await call('send', { order: id, text: t }));
      const ms = document.getElementById('ms');
      if (ms) { ms.innerHTML = msgs(id, S.role === 'seller' ? 's' : 'b'); document.getElementById('mn').scrollTop = 1e5; }
    } catch (e) { i.value = t; toast(errMsg(e)); }
  };

  // Чат закрытого заказа и старые заказы подгружаются при открытии
  async function loadChat(id) {
    if (!ME || busy) return;
    try {
      apply(await call('state', { chat: id }));
      const top = S.st[S.st.length - 1];
      if (top && top.v === 'chat' && top.id === id) chatRefresh(id);
    } catch (e) { /* повторит ближайший опрос */ }
  }
  const go0 = go;
  window.go = function (v, id) {
    go0(v, id);
    if (v === 'chat' && S.role !== 'admin' && !(S.msgs[id] && S.msgs[id].length)) loadChat(id);
  };
  window.findOrder = async function () {
    const v = +document.getElementById('fo').value;
    if (!(v > 0)) return toast('Введите номер заказа');
    let o = or(v);
    if (!o && !busy) {
      try { apply(await call('state', { find: v })); } catch (e) { return toast(errMsg(e)); }
      o = or(v);
    }
    if (o) go('order', o.id); else toast('Заказ не найден');
  };
  const ulist0 = ulist;
  let findT = 0;
  window.ulist = function () {
    const q = S.uq || '';
    if (q && ME && S.role === 'admin') {
      clearTimeout(findT);
      findT = setTimeout(async () => {
        try {
          const j = await call('users_find', { q });
          let changed = false;
          (j.found || []).forEach((x) => {
            const ex = S.users.find((u) => u.n === x.n);
            if (!ex) { S.users.push({ n: x.n, r: RN[x.r], bl: x.bl }); changed = true; }
          });
          const el = document.getElementById('ul');
          if (changed && el && S.uq === q) el.innerHTML = ulist0();
        } catch (e) { /* остаётся локальный список */ }
      }, 350);
    }
    return ulist0();
  };

  // Регистрация и вход
  window.regGo = async function (m) {
    const g = S.rg;
    if (!g.ok) return toast('Примите правила платформы');
    if (m && [25, 50, 75].indexOf(g.c.trim().length) < 0) return toast('Проверьте код');
    try {
      g.m = 0;
      apply(await call('register', { code: m ? g.c.trim() : null }));
      if (!ME) return toast('Не удалось зарегистрироваться');
      g.done = RN[ME.role] + ' №' + ME.number;
      draw();
    } catch (e) { toast(errMsg(e)); }
  };
  window.regEnter = function () { S.reg = 0; S.rg = null; S.splash = false; enter(); draw(); };

  // Реальные экраны вместо демо-данных
  V.profile = () => {
    const st = S.mystats || {};
    const title = S.dir ? 'Директор' : S.role === 'admin' ? 'Администратор' : S.role === 'seller' ? 'Продавец' : 'Пользователь';
    return '<div style="text-align:center;margin:8px 0 14px"><div class="ic" style="width:96px;height:96px;border-radius:50%;margin:0 auto 10px">' + cap(56) + '</div><h2 style="margin:0">' + title + ' №' + ME.number + '</h2>' + (S.role === 'seller' && st.avg ? '<div class="mu">★ ' + st.avg + ' · ' + st.sales + ' заказов</div>' : '') + '</div>' +
      '<div class="row" style="margin-bottom:12px"><div class="stat"><b>' + (st.buys || 0) + '</b>Покупок</div><div class="stat"><b>' + (st.sales || 0) + '</b>Продаж</div>' + (S.role === 'seller' ? '<div class="stat"><b>' + (st.avg || '—') + '</b>Рейтинг</div>' : '') + '</div>' +
      '<div class="card cl" onclick="go(\'orders\')">Мои заказы</div>' +
      (S.role === 'buyer' ? '<div class="card cl" onclick="go(\'bal\')">Мои расходы: ' + rub(spent()) + '</div><div class="card cl" onclick="go(\'myads\')">Мои объявления</div><div class="card cl" onclick="go(\'fav\')">Избранное: ' + S.fav.size + '</div>' : '') +
      (S.role === 'seller' ? '<div class="card cl" onclick="go(\'myoff\')">Мои предложения</div>' : '') +
      (S.role === 'buyer' ? '<div class="card cl" onclick="S.reg=1;S.rg=null;draw()">У меня есть код</div>' : '') +
      '<div class="card cl" onclick="go(\'about\')">О платформе</div><div class="card cl" onclick="go(\'policy\')">Политика и правила</div>';
  };
  V.myads = () => S.ads.filter((a) => a.b === ME.number).map(cardA).join('') || '<div class="card mu">У вас нет объявлений.</div>';
  V.ad = (id) => {
    const a = ad(id), mine = S.role === 'buyer' && a && a.b === ME.number;
    if (!a) return '<div class="card mu">Объявление недоступно.</div>';
    return '<div class="card"><div class="row"><div class="ic">' + ic(ci(a.c)) + '</div><div class="sp"><b>' + esc(a.t) + '</b><div class="mu">' + a.c + '</div></div></div><p class="mu" style="margin-top:10px">' + esc(a.d) + '</p><div class="row" style="margin-top:10px"><span class="tag">' + a.ty + '</span><span class="tag">Срок: ' + a.tm + '</span></div><p class="mu" style="margin-top:10px">Автор: Покупатель №' + a.b + '</p></div>' +
      (S.role === 'seller' ? (a.rs.indexOf(ME.number) >= 0 ? '<div class="card mu">Вы откликнулись. Ждите решения покупателя.</div>' : '<button class="btn" onclick="respond(' + id + ')">Откликнуться</button>') : '') +
      (mine ? '<h2>Отклики</h2>' + (a.rs.map((s) => '<div class="card row"><div class="ic">' + cap(26) + '</div><div class="sp"><b>Продавец №' + s + '</b></div><button class="chip on" style="margin:0" onclick="pick(' + id + ',' + s + ')">Выбрать</button></div>').join('') || '<div class="card mu">Откликов пока нет.</div>') : '');
  };
  V.finance = () => {
    const n = ME.number, A = accrued(n), C2 = paid(n), D = A - C2;
    return '<div class="card"><div class="mu">Начислено комиссии (20%)</div><div style="font-size:30px;font-weight:700">' + rub(A) + '</div><div class="row mu" style="margin-top:6px"><span>Передано наличными</span><span class="sp"></span>' + rub(C2) + '</div><div class="row" style="margin-top:4px"><b>' + (D >= 0 ? 'Долг перед платформой' : 'Переплата') + '</b><span class="sp"></span><b class="' + (D > 0 ? 'wa' : 'ok') + '">' + rub(Math.abs(D)) + '</b></div></div>' +
      '<div class="card"><div class="mu">Заработано (после комиссии)</div><div style="font-size:26px;font-weight:700">' + rub(earn(n)) + '</div><div class="mu">Деньги вы получили напрямую от покупателей. Это учёт: платформа их не хранит.</div></div>' +
      '<p class="mu" style="margin:0 2px">Комиссия передаётся наличными раз в неделю (пн–вс). Частичная оплата допускается, остаток переносится.</p><h2>Выполненные заказы</h2>' +
      (done().filter((o) => o.s === n).map((o) => '<div class="card row"><span>№' + o.id + '</span><span class="sp"></span><span>' + rub(o.amt) + ' · комиссия ' + rub(fee(o.amt)) + '</span></div>').join('') || '<div class="card mu">Пока нет выполненных заказов.</div>');
  };
  V.admins = () => '<p class="mu" style="margin:4px 2px 10px">Контроль администраторов. Администраторы не видят этот раздел.</p>' +
    (ADL.map((a) => { const bl = (S.ab || {})[a[0]]; return '<div class="card row"><div class="sp"><b>' + a[1] + '</b><div class="mu">' + (bl ? 'Заблокирован' : 'Активен') + '</div></div><button class="chip ' + (bl ? 'on' : '') + '" style="margin:0" onclick="block(' + a[0] + ')">' + (bl ? 'Разблокировать' : 'Заблокировать') + '</button></div>'; }).join('') || '<div class="card mu">Администраторов пока нет.</div>');

  // Предложения продавца
  Object.assign(TT, { myoff: 'Мои предложения', newoff: 'Новое предложение' });
  V.myoff = () => '<button class="btn" style="margin:0 0 12px" onclick="S.od={};go(\'newoff\')">+ Добавить предложение</button>' + (P.filter((p) => p.s === ME.number).map(cardP).join('') || '<div class="card mu">У вас пока нет предложений.</div>');
  V.newoff = () => {
    const d = S.od = S.od || {};
    return '<p class="mu" style="margin:0 2px 12px">Опишите, чем вы можете помочь. Цену вы назовёте в чате заказа.</p>' +
      '<input placeholder="Название" value="' + esc(d.t || '') + '" oninput="S.od.t=this.value">' +
      '<select onchange="S.od.c=this.value">' + CATS.map((c) => '<option ' + (d.c === c[0] ? 'selected' : '') + '>' + c[0] + '</option>').join('') + '</select>' +
      '<select onchange="S.od.f=this.value">' + ['Чат', 'PDF', 'DOCX', 'Чат + файл', 'PPTX'].map((f) => '<option ' + (d.f === f ? 'selected' : '') + '>' + f + '</option>').join('') + '</select>' +
      '<textarea placeholder="Описание: что входит, как проходит работа" oninput="S.od.d=this.value">' + esc(d.d || '') + '</textarea>' +
      '<div class="mu" style="margin-bottom:6px">Срок</div>' + TM.map((t) => '<button class="chip ' + ((d.tm || TM[1]) === t ? 'on' : '') + '" onclick="S.od.tm=\'' + t + '\';draw()">' + t + '</button>').join('') +
      '<button class="btn" onclick="publishOffer()">Опубликовать</button>';
  };
  window.publishOffer = async function () {
    const d = S.od || {};
    if (!d.t || d.t.trim().length < 5) return toast('Название: минимум 5 символов');
    if (!d.d || d.d.trim().length < 10) return toast('Опишите предложение: минимум 10 символов');
    if (bad(d.t + ' ' + d.d)) return toast('Контакты в предложении запрещены');
    const j = await act('offer_new', { title: d.t.trim(), category: d.c || CATS[0][0], description: d.d.trim(), term: d.tm || TM[1], format: d.f || 'Чат' }, 'Предложение опубликовано');
    if (j) { S.od = {}; S.st = [{ v: 'myoff' }]; draw(); }
  };

  // Обновление данных раз в несколько секунд
  const signature = () => JSON.stringify([S.orders.map((o) => [o.id, o.st, o.amt]), S.ads.length, S.nt.length, S.cmp.length, Object.keys(S.msgs).map((k) => S.msgs[k].length)]);
  let tick = 0;
  setInterval(async () => {
    if (!ME || busy || document.hidden || S.reg || S.splash) return;
    const tc = S.st[S.st.length - 1];
    tick++;
    if (!(tc && tc.v === 'chat') && tick % 12) return; // вне чата обновляем раз в минуту, в чате раз в 5 секунд
    try {
      const topc = S.st[S.st.length - 1];
      const j = await call('state', topc && topc.v === 'chat' ? { chat: topc.id } : topc && topc.v === 'order' ? { find: topc.id } : {});
      const before = signature();
      apply(j);
      const top = S.st[S.st.length - 1];
      if (top && top.v === 'chat') {
        const ms = document.getElementById('ms');
        if (ms) ms.innerHTML = msgs(top.id, S.role === 'seller' ? 's' : 'b');
        return;
      }
      const ae = document.activeElement;
      if (signature() !== before && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) && !document.getElementById('pvw')) draw();
    } catch (e) { /* пропускаем, повторим позже */ }
  }, 5000);

  // Запуск
  (async function boot() {
    S.loading = true; S.splash = false; draw();
    if (!INIT || !C.SUPABASE_URL || !C.ANON_KEY) {
      S.loading = false;
      S.fatal = !INIT ? 'Откройте приложение через Telegram, нажав кнопку у бота.' : 'Не заполнен файл config.js (адрес и ключ Supabase).';
      return draw();
    }
    try {
      const j = await call('state', {});
      apply(j);
      S.loading = false;
      if (ME) { S.reg = 0; S.splash = false; enter(); } else { S.splash = true; S.reg = 0; }
    } catch (e) {
      S.loading = false;
      S.fatal = errMsg(e) + '. Обновите страницу.';
    }
    draw();
  })();
})();
