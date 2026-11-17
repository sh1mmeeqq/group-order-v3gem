'use strict';
// Бизнес-логика групповой сессии. Не знает про сеть: принимает вызовы, пишет в БД,
// кидает AppError с кодом. Все деньги — целые копейки.

const crypto = require('node:crypto');

const LIMITS = {
  guests: 30,                  // макс. гостей в сессии (ТЗ, раздел 5)
  units: 100,                  // макс. порций в общей корзине
  qtyPerLine: 20,
  nameLen: 24,
  titleLen: 60,
  payoutLen: 120,              // «Куда переводить»: телефон и банк
  sessionTtl: 3 * 3600e3,      // сессия живёт 3 часа с последней активности
  paidTtl: 24 * 3600e3,        // после оплаты расчёт доступен сутки
};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без 0/O, 1/I/L

class AppError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

function int(v, min, max, field) {
  if (!Number.isInteger(v) || v < min || v > max) throw new AppError('bad_request', { field });
  return v;
}

function cleanName(s, max, field = 'name') {
  if (typeof s !== 'string') throw new AppError('bad_request', { field });
  const t = s
    .normalize('NFC')
    // управляющие символы и bidi-управление (подмена порядка отображения)
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || [...t].length > max) throw new AppError('bad_request', { field });
  return t;
}

// Свободный текст без обязательности (реквизиты хоста): пустая строка = «не указано».
function cleanFree(s, max, field) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string') throw new AppError('bad_request', { field });
  const t = s.normalize('NFC').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...t].length > max) throw new AppError('bad_request', { field });
  return t || null;
}

// «490» или «490,50» (рубли) -> копейки
function parseMoney(v, field, min, max) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new AppError('bad_request', { field });
  return Math.round(n * 100);
}

// Одна строка = одно блюдо. Если после названия стоит « !», блюдо помечается «нет в наличии».
function parseMenuText(text) {
  if (typeof text !== 'string') throw new AppError('bad_request', { field: 'menuText' });
  const items = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const f = line.split('|').map((x) => x.trim());
    const bad = (why) => new AppError('bad_request', { field: 'menuText', line: i + 1, why });
    if (f.length < 3) throw bad('нужно минимум: Категория | Название | Цена');
    let name = f[1];
    let available = 1;
    if (/\s!$/.test(name)) { available = 0; name = name.replace(/\s*!$/, ''); }
    const price = parseMoney(f[2], 'menuText', 0.01, 1000000);
    const clean = (v, max) => { const t = (v || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); if ([...t].length > max) throw bad('слишком длинно'); return t; };
    const category = clean(f[0], 30), nm = clean(name, 60);
    if (!category || !nm) throw bad('пустая категория или название');
    items.push({ category, name: nm, price, available, description: clean(f[3], 120) || null, weight: clean(f[4], 20) || null });
  });
  if (!items.length) throw new AppError('bad_request', { field: 'menuText', why: 'меню пустое' });
  if (items.length > 100) throw new AppError('bad_request', { field: 'menuText', why: 'не больше 100 блюд' });
  return items;
}

// Делит total пропорционально весам методом наибольшего остатка: сумма долей == total точно.
function splitProportional(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  const rem = weights.map((w) => (total * w) % sum);
  const left = total - base.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => rem[b] - rem[a] || a - b);
  for (let k = 0; k < left; k++) base[order[k]]++;
  return base;
}

// Заглушка платёжного шлюза. В продакшене здесь штатный чекаут приложения.
const payments = {
  charge({ amount }) {
    return { ok: true, id: 'demo-' + crypto.randomBytes(6).toString('hex'), amount };
  },
};

class Service {
  constructor(db, clock) {
    this.db = db;
    this.clock = clock;
    this.stmts = new Map();
    this.payments = payments;
  }

  now() { return this.clock.now(); }

