'use strict';
// Клиент группового заказа: один код для хоста и гостя. Роль определяет сервер (state.me.isHost).
// Экраны названы по ТЗ: H1–H7 (хост), G1–G8 (гость).
(function () {
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  const $toasts = document.getElementById('toasts');
  const $live = document.getElementById('live');
  const $net = document.getElementById('net');

  // ---------- Утилиты ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rub = (kop) => {
    const v = kop / 100;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v) + ' ₽';
  };
  const plural = (n, a, b, c) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return a;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
    return c;
  };
  const clockText = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const svgi = (d) => `<svg class="ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    users: svgi('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M17 14.2c2.4.2 4 2.1 4 4.8"/>'),
    clock: svgi('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    qr: svgi('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 20h3v-3"/>'),
    gear: svgi('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    lock: svgi('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    check: svgi('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    alert: svgi('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
    info: svgi('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    chat: svgi('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  };

  const ERR = {
    session_locked: 'Корзина заблокирована',
    time_up: 'Время выбора вышло',
    item_unavailable: 'Этого блюда нет в наличии',
    cart_full: 'Достигнут предел сессии',
    forbidden: 'Это действие недоступно',
    cart_empty: 'Корзина пуста',
    bad_state: 'Состояние заказа изменилось, попробуйте ещё раз',
    session_closed: 'Заказ уже закрыт',
    not_found: 'Не найдено',
    bad_request: 'Проверьте введённые данные',
    payment_failed: 'Оплата не прошла. Корзина осталась заблокированной',
    internal: 'Что-то пошло не так. Попробуйте ещё раз',
  };
  const CLOSE_TEXT = {
    cancelled: 'Хост отменил групповой заказ',
    expired: 'Время сессии истекло',
    completed: 'Этот групповой заказ завершён',
  };

  // ---------- Одиночная корзина ----------
  // Пока заказ не стал групповым, выбранные блюда лежат в localStorage: { menuItemId: qty }.
  const loadSolo = () => { try { return JSON.parse(store.get('go:solo') || '{}') || {}; } catch { return {}; } };
  const saveSolo = () => store.set('go:solo', JSON.stringify(S.solo));

  // ---------- Состояние ----------
  const path = location.pathname;
  const S = {
    role: path.startsWith('/j/') ? 'guest' : 'host',
    code: (path.split('/')[2] || '').toUpperCase() || null,
    token: null, ws: null, connected: false, retry: 0,
    menu: null, restaurant: null, st: null, anon: null, fatal: null,
    view: 'menu', tab: 'mine', cat: null, offset: 0,
    fresh: new Map(), draftName: '', sheet: null, warned: null, showInvite: false, trackedPaid: false,
    solo: loadSolo(), transfer: null,
    chat: [], chatOpen: false, chatUnread: 0, chatDraft: '',
  };
  if (S.code) S.token = store.get('go:token:' + S.code);

  const inviteUrl = () => `${location.origin}/j/${S.code}`;
  const soloItems = () => (S.menu || []).filter((m) => m.available && S.solo[m.id] > 0).map((m) => ({ ...m, qty: S.solo[m.id] }));
  const soloUnits = () => soloItems().reduce((a, m) => a + m.qty, 0);
  const soloTotal = () => soloItems().reduce((a, m) => a + m.qty * m.price, 0);
  const dishWord = (n) => plural(n, 'блюдо', 'блюда', 'блюд');
  const me = () => S.st && S.st.me;

  // ---------- Сеть ----------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      setNet(true);
      ws.send(JSON.stringify({ t: 'hello', code: S.code, token: S.token }));
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      setNet(false);
      if (!S.fatal) setTimeout(connect, Math.min(10000, 1000 * 2 ** S.retry++));
    };
  }

  function setNet(ok) {
    S.connected = ok;
    $net.hidden = ok;
    if (S.st) render();
  }

  function send(msg) {
    if (!S.ws || S.ws.readyState !== 1) { toast('Нет связи. Пробуем подключиться…'); return false; }
    S.ws.send(JSON.stringify(msg));
    return true;
  }

  function onMsg(msg) {
    switch (msg.t) {
      case 'anon':
        if (S.role === 'host') { S.fatal = 'host_no_access'; S.ws.close(); return render(); }
        S.anon = msg.preview;
        if (!S.draftName) S.draftName = store.get('go:name') || '';
        return render();
      case 'welcome':
        S.menu = msg.menu;
        S.restaurant = msg.restaurant;
        S.chat = Array.isArray(msg.chat) ? msg.chat : [];
        if (msg.token) { S.token = msg.token; store.set('go:token:' + S.code, msg.token); }
        return;
      case 'chat_msg':
        if (msg.msg) {
          S.chat.push(msg.msg);
          if (S.chat.length > 60) S.chat.shift();
          if (!S.chatOpen && (!me() || msg.msg.pid !== me().id)) S.chatUnread += 1;
          render();
          const feed = document.getElementById('chat-feed');
          if (feed) feed.scrollTop = feed.scrollHeight;
        }
        return;
      case 'state': return onState(msg);
      case 'event': return onEvent(msg);
      case 'kicked': S.fatal = 'kicked'; if (S.ws) S.ws.close(); return render();
      case 'error': return onError(msg);
      default: return undefined;
    }
  }

  function onState(next) {
    const prev = S.st;
    S.offset = next.now - Date.now();
    if (prev) {
      const old = new Map();
      for (const p of prev.participants) for (const it of p.items) old.set(`${p.id}:${it.menuItemId}`, it.qty);
      for (const p of next.participants) {
        if (p.id === next.me.id) continue;
        for (const it of p.items) {
          const k = `${p.id}:${it.menuItemId}`;
          if (old.get(k) !== it.qty) S.fresh.set(k, Date.now());
        }
      }
    }
    if (prev && prev.session.phase !== next.session.phase && !['waiting', 'selecting'].includes(next.session.phase)) closeSheet();
    if (next.session.phase === 'paid' && !next.me.isHost) store.set('go:name', next.me.name);
    S.st = next;
    S.anon = null;
    if (S.transfer && next.me.isHost) { const list = S.transfer; S.transfer = null; transferSolo(list); }
    if (S.showInvite && next.me.isHost) { S.showInvite = false; render(); openInvite(); return; }
    render();
  }

  function onEvent(ev) {
    const text = eventText(ev);
    if (!text) return;
    live(text);
    if (['guest_joined', 'item_added', 'locked', 'unlocked'].includes(ev.kind)) {
      S.chat.push({ sys: true, text, ts: Date.now() });
      if (S.chat.length > 60) S.chat.shift();
      if (S.chatOpen) {
        render();
        const feed = document.getElementById('chat-feed');
        if (feed) feed.scrollTop = feed.scrollHeight;
      }
    }
    if (me() && me().isHost && ['guest_joined', 'item_added', 'item_changed', 'item_removed', 'debt_claimed'].includes(ev.kind)) toast(text);
    if (me() && !me().isHost && ['timer_extended', 'settings_changed'].includes(ev.kind)) toast(text);
  }

  function eventText(ev) {
    const who = ev.forName ? `${ev.by} → ${ev.forName}` : ev.by;
    switch (ev.kind) {
      case 'guest_joined': return `${ev.by} присоединился к заказу`;
      case 'item_added': return `${who}: добавлено «${ev.item}»`;
      case 'item_changed': return `${who}: «${ev.item}» × ${ev.qty}`;
      case 'item_removed': return `${who}: убрано «${ev.item}»`;
      case 'guest_done': return `${ev.by} закончил выбор`;
      case 'debt_claimed': return `${ev.by} отметил, что перевёл свою часть`;
      case 'timer_extended': return `Хост продлил время на ${ev.minutes} мин`;
      case 'settings_changed': return 'Хост изменил настройки заказа';
      case 'locked': return 'Хост заблокировал корзину';
      case 'unlocked': return 'Корзина снова открыта';
      default: return '';
    }
  }

  function onError(msg) {
    const c = msg.code;
    if (c === 'session_not_found' || c === 'session_finished') {
      S.fatal = c;
      if (S.ws) S.ws.close();
      return render();
    }
    if (c === 'limit_exceeded') return openLimit(msg);
    if (!S.st && S.anon) {
      const el = document.getElementById('nerr');
      if (el) el.textContent = c === 'session_full' ? 'В этом заказе уже максимум гостей' : 'Введите имя, не длиннее 24 символов';
      return undefined;
    }
    return toast(ERR[c] || ERR.internal);
  }

  // ---------- Тосты и озвучивание ----------
  // Уведомления висят сверху: под шапкой и под строкой «гости · таймер · сумма», чтобы не закрывать итог.
  // Нижние кнопки и список блюд они не трогают, а тапы пропускают (pointer-events: none).
  const TOAST_MS = 2500;
  function toast(text) {
    const anchor = document.querySelector('.strip') || document.querySelector('.top');
    const below = anchor ? anchor.getBoundingClientRect().bottom : 0; // якорь ушёл вверх при прокрутке → отступ от края экрана
    $toasts.style.top = `calc(env(safe-area-inset-top, 0px) + ${Math.max(0, Math.round(below)) + 8}px)`;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $toasts.appendChild(el);
    while ($toasts.children.length > 2) $toasts.firstChild.remove();
    setTimeout(() => el.classList.add('out'), TOAST_MS - 250);
    setTimeout(() => el.remove(), TOAST_MS);
  }
  let liveLast = 0, livePending = [], liveTimer = null;
  function live(text) { // не чаще раза в 3 секунды, накопленное склеивается
    livePending.push(text);
    const flush = () => { $live.textContent = livePending.join('. '); livePending = []; liveLast = Date.now(); liveTimer = null; };
    const wait = 3000 - (Date.now() - liveLast);
    if (wait <= 0) flush();
    else if (!liveTimer) liveTimer = setTimeout(flush, wait);
  }

  // ---------- Шторки ----------
  let lastFocus = null;
  function openSheet(kind, label, html) {
    lastFocus = document.activeElement;
    S.sheet = kind;
    $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
        <button class="x" data-act="close-sheet" aria-label="Закрыть">×</button>${html}</div>`;
    document.body.classList.add('noscroll');
    const first = $sheet.querySelector('input:not([type=checkbox]), .btn.primary');
    if (first) first.focus();
  }
  function closeSheet() {
    if (!S.sheet) return;
    S.sheet = null;
    $sheet.innerHTML = '';
    document.body.classList.remove('noscroll');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- Рендер: общие куски ----------
  const tipHtml = (text) => `<span class="tip-box"><button type="button" class="tip-q" data-act="tip-toggle" aria-label="Подсказка">?</button><span class="tip-pop" role="tooltip">${esc(text)}</span></span>`;
  const avatar = (p) => `<span class="av" style="background:hsl(${(p.id * 47) % 360} 45% 36%)" aria-hidden="true">${esc([...p.name][0].toUpperCase())}</span>`;
  const mySubtotal = () => { const m = S.st.participants.find((p) => p.id === S.st.me.id); return m ? m.subtotal : 0; };
  const myQty = (mid) => {
    const m = S.st.participants.find((p) => p.id === S.st.me.id);
    const it = m && m.items.find((i) => i.menuItemId === mid);
    return it ? it.qty : 0;
  };

  function stepper(mid, qty, pid, can) {
    const off = can ? '' : ' off" aria-disabled="true';
    return `<div class="step" role="group" aria-label="Количество">
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty - 1}" data-pid="${pid || ''}" aria-label="Убрать одну порцию">−</button>
      <span class="sq">${qty}</span>
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty + 1}" data-pid="${pid || ''}" aria-label="Добавить порцию">+</button></div>`;
  }

  // Счётчик одиночной корзины: те же кнопки, но действие меняет локальную корзину, а не комнату
  const soloStepper = (mid, qty) => `<div class="step" role="group" aria-label="Количество">
      <button class="sb" data-act="solo-set" data-mid="${mid}" data-qty="${qty - 1}" aria-label="Убрать одну порцию">−</button>
      <span class="sq">${qty}</span>
      <button class="sb" data-act="solo-set" data-mid="${mid}" data-qty="${qty + 1}" aria-label="Добавить порцию">+</button></div>`;

  function dishHtml(m, mode) { // mode: { solo } — одиночная корзина, { can } — комната
    const act = !m.available ? '<span class="tag bad">Нет в наличии</span>'
      : mode && mode.solo ? (S.solo[m.id] > 0 ? soloStepper(m.id, S.solo[m.id])
        : `<button class="btn small primary add-solo" data-act="solo-set" data-mid="${m.id}" data-qty="1" aria-label="В корзину: ${esc(m.name)}">+ В корзину</button>`)
      : !mode ? ''
      : myQty(m.id) > 0 ? stepper(m.id, myQty(m.id), '', mode.can)
        : `<button class="sb add${mode.can ? '' : ' off" aria-disabled="true'}" data-act="qty" data-mid="${m.id}" data-qty="1" aria-label="Добавить: ${esc(m.name)}">+</button>`;
    return `<article class="dish${m.available ? '' : ' na'}">
      <div class="dish-main"><h3>${esc(m.name)}</h3>${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
        <p class="meta"><b>${rub(m.price)}</b>${m.weight ? ` · ${esc(m.weight)}` : ''}</p></div>${act}</article>`;
  }

  function menuListHtml(mode) {
    const cats = [...new Set(S.menu.map((m) => m.category))];
    const list = S.cat ? S.menu.filter((m) => m.category === S.cat) : S.menu;
    return `<div class="cats" role="group" aria-label="Категории">
        <button aria-pressed="${!S.cat}" data-act="cat" data-v="">Все</button>
        ${cats.map((c) => `<button aria-pressed="${S.cat === c}" data-act="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <main>${list.map((m) => dishHtml(m, mode)).join('')}</main>`;
  }

  // ---------- H1: меню с кнопкой «Заказать компанией» ----------
  function hostHomeHtml() {
    if (!S.menu) return '<p class="boot">Загрузка меню…</p>';
    const tip = store.get('go:tip') ? '' : '<div class="tip" role="note">Закажите вместе: друзья выберут блюда сами<button data-act="tip-close">Понятно</button></div>';
    return `<header class="top"><div class="top-t"><div class="rest">Меню ресторана</div><h1>${esc(S.restaurant.name)}</h1></div>
        <div class="top-a"><button class="ib" data-act="about-open" aria-label="Как работает совместный заказ">${ICON.info}</button><button class="btn small outline" data-act="group-start">${ICON.users} Заказать компанией</button></div></header>
      ${tip}
      ${menuListHtml({ solo: true })}${soloBarHtml()}`;
  }

  // Плавающая плашка «Моя корзина (N блюд · сумма)»: видна, пока в одиночной корзине что-то есть
  function soloBarHtml() {
    const n = soloUnits();
    if (!n) return '';
    return `<footer class="bar"><div class="bar-in"><button class="btn primary" data-act="solo-open">Моя корзина (${n} ${dishWord(n)} · ${rub(soloTotal())})</button></div></footer>`;
  }

  // ---------- G1: вход по ссылке, ввод имени ----------
  function nameHtml() {
    const a = S.anon;
    return `<section class="hero">
      <p class="eyebrow">${esc(a.restaurant)}</p>
      <h1>${esc(a.hostName)} зовёт вас заказать вместе</h1>
      <form data-form="join" novalidate>
        <label class="f" for="nm">Как вас зовут?</label>
        <input id="nm" type="text" maxlength="24" autocomplete="given-name" autocapitalize="words" placeholder="Например: Алексей (маркетинг) или Маша 🥗" value="${esc(S.draftName)}" required>
        <p class="err" id="nerr" role="alert"></p>
        <button class="btn primary wide" type="submit">Продолжить</button>
        <p class="hint">Регистрация не нужна</p>
      </form></section>`;
  }

  // ---------- Итоговые экраны ----------
  function fatalHtml() {
    const map = {
      kicked: ['Вас исключили из заказа', 'Хост убрал вас из этого группового заказа.'],
      host_no_access: ['Заказ создан на другом устройстве', 'Откройте заказ там, где вы его создали. Друзья могут присоединиться по ссылке.'],
      session_not_found: ['Заказ не найден', 'Проверьте ссылку: возможно, она набрана с ошибкой.'],
    };
    const [title, text] = map[S.fatal] || ['Этот групповой заказ завершён', 'Ссылка устарела или заказ уже закрыт.'];
    return closedBlock(title, text);
  }
  function closedBlock(title, text) {
    return `<section class="hero"><p class="eyebrow">Групповой заказ</p><h1>${esc(title)}</h1>
      <p class="muted" style="margin-bottom:24px">${esc(text)}</p>
      <a class="btn primary wide" style="text-decoration:none" href="/host">Открыть ресторан</a></section>`;
  }

  // ---------- Сессия ----------
  function sessionHtml() {
    const { session: ss, me: m } = S.st;
    if (ss.phase === 'closed') return closedBlock(CLOSE_TEXT[ss.closeReason] || CLOSE_TEXT.completed, 'Можно оформить новый заказ в ресторане.');
    if (ss.phase === 'paid') return m.isHost ? hostPaidHtml() : guestPaidHtml();
    const units = m.isHost ? ss.units : (S.st.participants.find((p) => p.id === m.id) || { items: [] }).items.reduce((a, i) => a + i.qty, 0);
    return `${topHtml()}${stripHtml()}${bannerHtml()}
      <nav class="seg" role="tablist" aria-label="Раздел">
        <button role="tab" aria-selected="${S.view === 'menu'}" data-act="view" data-v="menu">Меню</button>
        <button role="tab" aria-selected="${S.view === 'cart'}" data-act="view" data-v="cart">Корзина${units ? ` · ${units}` : ''}</button></nav>
      ${S.view === 'cart' ? cartHtml() : menuListHtml({ can: m.canEdit && S.connected })}
      ${chatWidgetHtml()}
      ${barHtml()}`;
  }

  function topHtml() {
    const { session: ss, me: m } = S.st;
    const tools = m.isHost
      ? `<div class="top-a"><button class="ib" data-act="invite" aria-label="Пригласить: QR-код и ссылка">${ICON.qr}</button>
         <button class="ib" data-act="settings" aria-label="Настройки заказа">${ICON.gear}</button></div>` : '';
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div>${tools}</header>`;
  }

  function remaining() { return S.st.session.deadlineAt - (Date.now() + S.offset); }

  function stripHtml() {
    const { session: ss, me: m } = S.st;
    const chips = [`<span class="chip">${ICON.users} ${ss.guestCount} ${plural(ss.guestCount, 'гость', 'гостя', 'гостей')}</span>`];
    if (ss.deadlineAt) {
      const up = ss.phase === 'time_up';
      chips.push(`<span class="chip${up ? ' warn' : ''}" data-timer>${ICON.clock}<span>${up ? '00:00' : clockText(remaining())}</span></span>`);
    }
    chips.push(`<span class="chip strong">${rub(ss.total)}</span>`);
    let meter = '';
    if (!m.isHost && ss.limit) {
      const sub = mySubtotal();
      const left = Math.max(0, ss.limit - sub);
      const ratio = Math.min(1, sub / ss.limit);
      chips.push(`<span class="chip${ratio >= 0.8 ? ' warn' : ''}">Лимит: осталось ${rub(left)}</span>`);
      meter = `<div class="meter${ratio >= 0.8 ? ' warn' : ''}" role="progressbar" aria-label="Использовано из лимита" aria-valuemin="0" aria-valuemax="${ss.limit}" aria-valuenow="${Math.min(sub, ss.limit)}"><i style="width:${Math.round(ratio * 100)}%"></i></div>`;
    }
    return `<div class="strip">${chips.join('')}</div>${meter}`;
  }

  function bannerHtml() {
    const { session: ss, me: m } = S.st;
    const out = [];
    if (ss.phase === 'time_up') {
      out.push(`<div class="banner warn" role="status">${ICON.clock}<div><b>Время выбора вышло</b><span>${m.isHost ? 'Гости больше не могут добавлять блюда.' : 'Меню в режиме просмотра, пока хост не продлит время.'}</span></div>
        ${m.isHost ? '<button class="btn small" data-act="extend" data-min="5">+5 мин</button>' : ''}</div>`);
    }
    if (ss.phase === 'locked') {
      out.push(`<div class="banner lock" role="status">${ICON.lock}<div><b>${m.isHost ? 'Корзина заблокирована' : 'Хост оформляет заказ'}</b><span>${m.isHost ? 'Гости видят это и не могут менять заказ.' : 'Изменения закрыты.'}</span></div></div>`);
    }
    if (m.isHost && ss.unavailable > 0 && ss.phase !== 'locked') {
      out.push(`<div class="banner warn" role="status">${ICON.alert}<div><b>Есть недоступные блюда: ${ss.unavailable}</b><span>Замените их до оплаты.</span></div></div>`);
    }
    return out.join('');
  }

  function groupHtml(p, opts) {
    const { session: ss, me: m } = S.st;
    const mine = p.id === m.id;
    const can = m.canEdit && S.connected && (m.isHost || mine);
    const showCtl = (m.isHost || mine);
    const over = ss.limit && !p.isHost && p.subtotal > ss.limit;
    const left = ss.limit && !p.isHost ? ss.limit - p.subtotal : null;
    const sub = over ? '<small class="over">Выше лимита</small>'
      : left != null ? `<small>Осталось ${rub(left)} из ${rub(ss.limit)}</small>` : '';
    const items = p.items.map((it) => {
      const k = `${p.id}:${it.menuItemId}`;
      const age = Date.now() - (S.fresh.get(k) || 0);
      const fresh = age < 1500 ? ` fresh" style="animation-delay:-${age}ms` : '';
      return `<li class="item${showCtl ? '' : ' dim'}${fresh}"><span class="nm">${esc(it.name)}${it.unavailable ? ' <span class="tag bad">Нет в наличии</span>' : ''}<small>${it.qty} × ${rub(it.price)}</small></span>
        <span class="px">${rub(it.qty * it.price)}</span>${showCtl ? stepper(it.menuItemId, it.qty, p.id === m.id ? '' : p.id, can) : ''}</li>`;
    }).join('');
    const kick = m.isHost && !p.isHost && m.canEdit
      ? `<div class="g-foot"><button class="btn small danger" data-act="kick-open" data-pid="${p.id}">Исключить из заказа</button></div>` : '';
    return `<section class="group${mine ? ' mine' : ''}" aria-label="Заказ: ${esc(p.name)}">
      <div class="g-head">${avatar(p)}<div class="g-name"><b>${esc(p.name)}${p.isHost ? ' · хост' : ''}${mine && !p.isHost ? ' (вы)' : ''}</b>${sub}</div>
        ${p.done ? `<span class="done" title="Закончил выбор">${ICON.check}<span class="sr">Закончил выбор</span></span>` : ''}
        <span class="g-sum">${rub(p.subtotal)}</span></div>
      ${p.items.length ? `<ul class="items">${items}</ul>` : `<p class="g-empty">${mine ? 'Вы пока ничего не выбрали' : 'Пока ничего не выбрал'}</p>`}${opts && opts.kick === false ? '' : kick}</section>`;
  }

  function totalsHtml() {
    const ss = S.st.session;
    return `<dl class="totals"><div><dt>Блюда</dt><dd>${rub(ss.total)}</dd></div>
      <div><dt>Доставка</dt><dd>${rub(ss.deliveryFee)}</dd></div>
      ${ss.servicePct ? `<div><dt>Сервисный сбор ${ss.servicePct}%</dt><dd>${rub(ss.serviceFee)}</dd></div>` : ''}
      <div class="grand"><dt>Итого</dt><dd>${rub(ss.grandTotal)}</dd></div></dl>`;
  }

  function cartHtml() {
    const { session: ss, me: m, participants } = S.st;
    if (m.isHost) {
      if (ss.phase === 'waiting') {
        return `<main><div class="empty"><b>Пока никто не присоединился</b>Покажите QR-код друзьям или отправьте ссылку в чат.
          <div style="margin-top:16px"><button class="btn primary" data-act="invite">${ICON.qr} Показать QR</button></div></div>${participants.map((p) => groupHtml(p)).join('')}</main>`;
      }
      return `<main>${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
    }
    const tabs = `<div class="subtabs" role="tablist"><button role="tab" aria-selected="${S.tab === 'mine'}" data-act="tab" data-v="mine">Моё</button>
      <button role="tab" aria-selected="${S.tab === 'all'}" data-act="tab" data-v="all">Все</button></div>`;
    if (S.tab === 'mine') {
      const mineP = participants.find((p) => p.id === m.id);
      return `<main>${tabs}${mineP.items.length ? groupHtml(mineP) : '<div class="empty"><b>В корзине пусто</b>Выберите блюда в меню.</div>'}</main>`;
    }
    return `<main>${tabs}${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
  }

  function barHtml() {
    const { session: ss, me: m } = S.st;
    let inner;
    if (m.isHost) {
      inner = ss.phase === 'locked'
        ? `<button class="btn" data-act="unlock">Разблокировать</button><button class="btn primary" data-act="pay-open">Оплатить · ${rub(ss.grandTotal)}</button>`
        : `<div class="bar-total"><span>Итого с доставкой</span><b>${rub(ss.grandTotal)}</b></div>
           <button class="btn primary" data-act="lock-open"${ss.total ? '' : ' aria-disabled="true"'}>К оплате</button>`;
    } else if (S.view === 'menu') {
      inner = `<button class="btn primary" data-act="view" data-v="cart">Моя корзина · ${rub(mySubtotal())}</button>`;
    } else {
      inner = m.canEdit
        ? `<button class="btn" data-act="view" data-v="menu">В меню</button>
           <button class="btn primary" data-act="done">${m.done ? 'Вернуться к выбору' : 'Готово'}</button>`
        : '<button class="btn primary" data-act="view" data-v="menu">В меню</button>';
    }
    return `<footer class="bar"><div class="bar-in">${inner}</div></footer>`;
  }

  // ---------- H7 / G7: итог и Split Bill ----------
  function hostPaidHtml() {
    const { session: ss, settlement: rows } = S.st;
    const debts = rows.filter((r) => !r.isHost);
    const left = debts.filter((r) => r.status === 'owes').reduce((a, r) => a + r.amount, 0);
    const pill = (r) => {
      const paid = r.status === 'paid';
      const claimed = !paid && r.claimed;
      const label = paid ? 'Переведено' : claimed ? 'Подтвердить' : 'К переводу';
      return `<button class="pill${paid ? ' ok' : claimed ? ' claimed' : ''}" data-act="mark" data-pid="${r.pid}" data-v="${paid ? 'owes' : 'paid'}" aria-pressed="${paid}">${label}</button>`;
    };
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)} · заказ ${esc(ss.code)}</div><h1>${esc(ss.title)}</h1></div></header>
      <section class="final"><div class="sub">Оплачено</div><div class="big">${rub(ss.grandTotal)}</div>
        <div class="sub">Ждём переводов: <b style="color:var(--ink)">${rub(left)}</b></div></section>
      <div class="stack">
        <section class="card payout-card"><label class="f" for="f-payout2">Куда участникам перевести свою часть оплаты? ${tipHtml('Укажите номер телефона по СБП или карту — каждый участник увидит свой точный расчёт и сможет перевести вам деньги в один клик.')}</label>
          <div class="inp-row"><input id="f-payout2" type="text" maxlength="120" autocomplete="off" value="${esc(ss.payout || '')}" placeholder="+7 (999) 000-00-00 (СБП, Т-Банк или Сбер)">
            <button class="btn small" data-act="payout-save">Сохранить</button></div>
          <p class="hint" style="text-align:left;margin-top:8px">${ss.payout ? 'Участники видят эти реквизиты и свою сумму. Данные защищены и доступны только участникам этого заказа.' : 'Укажите номер телефона по СБП — участники увидят его у себя и смогут перевести свою долю в один клик.'}</p></section>
        <ul class="split">${rows.map((r) => `<li><div class="who"><b>${esc(r.name)}${r.isHost ? ' · хост' : ''}</b>
          <small class="muted">блюда ${rub(r.itemsTotal)} + доставка и сервис ${rub(r.feesShare)}</small></div>
          <span class="amt">Доля: ${rub(r.amount)}</span>
          ${r.isHost ? '<span class="tag">Вы оплатили заказ</span>' : `${pill(r)}
          ${r.status === 'owes' && !r.claimed ? `<button class="btn small" data-act="remind" data-pid="${r.pid}">Напомнить</button>` : ''}`}</li>`).join('')}</ul>
        <button class="btn wide" data-act="copy-split">Скопировать расчёт</button>
        ${ss.orderNote ? `<section class="card note-card"><div class="pl">Комментарий к заказу для ресторана</div>
          <div class="pv"><code>${esc(ss.orderNote)}</code><button class="btn small" data-act="copy-note">Копировать</button></div></section>` : ''}
        <button class="btn primary wide" data-act="finish-open">Завершить заказ</button></div>`;
  }

  function guestPaidHtml() {
    const { session: ss, settlement: rows, me: m } = S.st;
    const mine = rows.find((r) => r.pid === m.id);
    const p = S.st.participants.find((x) => x.id === m.id);
    const head = `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div></header>`;
    if (!mine) {
      return `${head}<section class="final"><div class="big">Вы ничего не заказали</div><div class="sub">Переводить ничего не нужно.</div></section>${installLink()}`;
    }
    const done = mine.status === 'paid';
    const sub = done ? 'Хост подтвердил перевод. Спасибо!'
      : mine.claimed ? 'Вы отметили перевод. Ждём подтверждения хоста.' : `К переводу: ${esc(ss.hostName)}`;
    const pay = done ? '' : `<section class="card payout-card"><div class="pl">Куда перевести</div>
        <div class="pv"><b>${ss.payout ? esc(ss.payout) : 'Хост пока не указал реквизиты. Уточните их у него.'}</b></div>
        ${ss.payout ? '<button class="btn wide" data-act="copy-sbp">Скопировать номер для СБП</button>' : ''}
        <button class="btn wide" data-act="copy-amount">Скопировать сумму · ${rub(mine.amount)}</button></section>`;
    const claim = done ? '' : mine.claimed
      ? '<button class="btn wide" disabled>Перевод отмечен, ждём хоста</button>'
      : '<button class="btn primary wide" data-act="claim">Я перевёл</button>';
    return `${head}<section class="final"><div class="sub">Ваша часть</div><div class="big">${rub(mine.amount)}</div>
        <div class="sub">${sub}</div></section>
      <div class="stack">${pay}<section class="group"><ul class="items">
        ${p.items.map((it) => `<li class="item"><span class="nm">${esc(it.name)}<small>${it.qty} × ${rub(it.price)}</small></span><span class="px">${rub(it.qty * it.price)}</span></li>`).join('')}
        <li class="item"><span class="nm">Доставка и сервис (ваша часть)</span><span class="px">${rub(mine.feesShare)}</span></li></ul></section>
        ${claim}</div>${installLink()}`;
  }
  const installLink = () => '<p style="text-align:center"><a class="link" href="/host" data-act="install">Скачать приложение</a></p>';

  // ---------- Шторки ----------
  // Ползунки: лимит 300–10 000 ₽ шагом 100, таймер 5–60 мин шагом 5. Число в поле и ползунок связаны (syncRange).
  const RANGES = {
    'f-limit': { id: 'f-limit-r', min: 300, max: 10000, step: 100, def: 1500, label: 'Лимит на гостя, ползунок', lo: '300 ₽', hi: '10 000 ₽' },
    'f-timer': { id: 'f-timer-r', min: 5, max: 60, step: 5, def: 15, label: 'Время на выбор, ползунок', lo: '5 мин', hi: '60 мин' },
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rangeHtml = (field, value) => {
    const r = RANGES[field];
    const v = clamp(Number(value) || r.def, r.min, r.max);
    return `<input class="range" type="range" id="${r.id}" data-for="${field}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"
        style="--p:${((v - r.min) / (r.max - r.min)) * 100}%" aria-label="${r.label}">
      <div class="range-scale"><span>${r.lo}</span><span>${r.hi}</span></div>`;
  };
  // number -> ползунок (с привязкой к шагу и границам)
  function syncRange(field) {
    const r = RANGES[field];
    const num = document.getElementById(field);
    const rng = document.getElementById(r.id);
    if (!num || !rng) return;
    const v = Number(num.value);
    if (num.value.trim() !== '' && Number.isFinite(v)) rng.value = String(clamp(v, r.min, r.max));
    rng.style.setProperty('--p', `${((Number(rng.value) - r.min) / (r.max - r.min)) * 100}%`);
  }
  const timerBoxHtml = (value) => `<div class="inp"><input id="f-timer" type="number" inputmode="numeric" min="1" max="240" value="${value || ''}" placeholder="15" aria-label="Минут на выбор"><span>мин</span></div>
      ${rangeHtml('f-timer', value)}
      <div class="chips">${[10, 15, 30].map((v) => `<button type="button" data-act="preset" data-for="f-timer" data-v="${v}">${v} мин</button>`).join('')}</div>`;

  const limitTimerFields = (init) => `
    <label class="row"><span>Лимит на гостя ${tipHtml('Максимальная сумма блюд для каждого участника, чтобы общий чек оставался в рамках бюджета.')}</span><input type="checkbox" id="f-limit-on" role="switch" ${init.limit ? 'checked' : ''}></label>
    <div class="sub" id="f-limit-box" ${init.limit ? '' : 'hidden'}>
      <div class="inp"><input id="f-limit" type="number" inputmode="numeric" min="1" max="100000" value="${init.limit || ''}" placeholder="1500" aria-label="Лимит в рублях"><span>₽</span></div>
      ${rangeHtml('f-limit', init.limit)}
      <div class="chips">${[500, 1000, 1500, 2000].map((v) => `<button type="button" data-act="preset" data-for="f-limit" data-v="${v}">${v} ₽</button>`).join('')}</div></div>`;

  function openCreate() {
    openSheet('create', 'Новый групповой заказ', `<h2>Групповой заказ</h2>
      <form data-form="create" novalidate>
        ${soloUnits() ? `<p class="carry" role="status">Уже выбрано: ${soloUnits()} ${dishWord(soloUnits())} · ${rub(soloTotal())}. Перенесём в общую корзину.</p>` : ''}
        <label class="f" for="f-name">Ваше имя ${tipHtml('Это имя увидят друзья в общей корзине и в чате заказа.')}</label>
        <input id="f-name" type="text" maxlength="24" placeholder="Например: Алексей (маркетинг) или Маша 🥗" value="${esc(store.get('go:hostname') || '')}" autocomplete="given-name" required>
        <label class="f" for="f-title" style="margin-top:14px">Название заказа <span class="muted">(необязательно)</span></label>
        <input id="f-title" type="text" maxlength="60" placeholder="Например: Обед в офисе, 5 этаж">
        <div style="margin-top:8px">${limitTimerFields({})}
        <label class="row"><span>Таймер выбора ${tipHtml('Укажите, сколько минут есть у друзей на выбор блюд. Все участники увидят обратный отсчёт.')}</span><input type="checkbox" id="f-timer-on" role="switch"></label>
        <div class="sub" id="f-timer-box" hidden>${timerBoxHtml('')}</div></div>
        <label class="f" for="f-payout" style="margin-top:14px">Куда участникам перевести свою часть оплаты? ${tipHtml('Необязательно заполнять сейчас — реквизиты можно добавить и после оплаты, чтобы каждый легко перевёл свою долю по СБП.')}</label>
        <input id="f-payout" type="text" maxlength="120" autocomplete="off" value="${esc(store.get('go:payout') || '')}" placeholder="+7 (999) 000-00-00 (СБП, Т-Банк или Сбер)">
        <p class="hint" style="text-align:left;margin-top:6px">Укажите номер телефона по СБП или карту. Это необязательно — можно заполнить позже. Ваши данные видны только участникам этого заказа.</p>
        <p class="err" id="ferr" role="alert"></p>
        <div class="acts">
          <button class="btn primary" type="submit" id="f-go">Собрать заказ с друзьями</button>
          <p class="cta-subhint">Ссылка сразу скопируется в буфер обмена. Отправьте её в любой мессенджер — друзья смогут добавлять блюда без регистрации.</p>
        </div></form>`);
  }

  function openOnboarding() {
    openSheet('onboarding', 'Как заказать компанией', `<h2>Заказывайте еду вместе — без путаницы и скриншотов!</h2>
      <p>Соберите общую корзину за 3 простых шага:</p>
      <ol class="steps-list">
        <li><span class="step-num">1</span><div><b>Соберите компанию</b><span>Отправьте ссылку друзьям или коллегам. Каждый добавит любимые блюда сам со своего телефона.</span></div></li>
        <li><span class="step-num">2</span><div><b>Контролируйте процесс</b><span>Вы видите общую корзину в реальном времени, можете задать лимит, таймер и обсудить детали в чате заказа.</span></div></li>
        <li><span class="step-num">3</span><div><b>Оплатите и разделите чек</b><span>Заказ уйдёт в ресторан одной доставкой, а система сама посчитает точную долю каждого участника.</span></div></li>
      </ol>
      <div class="acts"><button class="btn primary" data-act="onboarding-done">Понятно, создать корзину</button></div>`);
  }

  function openAboutWidget() {
    openSheet('about', 'О совместном заказе', `<h2>Как работает совместный заказ?</h2>
      <p>Забудьте про пересылку скриншотов из меню и долгое согласование позиций в мессенджерах. Совместный заказ объединяет всех участников в одном окне.</p>
      <div class="about-box">
        <b>Пример расчёта внутри корзины:</b>
        <ul>
          <li>👤 <b>Алексей:</b> Вок с курицей + Кола — <b>640 ₽</b></li>
          <li>👤 <b>Мария:</b> Салат Цезарь + Лимонад — <b>720 ₽</b></li>
          <li>💳 <b>Итого:</b> 1 360 ₽ (система покажет точную сумму каждому)</li>
        </ul>
      </div>
      <div class="faq-item"><b>Нужно ли друзьям скачивать приложение?</b><span>Нет, всё работает прямо в браузере по ссылке за пару секунд.</span></div>
      <div class="faq-item"><b>Как происходит оплата?</b><span>Организатор оплачивает общий заказ целиком, после чего каждый участник видит свою точную долю и реквизиты СБП для перевода.</span></div>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Понятно</button></div>`);
  }

  function chatWidgetHtml() {
    if (!S.st) return '';
    const myId = me() && me().id;
    if (!S.chatOpen) {
      const badge = S.chatUnread > 0 ? `<span class="chat-badge">${S.chatUnread}</span>` : '';
      return `<button type="button" class="chat-fab" data-act="chat-toggle" aria-label="Открыть чат заказа">${ICON.chat}<span>Чат заказа</span>${badge}</button>`;
    }
    const msgs = S.chat.length
      ? S.chat.map((m) => m.sys
          ? `<div class="chat-sys">${esc(m.text)}</div>`
          : `<div class="chat-msg${m.pid === myId ? ' mine' : ''}"><div class="chat-meta">${esc(m.name)}${m.isHost ? ' · хост' : ''}</div><div>${esc(m.text)}</div></div>`
        ).join('')
      : '<div class="chat-sys">Обсудите здесь общие блюда, соусы или время доставки</div>';
    return `<section class="chat-panel" aria-label="Чат заказа">
      <div class="chat-head"><b>💬 Чат заказа</b><button type="button" class="chat-close" data-act="chat-toggle" aria-label="Свернуть чат">×</button></div>
      <div class="chat-feed" id="chat-feed">${msgs}</div>
      <div class="chat-quick">
        <button type="button" data-act="chat-quick" data-msg="Я добавил своё! 👍">👍 Я добавил!</button>
        <button type="button" data-act="chat-quick" data-msg="Возьмём пиццу или закуски на всех? 🍕">🍕 На всех?</button>
        <button type="button" data-act="chat-quick" data-msg="Подождите 2 минуты, ещё выбираю ⏳">⏳ Подождите 2 мин</button>
      </div>
      <form class="chat-form" data-form="chat">
        <input id="chat-inp" type="text" maxlength="300" placeholder="Написать участникам..." value="${esc(S.chatDraft)}" autocomplete="off">
        <button type="submit" aria-label="Отправить">➤</button>
      </form>
    </section>`;
  }

  // Корзина «для себя»: список, итог и два пути — «Заказать компанией» (превращает корзину в комнату) или оформить себе.
  function openSolo() {
    const items = soloItems();
    if (!items.length) { closeSheet(); return; }
    const r = S.restaurant;
    const total = soloTotal();
    const delivery = r.deliveryFee || 0;
    const service = Math.round((total * (r.servicePct || 0)) / 100);
    openSheet('solo', 'Моя корзина', `<h2>Моя корзина</h2>
      <ul class="items solo-items">${items.map((it) => `<li class="item"><span class="nm">${esc(it.name)}<small>${it.qty} × ${rub(it.price)}</small></span>
        <span class="px">${rub(it.qty * it.price)}</span>${soloStepper(it.id, it.qty)}</li>`).join('')}</ul>
      <dl class="totals"><div><dt>Блюда</dt><dd>${rub(total)}</dd></div><div><dt>Доставка</dt><dd>${rub(delivery)}</dd></div>
        ${service ? `<div><dt>Сервисный сбор ${r.servicePct}%</dt><dd>${rub(service)}</dd></div>` : ''}
        <div class="grand"><dt>Итого</dt><dd>${rub(total + delivery + service)}</dd></div></dl>
      <div class="acts"><button class="btn primary" data-act="create-open">${ICON.users} Заказать компанией</button>
        <button class="btn" data-act="solo-order">Оформить заказ себе</button></div>`);
  }

  function openSoloDone() {
    const r = S.restaurant;
    const total = soloTotal();
    const service = Math.round((total * (r.servicePct || 0)) / 100);
    const grand = total + (r.deliveryFee || 0) + service;
    S.solo = {}; saveSolo();
    openSheet('solo-done', 'Заказ оформлен', `<h2>Заказ оформлен</h2>
      <p>Сумма ${rub(grand)}. Это демо: оплата имитируется, деньги не списываются.</p>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Отлично</button></div>`);
    render();
  }

  // После создания комнаты блюда из одиночной корзины попадают в общую корзину хоста
  function transferSolo(list) {
    list.forEach((x, i) => setTimeout(() => send({ t: 'set_item', menuItemId: x.menuItemId, qty: x.qty }), i * 80));
    const n = list.reduce((a, x) => a + x.qty, 0);
    S.solo = {}; saveSolo();
    toast(`В общую корзину перенесено: ${n} ${dishWord(n)}`);
  }

  function readFields() {
    const out = {};
    const num = (id) => { const v = document.getElementById(id).value.trim(); return v === '' ? NaN : Number(v); };
    out.limitRub = null; out.timerMin = null;
    if (document.getElementById('f-limit-on').checked) {
      out.limitRub = num('f-limit');
      if (!Number.isInteger(out.limitRub) || out.limitRub < 1 || out.limitRub > 100000) return { error: 'Укажите лимит от 1 до 100 000 ₽' };
    }
    const t = document.getElementById('f-timer-on');
    if (t && t.checked) {
      out.timerMin = num('f-timer');
      if (!Number.isInteger(out.timerMin) || out.timerMin < 1 || out.timerMin > 240) return { error: 'Укажите время от 1 до 240 минут' };
    }
    return out;
  }

  async function submitCreate() {
    const err = document.getElementById('ferr');
    const hostName = document.getElementById('f-name').value.trim();
    if (!hostName) { err.textContent = 'Введите ваше имя'; return; }
    const f = readFields();
    if (f.error) { err.textContent = f.error; return; }
    const payoutInfo = document.getElementById('f-payout').value.trim();
    const body = { restaurantId: S.restaurant.id, hostName, limitRub: f.limitRub, timerMin: f.timerMin };
    if (payoutInfo) body.payoutInfo = payoutInfo;
    const title = document.getElementById('f-title').value.trim();
    if (title) body.title = title;
    const btn = document.getElementById('f-go');
    btn.disabled = true; btn.textContent = 'Создаём…';
    try {
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      const { code, hostToken } = await r.json();
      store.set('go:hostname', hostName);
      store.set('go:payout', payoutInfo);
      store.set('go:token:' + code, hostToken);
      const carry = soloItems();
      if (carry.length) S.transfer = carry.map((m) => ({ menuItemId: m.id, qty: m.qty }));
      S.code = code; S.token = hostToken; S.showInvite = true; S.view = 'menu';
      copyText(`${location.origin}/j/${code}`).then((ok) => { if (ok) toast('Ссылка скопирована в буфер обмена'); });
      history.replaceState(null, '', '/host/' + code);
      closeSheet();
      connect();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Создать ссылку';
      err.textContent = e.message === '429' ? 'Слишком много заказов за час, попробуйте позже' : 'Не удалось создать заказ. Проверьте соединение и повторите.';
    }
  }

  // H3: приглашение — QR и ссылка
  function openInvite() {
    const url = inviteUrl();
    let qr;
    try { qr = QR.svg(url, { margin: 2, dark: '#111', light: '#fff', label: 'QR-код со ссылкой на групповой заказ' }); } catch { qr = ''; }
    openSheet('invite', 'Пригласить друзей', `<h2>Пригласите друзей</h2>
      <div class="qr">${qr}</div>
      <div class="link-box"><code dir="ltr">${esc(url)}</code><button class="btn small" data-act="copy-link">Копировать</button></div>
      ${navigator.share ? '<button class="btn wide" data-act="share" style="margin-bottom:12px">Поделиться</button>' : ''}
      <p class="joined" id="joined"></p>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Перейти к меню</button></div>`);
    updateInvite();
    // Экран не гаснет, пока QR на экране, — по возможности.
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(() => {});
  }
  function updateInvite() {
    const el = document.getElementById('joined');
    if (!el || !S.st) return;
    const guests = S.st.participants.filter((p) => !p.isHost);
    el.innerHTML = `Присоединились: ${guests.length}` + (guests.length ? `<small>${guests.map((g) => esc(g.name)).join(', ')}</small>` : '<small>Покажите QR друзьям или отправьте ссылку в чат</small>');
  }

  function openSettings() {
    const ss = S.st.session;
    const timer = ss.deadlineAt
      ? `<p class="row" style="margin:0">Таймер: <span data-timer><span>${ss.phase === 'time_up' ? '00:00' : clockText(remaining())}</span></span></p>
         <div class="chips"><button data-act="extend" data-min="5">+5 мин</button><button data-act="extend" data-min="10">+10 мин</button><button data-act="timer-off">Выключить</button></div>`
      : `<div class="sub">${timerBoxHtml('')}<button class="btn small" data-act="timer-on" style="margin-top:12px">Включить таймер</button></div>`;
    openSheet('settings', 'Настройки заказа', `<h2>Настройки заказа</h2>
      ${limitTimerFields({ limit: ss.limit ? ss.limit / 100 : 0 })}
      <p class="err" id="ferr" role="alert"></p>
      <button class="btn small" data-act="save-limit">Сохранить лимит</button>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">${timer}
      <div class="acts"><button class="btn danger" data-act="cancel-open">Отменить групповой заказ</button></div>`);
  }

  function confirmSheet(kind, title, text, okLabel, okAct, extra) {
    openSheet(kind, title, `<h2>${esc(title)}</h2><p>${text}</p>${extra || ''}
      <div class="acts"><button class="btn primary" data-act="${okAct}">${esc(okLabel)}</button><button class="btn" data-act="close-sheet">Отмена</button></div>`);
  }

  function openLimit(msg) {
    openSheet('limit', 'Лимит превышен', `<h2>Это превысит ваш лимит</h2>
      <p>Лимит на гостя — ${rub(msg.limit)}. Осталось ${rub(msg.remaining)}.</p>
      <div class="acts"><button class="btn primary" data-act="limit-ok">Выбрать другое</button></div>`);
  }

  // ---------- Действия ----------
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
      ta.remove();
      return ok;
    }
  };

  // Телефон из строки реквизитов («+7 999 000-00-00, Т-Банк»), чтобы копировать только номер для СБП
  const phoneOf = (t) => { const m = /\+?\d[\d\s()\-]{8,}\d/.exec(t || ''); return m ? m[0].trim() : null; };
  const payoutLine = () => {
    const ss = S.st.session;
    return ss.payout ? `Куда перевести: ${ss.payout} (${ss.hostName})` : `Перевести нужно: ${ss.hostName}`;
  };
  // Личное сообщение гостю: точная сумма и реквизиты подставляются автоматически
  const remindText = (r) => [
    `${r.name}, привет! Заказ «${S.st.session.title}» оплачен.`,
    `Твоя часть: ${rub(r.amount)} (блюда ${rub(r.itemsTotal)} + доставка и сервис ${rub(r.feesShare)}).`,
    payoutLine(),
  ].join('\n');
  // Общий расчёт для чата: у каждого своя сумма, внизу реквизиты
  const splitText = () => {
    const { session: ss, settlement } = S.st;
    const rows = settlement.filter((r) => !r.isHost);
    return [`Заказ «${ss.title}»: ${rub(ss.grandTotal)}`,
      ...rows.map((r) => `${r.name}: ${rub(r.amount)}${r.status === 'paid' ? ' ✓' : ''}`),
      payoutLine()].join('\n');
  };

  function centerCategory() {
    const el = document.querySelector('.cats [aria-pressed="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function disabledReason() {
    if (!S.connected) return 'Нет связи. Пробуем подключиться…';
    const ph = S.st && S.st.session.phase;
    if (ph === 'locked') return 'Корзина заблокирована';
    if (ph === 'time_up') return 'Время выбора вышло';
    return 'Сейчас это недоступно';
  }

  const ACT = {
    'close-sheet': () => closeSheet(),
    'tip-close': () => { store.set('go:tip', '1'); render(); },
    'create-open': () => openCreate(),
    'group-start': () => {
      if (!store.get('go:onboarded')) openOnboarding();
      else openCreate();
    },
    'onboarding-done': () => {
      store.set('go:onboarded', '1');
      openCreate();
    },
    'about-open': () => openAboutWidget(),
    'tip-toggle': (d, el) => {
      const box = el && el.closest('.tip-box');
      if (box) box.classList.toggle('open');
    },
    'chat-toggle': () => {
      S.chatOpen = !S.chatOpen;
      if (S.chatOpen) S.chatUnread = 0;
      render();
      if (S.chatOpen) {
        const feed = document.getElementById('chat-feed');
        if (feed) feed.scrollTop = feed.scrollHeight;
        document.getElementById('chat-inp')?.focus();
      }
    },
    'chat-quick': (d) => {
      if (d.msg) send({ t: 'chat_send', text: d.msg });
    },
    preset: (d) => { document.getElementById(d.for).value = d.v; syncRange(d.for); },
    cat: (d) => { S.cat = d.v || null; render(); centerCategory(); },
    'solo-set': (d) => {
      const q = clamp(Number(d.qty), 0, 20);
      if (q > 0) S.solo[d.mid] = q; else delete S.solo[d.mid];
      saveSolo();
      render();
      if (S.sheet === 'solo') openSolo();
    },
    'solo-open': () => openSolo(),
    'solo-order': () => openSoloDone(),
    'payout-save': () => {
      const v = document.getElementById('f-payout2').value.trim();
      if (send({ t: 'set_payout', text: v })) { store.set('go:payout', v); toast(v ? 'Реквизиты сохранены' : 'Реквизиты убраны'); }
    },
    'copy-sbp': async () => {
      const text = S.st.session.payout;
      const phone = phoneOf(text);
      toast((await copyText(phone || text)) ? (phone ? 'Номер для СБП скопирован' : 'Реквизиты скопированы') : 'Не удалось скопировать');
    },
    claim: () => { send({ t: 'claim_paid' }); toast('Отметили, что вы перевели'); },
    'copy-note': async () => toast((await copyText(S.st.session.orderNote)) ? 'Пометка скопирована' : 'Не удалось скопировать'),
    view: (d) => { S.view = d.v; render(); window.scrollTo(0, 0); },
    tab: (d) => { S.tab = d.v; render(); },
    qty: (d) => {
      const msg = { t: 'set_item', menuItemId: Number(d.mid), qty: Number(d.qty) };
      if (d.pid) msg.targetId = Number(d.pid);
      send(msg);
    },
    done: () => { send({ t: 'set_done', done: !me().done }); if (!me().done) S.view = 'menu'; },
    'limit-ok': () => { closeSheet(); S.view = 'menu'; render(); },
    invite: () => openInvite(),
    'copy-link': async () => { toast((await copyText(inviteUrl())) ? 'Ссылка скопирована' : 'Не удалось скопировать'); send({ t: 'track', name: 'invite_shared' }); },
    share: () => { navigator.share({ title: S.st.session.title, text: 'Присоединяйтесь к заказу', url: inviteUrl() }).then(() => send({ t: 'track', name: 'invite_shared' })).catch(() => {}); },
    settings: () => openSettings(),
    'save-limit': () => {
      const f = readFields();
      if (f.error) { document.getElementById('ferr').textContent = f.error; return; }
      if (send({ t: 'settings', limitRub: f.limitRub })) { closeSheet(); toast('Лимит сохранён'); }
    },
    extend: (d) => { if (send({ t: 'extend', minutes: Number(d.min) })) toast(`Время продлено на ${d.min} мин`); },
    'timer-off': () => { send({ t: 'settings', timerMin: null }); closeSheet(); },
    'timer-on': () => {
      const v = Number(document.getElementById('f-timer').value);
      if (!Number.isInteger(v) || v < 1 || v > 240) { document.getElementById('ferr').textContent = 'Укажите время от 1 до 240 минут'; return; }
      send({ t: 'settings', timerMin: v }); closeSheet();
    },
    'kick-open': (d) => {
      const p = S.st.participants.find((x) => x.id === Number(d.pid));
      if (p) confirmSheet('kick', `Исключить ${p.name}?`, 'Его блюда будут удалены из общей корзины.', 'Исключить', 'kick', `<input type="hidden" id="kick-pid" value="${p.id}">`);
    },
    kick: () => { send({ t: 'kick', participantId: Number(document.getElementById('kick-pid').value) }); closeSheet(); },
    'lock-open': () => {
      const ss = S.st.session;
      if (!ss.total) return toast(ERR.cart_empty);
      const warn = ss.unavailable ? `<p style="color:var(--danger)"><b>В заказе есть недоступные блюда: ${ss.unavailable}.</b> Лучше заменить их до оплаты.</p>` : '';
      return confirmSheet('lock', 'Заблокировать корзину?', 'Гости больше не смогут менять заказ. Продолжить?', 'Заблокировать и оплатить', 'lock', warn);
    },
    lock: () => { closeSheet(); send({ t: 'lock' }); },
    unlock: () => send({ t: 'unlock' }),
    'pay-open': () => {
      const n = S.st.participants.filter((p) => p.subtotal > 0).length;
      return confirmSheet('pay', 'Оплатить заказ', `Сумма к оплате — <b>${rub(S.st.session.grandTotal)}</b>. В прототипе оплата имитируется: деньги не списываются.<br>Комментарий к заказу для ресторана: <b>[Совместный заказ · ${n} чел.]</b>`, `Оплатить ${rub(S.st.session.grandTotal)}`, 'pay');
    },
    pay: () => { closeSheet(); send({ t: 'pay' }); },
    mark: (d) => send({ t: 'mark_debt', participantId: Number(d.pid), status: d.v }),
    remind: async (d) => {
      const r = S.st.settlement.find((x) => x.pid === Number(d.pid));
      toast((await copyText(remindText(r))) ? 'Текст напоминания скопирован' : 'Не удалось скопировать');
    },
    'copy-split': async () => toast((await copyText(splitText())) ? 'Расчёт скопирован' : 'Не удалось скопировать'),
    'copy-amount': async () => {
      const r = S.st.settlement.find((x) => x.pid === me().id);
      toast((await copyText(String(r.amount / 100))) ? 'Сумма скопирована' : 'Не удалось скопировать');
    },
    'finish-open': () => confirmSheet('finish', 'Завершить заказ?', 'Расчёт перестанет быть доступен гостям по ссылке.', 'Завершить', 'close'),
    'cancel-open': () => confirmSheet('cancel', 'Отменить групповой заказ?', 'Гости увидят, что заказ отменён. Корзина будет потеряна.', 'Отменить заказ', 'close'),
    close: () => { closeSheet(); send({ t: 'close' }); },
    install: () => send({ t: 'track', name: 'guest_app_install_tap' }),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'install') { ACT.install(); return; } // ссылка работает как обычно
    e.preventDefault();
    if (el.getAttribute('aria-disabled') === 'true') {
      toast(el.dataset.act === 'lock-open' ? ERR.cart_empty : disabledReason());
      return;
    }
    if (ACT[act]) ACT[act](el.dataset, el);
  });

  // Включили лимит или таймер: поле сразу получает значение ползунка, чтобы можно было сразу создавать
  function fillDefault(field) {
    const num = document.getElementById(field);
    if (num && num.value.trim() === '') num.value = document.getElementById(RANGES[field].id).value;
    syncRange(field);
  }
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-limit-on') { document.getElementById('f-limit-box').hidden = !e.target.checked; if (e.target.checked) fillDefault('f-limit'); }
    if (e.target.id === 'f-timer-on') { document.getElementById('f-timer-box').hidden = !e.target.checked; if (e.target.checked) fillDefault('f-timer'); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'nm') S.draftName = t.value;
    if (t.id === 'chat-inp') S.chatDraft = t.value;
    if (t.classList && t.classList.contains('range')) { document.getElementById(t.dataset.for).value = t.value; syncRange(t.dataset.for); }
    if (t.id === 'f-limit' || t.id === 'f-timer') syncRange(t.id);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'create') submitCreate();
    if (form.dataset.form === 'chat') {
      const inp = document.getElementById('chat-inp');
      const txt = inp ? inp.value.trim() : '';
      if (txt && send({ t: 'chat_send', text: txt })) {
        S.chatDraft = '';
        if (inp) inp.value = '';
      }
    }
    if (form.dataset.form === 'join') {
      const name = document.getElementById('nm').value.trim();
      if (!name) { document.getElementById('nerr').textContent = 'Введите имя'; return; }
      send({ t: 'join', name });
    }
  });

  // ---------- Рендер и таймер ----------
  // Перерисовка заменяет DOM целиком, поэтому запоминаем горизонтальный скролл категорий
  // и поле ввода в фокусе (иначе реквизиты пропадали бы на полуслове при каждом обновлении).
  function render() {
    const y = window.scrollY;
    const catsLeft = (document.querySelector('.cats') || {}).scrollLeft || 0;
    const ae = document.activeElement;
    const focus = ae && ae.id && $app.contains(ae) && ae.tagName === 'INPUT'
      ? { id: ae.id, value: ae.value, from: ae.selectionStart, to: ae.selectionEnd } : null;
    let html;
    if (S.fatal) html = fatalHtml();
    else if (S.role === 'host' && !S.code) html = hostHomeHtml();
    else if (!S.st) html = S.anon ? nameHtml() : '<p class="boot">Подключаемся…</p>';
    else html = sessionHtml();
    $app.innerHTML = html;
    window.scrollTo(0, y);
    const cats = document.querySelector('.cats');
    if (cats) cats.scrollLeft = catsLeft;
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) { el.value = focus.value; el.focus(); try { el.setSelectionRange(focus.from, focus.to); } catch { /* тип поля без выделения */ } }
    }
    if (S.sheet === 'invite') updateInvite();
    if (S.st && S.st.session.phase === 'paid' && !S.trackedPaid) { S.trackedPaid = true; send({ t: 'track', name: 'split_bill_viewed' }); }
    tickTimers();
  }

  function tickTimers() {
    const ss = S.st && S.st.session;
    if (!ss || !ss.deadlineAt) return;
    const rem = remaining();
    document.querySelectorAll('[data-timer]').forEach((el) => {
      const txt = el.querySelector('span');
      if (txt) txt.textContent = ss.phase === 'time_up' ? '00:00' : clockText(rem);
      el.classList.toggle('warn', ss.phase === 'time_up' || (rem <= 120000 && rem > 0));
    });
    if (ss.phase === 'selecting' && rem <= 120000 && rem > 0 && S.warned !== ss.deadlineAt) {
      S.warned = ss.deadlineAt;
      toast('Осталось 2 минуты');
      live('Осталось 2 минуты');
    }
  }
  setInterval(tickTimers, 1000);

  // ---------- Старт ----------
  render();
  if (S.role === 'host' && !S.code) {
    fetch('/api/active/menu').then((r) => r.json()).then((d) => { S.menu = d.menu; S.restaurant = d.restaurant; render(); })
      .catch(() => { $app.innerHTML = '<p class="boot">Не удалось загрузить меню. Обновите страницу.</p>'; });
  } else if (S.code) {
    connect();
  }
})();