  stmt(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  get(sql, ...p) { return this.stmt(sql).get(...p); }
  all(sql, ...p) { return this.stmt(sql).all(...p); }
  run(sql, ...p) { return this.stmt(sql).run(...p); }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  event(sessionId, type, participantId = null, payload = null) {
    this.run('INSERT INTO events (session_id, participant_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
      sessionId, participantId, type, payload == null ? null : JSON.stringify(payload), this.now());
  }

  touch(s) {
    const now = this.now();
    this.run('UPDATE sessions SET updated_at = ?, expires_at = ? WHERE id = ? AND status IN (\'open\', \'locked\')',
      now, now + LIMITS.sessionTtl, s.id);
  }

  // ---------- Каталог ----------
  restaurants() {
    return this.all('SELECT id, name, delivery_fee deliveryFee, service_fee_pct servicePct FROM restaurants ORDER BY id');
  }

  // Активное заведение — последнее созданное: старые заказы остаются привязаны к своему меню.
  activeRestaurantId() { return this.get('SELECT MAX(id) id FROM restaurants').id; }

  // Подмена заведения и меню для демо. Меню — строки «Категория | Название | Цена | Описание | Вес».
  // Создаёт новое заведение и делает его активным; уже идущие заказы не ломаются.
  configureDemo(input) {
    const name = cleanName(input.name, 60, 'name');
    const fee = parseMoney(input.deliveryRub, 'deliveryRub', 0, 10000);
    const pct = int(Number(input.servicePct), 0, 30, 'servicePct');
    const items = parseMenuText(input.menuText);
    return this.tx(() => {
      const rid = this.run('INSERT INTO restaurants (name, delivery_fee, service_fee_pct) VALUES (?, ?, ?)', name, fee, pct).lastInsertRowid;
      items.forEach((it, i) => this.run(
        'INSERT INTO menu_items (restaurant_id, category, name, description, weight, price, available, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        rid, it.category, it.name, it.description, it.weight, it.price, it.available, i));
      return { id: Number(rid), items: items.length };
    });
  }

  // Текст меню обратно в редактируемый вид (для предзаполнения формы /setup)
  menuText(restaurantId) {
    return this.menu(restaurantId).map((m) => [m.category, m.name + (m.available ? '' : ' !'),
      String(m.price / 100).replace('.', ','), m.description || '', m.weight || ''].join(' | ')).join('\n');
  }

  menu(restaurantId) {
    return this.all(
      `SELECT id, category, name, description, weight, price, available
         FROM menu_items WHERE restaurant_id = ? ORDER BY sort, id`, restaurantId);
  }

  // ---------- Сессия ----------
  session(code) { return this.get('SELECT * FROM sessions WHERE code = ?', code); }

  createSession(input) {
    const restaurantId = int(input.restaurantId, 1, 1e9, 'restaurantId');
    const restaurant = this.get('SELECT * FROM restaurants WHERE id = ?', restaurantId);
    if (!restaurant) throw new AppError('not_found');
    const hostName = cleanName(input.hostName, LIMITS.nameLen, 'hostName');
    const title = input.title ? cleanName(input.title, LIMITS.titleLen, 'title') : `Заказ ${hostName}`;
    const limit = input.limitRub == null ? null : int(input.limitRub, 1, 100000, 'limitRub') * 100;
    const timer = input.timerMin == null ? null : int(input.timerMin, 1, 240, 'timerMin');
    const payout = cleanFree(input.payoutInfo, LIMITS.payoutLen, 'payoutInfo');
    const now = this.now();
    const hostToken = crypto.randomBytes(24).toString('base64url');

    return this.tx(() => {
      let code = null;
      let sessionId = null;
      for (let attempt = 0; attempt < 8 && !code; attempt++) {
        const candidate = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
        try {
          sessionId = this.run(
            `INSERT INTO sessions (code, restaurant_id, title, guest_limit, deadline_at, delivery_fee,
                                   service_fee_pct, created_at, updated_at, expires_at, payout_info)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            candidate, restaurantId, title, limit, timer ? now + timer * 60000 : null,
            restaurant.delivery_fee, restaurant.service_fee_pct, now, now, now + LIMITS.sessionTtl, payout
          ).lastInsertRowid;
          code = candidate;
        } catch (e) {
          if (!/UNIQUE/.test(String(e.message))) throw e;
        }
      }
      if (!code) throw new AppError('internal');
      const pid = this.run(
        'INSERT INTO participants (session_id, name, token, is_host, joined_at) VALUES (?, ?, ?, 1, ?)',
        sessionId, hostName, hostToken, now).lastInsertRowid;
      this.event(sessionId, 'group_order_created', pid, { limit: limit != null, timer: timer != null });
      return { code, hostToken };
    });
  }

  // Возвращает { participant, kicked }: participant == null, если токен не подошёл.
  authenticate(s, token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) return { participant: null, kicked: false };
    const p = this.get('SELECT * FROM participants WHERE token = ? AND session_id = ?', token, s.id);
    if (!p) return { participant: null, kicked: false };
    return p.kicked ? { participant: null, kicked: true } : { participant: p, kicked: false };
  }

  isFinished(s) { return s.status === 'paid' || s.status === 'closed'; }

  guestCount(s) {
    return this.get('SELECT COUNT(*) n FROM participants WHERE session_id = ? AND is_host = 0 AND kicked = 0', s.id).n;
  }

  phase(s, guestCount, now = this.now()) {
    if (s.status === 'closed') return 'closed';
    if (s.status === 'paid') return 'paid';
    if (s.status === 'locked') return 'locked';
    if (s.deadline_at != null && now >= s.deadline_at) return 'time_up';
    return guestCount > 0 ? 'selecting' : 'waiting';
  }

  preview(s) {
    const host = this.get('SELECT name FROM participants WHERE session_id = ? AND is_host = 1', s.id);
    const rest = this.get('SELECT name FROM restaurants WHERE id = ?', s.restaurant_id);
    return { title: s.title, hostName: host.name, restaurant: rest.name, phase: this.phase(s, this.guestCount(s)) };
  }

  join(s, rawName) {
    if (this.isFinished(s)) throw new AppError('session_finished');
    const base = cleanName(rawName, LIMITS.nameLen);
    return this.tx(() => {
      if (this.guestCount(s) >= LIMITS.guests) throw new AppError('session_full');
      // Сравнение без учёта регистра в JS: SQLite сворачивает регистр только у ASCII, «Аня» и «аня» он считает разными
      const taken = new Set(this.all('SELECT name FROM participants WHERE session_id = ?', s.id).map((r) => r.name.toLowerCase()));
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${[...base].slice(0, LIMITS.nameLen - String(n).length - 1).join('')} ${n}`;
      }
      const token = crypto.randomBytes(24).toString('base64url');
      const id = this.run(
        'INSERT INTO participants (session_id, name, token, joined_at) VALUES (?, ?, ?, ?)',
        s.id, name, token, this.now()).lastInsertRowid;
      this.touch(s);
      this.event(s.id, 'guest_name_entered', id);
      return { participant: this.get('SELECT * FROM participants WHERE id = ?', id), token };
    });
  }

  // ---------- Корзина ----------
  // Гость правит только своё и только пока корзина открыта и время не вышло; хост — всё, пока не заблокировано.
  assertEditable(s, actor) {
    if (s.status === 'locked') throw new AppError('session_locked');
    if (s.status !== 'open') throw new AppError('session_closed');
    if (!actor.is_host && s.deadline_at != null && this.now() >= s.deadline_at) throw new AppError('time_up');
  }

  subtotal(participantId) {
    return this.get('SELECT COALESCE(SUM(qty * unit_price), 0) n FROM cart_items WHERE participant_id = ?', participantId).n;
  }

  // qty = 0 удаляет позицию. targetId доступен только хосту.
  setItem(s, actor, p) {
    const mid = int(p.menuItemId, 1, 1e9, 'menuItemId');
    const qty = int(p.qty, 0, LIMITS.qtyPerLine, 'qty');
    let target = actor;
    if (p.targetId != null && p.targetId !== actor.id) {
      if (!actor.is_host) throw new AppError('forbidden');
      target = this.get('SELECT * FROM participants WHERE id = ? AND session_id = ? AND kicked = 0',
        int(p.targetId, 1, 1e9, 'targetId'), s.id);
      if (!target) throw new AppError('not_found');
    }
    this.assertEditable(s, actor);

    return this.tx(() => {
      const m = this.get('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?', mid, s.restaurant_id);
      if (!m) throw new AppError('not_found');
      const cur = this.get('SELECT * FROM cart_items WHERE participant_id = ? AND menu_item_id = ?', target.id, mid);
      const curQty = cur ? cur.qty : 0;
      if (qty === curQty) return null;

      if (qty > curQty) { // проверки нужны только при увеличении
        if (!m.available) throw new AppError('item_unavailable');
        const units = this.get('SELECT COALESCE(SUM(qty), 0) n FROM cart_items WHERE session_id = ?', s.id).n;
        if (units - curQty + qty > LIMITS.units) throw new AppError('cart_full');
        if (!actor.is_host && s.guest_limit != null) {
          const sub = this.subtotal(target.id);
          const next = sub - curQty * (cur ? cur.unit_price : 0) + qty * m.price;
          if (next > s.guest_limit) {
            throw new AppError('limit_exceeded', { limit: s.guest_limit, remaining: Math.max(0, s.guest_limit - sub) });
          }
        }
      }

      const now = this.now();
      if (qty === 0) {
        this.run('DELETE FROM cart_items WHERE id = ?', cur.id);
      } else if (cur) {
        this.run('UPDATE cart_items SET qty = ?, unit_price = ?, updated_at = ? WHERE id = ?', qty, m.price, now, cur.id);
      } else {
        this.run('INSERT INTO cart_items (session_id, participant_id, menu_item_id, qty, unit_price, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          s.id, target.id, mid, qty, m.price, now);
        if (!target.is_host && !this.get(
          "SELECT 1 x FROM events WHERE session_id = ? AND participant_id = ? AND type = 'guest_first_item_added'", s.id, target.id)) {
          this.event(s.id, 'guest_first_item_added', target.id);
        }
      }
      this.touch(s);
      return {
        kind: qty === 0 ? 'item_removed' : cur ? 'item_changed' : 'item_added',
        by: actor.name,
        forName: target.id === actor.id ? null : target.name,
        item: m.name,
        qty,
      };
    });
  }

  setDone(s, actor, done) {
    if (s.status !== 'open') throw new AppError('session_locked');
    this.run('UPDATE participants SET done = ? WHERE id = ?', done ? 1 : 0, actor.id);
    return { kind: done ? 'guest_done' : 'guest_undone', by: actor.name };
  }

  // ---------- Действия хоста ----------
  requireHost(actor) { if (!actor.is_host) throw new AppError('forbidden'); }

  // Ключи payload задают, что менять: limitRub (null — снять), timerMin (null — выключить).
  settings(s, actor, p) {
    this.requireHost(actor);
    if (s.status !== 'open') throw new AppError('session_locked');
    const now = this.now();
    if ('limitRub' in p) {
      const limit = p.limitRub == null ? null : int(p.limitRub, 1, 100000, 'limitRub') * 100;
      this.run('UPDATE sessions SET guest_limit = ? WHERE id = ?', limit, s.id);
    }
    if ('timerMin' in p) {
      const deadline = p.timerMin == null ? null : now + int(p.timerMin, 1, 240, 'timerMin') * 60000;
      this.run('UPDATE sessions SET deadline_at = ? WHERE id = ?', deadline, s.id);
    }
    this.touch(s);
    this.event(s.id, 'settings_changed', actor.id, p);
    return { kind: 'settings_changed' };
  }

  extend(s, actor, minutes) {
    this.requireHost(actor);
    if (s.status !== 'open') throw new AppError('session_locked');
    const m = int(minutes, 1, 120, 'minutes');
    const now = this.now();
    this.run('UPDATE sessions SET deadline_at = ? WHERE id = ?', Math.max(s.deadline_at || now, now) + m * 60000, s.id);
    this.touch(s);
    this.event(s.id, 'timer_extended', actor.id, { minutes: m });
    return { kind: 'timer_extended', minutes: m };
  }

  lock(s, actor) {
    this.requireHost(actor);
    if (s.status !== 'open') throw new AppError('bad_state');
    return this.tx(() => {
      const total = this.get('SELECT COALESCE(SUM(qty * unit_price), 0) n FROM cart_items WHERE session_id = ?', s.id).n;
      if (total <= 0) throw new AppError('cart_empty');
      this.run("UPDATE sessions SET status = 'locked', locked_at = ? WHERE id = ?", this.now(), s.id);
      this.touch(s);
      this.event(s.id, 'cart_locked', actor.id, { total });
      return { kind: 'locked' };
    });
  }

  unlock(s, actor) {
    this.requireHost(actor);
    if (s.status !== 'locked') throw new AppError('bad_state');
    this.run("UPDATE sessions SET status = 'open', locked_at = NULL WHERE id = ?", s.id);
    this.touch(s);
    this.event(s.id, 'cart_unlocked', actor.id);
    return { kind: 'unlocked' };
  }

  // Оплата хостом всего заказа + фиксация расчёта Split Bill.
  pay(s, actor) {
    this.requireHost(actor);
    if (s.status !== 'locked') throw new AppError('bad_state');
    return this.tx(() => {
      const rows = this.all(
        `SELECT p.id, p.is_host, COALESCE(SUM(c.qty * c.unit_price), 0) sub
           FROM participants p LEFT JOIN cart_items c ON c.participant_id = p.id
          WHERE p.session_id = ? AND p.kicked = 0
          GROUP BY p.id HAVING sub > 0 ORDER BY p.id`, s.id);
      const itemsTotal = rows.reduce((a, r) => a + r.sub, 0);
      if (itemsTotal <= 0) throw new AppError('cart_empty');
      const fees = s.delivery_fee + Math.round((itemsTotal * s.service_fee_pct) / 100);
      const shares = splitProportional(fees, rows.map((r) => r.sub));
      // Пометка для ресторана: N — сколько человек реально заказали блюда
      const note = `[Совместный заказ · ${rows.length} чел.]`;
      const charge = this.payments.charge({ sessionCode: s.code, amount: itemsTotal + fees, note });
      if (!charge.ok) throw new AppError('payment_failed');
      rows.forEach((r, i) => {
        this.run(
          'INSERT INTO settlements (session_id, participant_id, items_total, fees_share, amount, status) VALUES (?, ?, ?, ?, ?, ?)',
          s.id, r.id, r.sub, shares[i], r.sub + shares[i], r.is_host ? 'paid' : 'owes');
      });
      const now = this.now();
      this.run("UPDATE sessions SET status = 'paid', paid_at = ?, updated_at = ?, expires_at = ?, order_note = ? WHERE id = ?",
        now, now, now + LIMITS.paidTtl, note, s.id);
      this.event(s.id, 'group_order_paid', actor.id, { amount: itemsTotal + fees, payers: rows.length, note });
      return { kind: 'paid', amount: itemsTotal + fees };
    });
  }

  markDebt(s, actor, participantId, status) {
    this.requireHost(actor);
    if (s.status !== 'paid') throw new AppError('bad_state');
    if (status !== 'owes' && status !== 'paid') throw new AppError('bad_request', { field: 'status' });
    const row = this.get(
      `SELECT st.participant_id FROM settlements st JOIN participants p ON p.id = st.participant_id
        WHERE st.session_id = ? AND st.participant_id = ? AND p.is_host = 0`,
      s.id, int(participantId, 1, 1e9, 'participantId'));
    if (!row) throw new AppError('not_found');
    this.run('UPDATE settlements SET status = ?, claimed = ? WHERE session_id = ? AND participant_id = ?',
      status, status === 'paid' ? 1 : 0, s.id, participantId);
    if (status === 'paid') this.event(s.id, 'debt_marked_paid', participantId);
    return { kind: 'debt_marked' };
  }

  // Реквизиты для перевода: хост может указать и поменять в любой момент, пока заказ не закрыт.
  setPayout(s, actor, text) {
    this.requireHost(actor);
    if (s.status === 'closed') throw new AppError('session_finished');
    this.run('UPDATE sessions SET payout_info = ? WHERE id = ?', cleanFree(text, LIMITS.payoutLen, 'payoutInfo'), s.id);
    this.touch(s);
    return { kind: 'payout_changed' };
  }

  // «Я перевёл»: гость сообщает хосту, что отправил свою часть. Подтверждает только хост (markDebt).
  claimPaid(s, actor) {
    if (s.status !== 'paid') throw new AppError('bad_state');
    const row = this.get('SELECT status FROM settlements WHERE session_id = ? AND participant_id = ?', s.id, actor.id);
    if (!row || actor.is_host) throw new AppError('not_found');
    if (row.status === 'paid') return { kind: 'noop' };
    this.run('UPDATE settlements SET claimed = 1 WHERE session_id = ? AND participant_id = ?', s.id, actor.id);
    this.event(s.id, 'debt_claimed', actor.id);
    return { kind: 'debt_claimed', by: actor.name };
  }

  kick(s, actor, participantId) {
    this.requireHost(actor);
    if (s.status !== 'open') throw new AppError('session_locked');
    return this.tx(() => {
      const t = this.get('SELECT * FROM participants WHERE id = ? AND session_id = ? AND is_host = 0 AND kicked = 0',
        int(participantId, 1, 1e9, 'participantId'), s.id);
      if (!t) throw new AppError('not_found');
      this.run('DELETE FROM cart_items WHERE participant_id = ?', t.id);
      this.run('UPDATE participants SET kicked = 1, done = 0 WHERE id = ?', t.id);
      this.touch(s);
      this.event(s.id, 'guest_kicked', t.id);
      return { kind: 'kicked', name: t.name };
    });
  }

  close(s, actor) {
    this.requireHost(actor);
    if (s.status === 'closed') throw new AppError('bad_state');
    const reason = s.status === 'paid' ? 'completed' : 'cancelled';
    this.run("UPDATE sessions SET status = 'closed', close_reason = ?, updated_at = ? WHERE id = ?", reason, this.now(), s.id);
    this.event(s.id, 'group_order_closed', actor.id, { reason });
    return { kind: 'closed', reason };
  }

  // ---------- Фоновые задачи ----------
  dueTimers(now) {
    return this.all("SELECT * FROM sessions WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?", now);
  }

  expire(now) {
    const rows = this.all("SELECT id, code FROM sessions WHERE status IN ('open', 'locked', 'paid') AND expires_at <= ?", now);
    for (const r of rows) {
      this.run("UPDATE sessions SET status = 'closed', close_reason = 'expired', updated_at = ? WHERE id = ?", now, r.id);
      this.event(r.id, 'group_order_closed', null, { reason: 'expired' });
    }
    return rows.map((r) => r.code);
  }

  purge(now) {
    this.run("DELETE FROM sessions WHERE status = 'closed' AND updated_at < ?", now - 7 * 24 * 3600e3);
  }

  // ---------- Снимок состояния для клиентов ----------
  buildState(s) {
    const now = this.now();
    const parts = this.all(
      'SELECT id, name, is_host, done FROM participants WHERE session_id = ? AND kicked = 0 ORDER BY is_host DESC, id', s.id);
    const rows = this.all(
      `SELECT c.id, c.participant_id pid, c.menu_item_id mid, c.qty, c.unit_price price, m.name, m.available
         FROM cart_items c JOIN menu_items m ON m.id = c.menu_item_id
        WHERE c.session_id = ? ORDER BY c.id`, s.id);
    const byId = new Map(parts.map((p) => [p.id, {
      id: p.id, name: p.name, isHost: !!p.is_host, done: !!p.done, subtotal: 0, items: [],
    }]));
    let total = 0, units = 0, unavailable = 0;
    for (const r of rows) {
      const p = byId.get(r.pid);
      if (!p) continue;
      p.items.push({ id: r.id, menuItemId: r.mid, name: r.name, qty: r.qty, price: r.price, unavailable: !r.available });
      p.subtotal += r.qty * r.price;
      total += r.qty * r.price;
      units += r.qty;
      if (!r.available) unavailable++;
    }
    const guestCount = parts.filter((p) => !p.is_host).length;
    const phase = this.phase(s, guestCount, now);
    const serviceFee = total > 0 ? Math.round((total * s.service_fee_pct) / 100) : 0;
    const deliveryFee = total > 0 ? s.delivery_fee : 0;
    const rest = this.get('SELECT id, name FROM restaurants WHERE id = ?', s.restaurant_id);

    let settlement = null;
    if (phase === 'paid') {
      settlement = this.all(
        `SELECT st.participant_id pid, p.name, p.is_host isHost, st.items_total itemsTotal,
                st.fees_share feesShare, st.amount, st.status, st.claimed
           FROM settlements st JOIN participants p ON p.id = st.participant_id
          WHERE st.session_id = ? ORDER BY p.is_host DESC, p.id`, s.id)
        .map((r) => ({ ...r, isHost: !!r.isHost, claimed: !!r.claimed }));
    }
    return {
      t: 'state',
      now,
      session: {
        code: s.code, title: s.title, phase, closeReason: s.close_reason,
        restaurant: rest, hostName: parts.find((p) => p.is_host)?.name,
        limit: s.guest_limit, deadlineAt: s.deadline_at,
        payout: s.payout_info, orderNote: s.order_note,
        total, units, deliveryFee, serviceFee, grandTotal: total + deliveryFee + serviceFee, servicePct: s.service_fee_pct,
        guestCount, unavailable, maxGuests: LIMITS.guests,
      },
      participants: [...byId.values()],
      settlement,
    };
  }

  // Итоги пилота для страницы /stats: считаются только по оплаченным совместным заказам.
  stats() {
    const o = this.get(
      `SELECT COUNT(*) orders, COALESCE(SUM(t.total), 0) revenue, COALESCE(SUM(t.people), 0) people
         FROM (SELECT st.session_id, SUM(st.amount) total, COUNT(*) people
                 FROM settlements st JOIN sessions s ON s.id = st.session_id
                WHERE s.paid_at IS NOT NULL GROUP BY st.session_id) t`);
    const guests = this.get(
      `SELECT COUNT(*) n FROM settlements st JOIN participants p ON p.id = st.participant_id
        JOIN sessions s ON s.id = st.session_id WHERE s.paid_at IS NOT NULL AND p.is_host = 0`).n;
    const t = this.get('SELECT AVG(paid_at - created_at) ms FROM sessions WHERE paid_at IS NOT NULL').ms;
    return {
      orders: o.orders,
      revenue: o.revenue,
      avgCheck: o.orders ? Math.round(o.revenue / o.orders) : 0,
      avgPeople: o.orders ? Math.round((o.people / o.orders) * 10) / 10 : 0,
      guests,
      avgMinutes: t == null ? null : Math.round((t / 60000) * 10) / 10,
    };
  }

  // «Я» для конкретного соединения; canEdit — может ли менять корзину прямо сейчас.
  meFor(common, participantId) {
    const p = common.participants.find((x) => x.id === participantId);
    if (!p) return null;
    const ph = common.session.phase;
    const canEdit = p.isHost
      ? ph === 'waiting' || ph === 'selecting' || ph === 'time_up'
      : ph === 'selecting' || ph === 'waiting';
    return { id: p.id, name: p.name, isHost: p.isHost, done: p.done, canEdit };
  }
}

module.exports = { Service, AppError, LIMITS, splitProportional, cleanName };
