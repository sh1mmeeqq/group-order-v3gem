'use strict';
// Хаб реального времени: комнаты по коду сессии, протокол сообщений, рассылка снимков.
//
// Клиент -> сервер:  hello, join, set_item, set_done, settings, extend, lock, unlock,
//                    pay, mark_debt, set_payout, claim_paid, kick, close, track, ping
// Сервер -> клиент:  anon, welcome, state, event, error, kicked, pong
//
// После любого изменения всем участникам комнаты уходит свежий снимок `state`
// (корзина небольшая: до 30 гостей и 100 порций), а подписанное событие `event`
// используется для тостов и озвучивания скринридером.

const { AppError } = require('./service');

const TRACKABLE = new Set(['invite_shared', 'split_bill_viewed', 'guest_app_install_tap']);
const CODE_RE = /^[A-Z0-9]{6}$/;

class Hub {
  constructor(service) {
    this.svc = service;
    this.rooms = new Map(); // code -> Set<ctx>
    this.chats = new Map(); // code -> Array<{id, pid, name, isHost, text, ts}>
    this.timeUpSeen = new Set();
    this.ticks = 0;
  }

  // ---------- Соединения ----------
  onConnection(conn) {
    const ctx = { conn, code: null, pid: null, window: [] };
    conn.on('message', (raw) => this.onMessage(ctx, raw));
    conn.on('close', () => this.leave(ctx));
  }

  leave(ctx) {
    if (!ctx.code) return;
    const room = this.rooms.get(ctx.code);
    if (!room) return;
    room.delete(ctx);
    if (!room.size) this.rooms.delete(ctx.code);
  }

  enter(ctx, code, pid) {
    ctx.code = code;
    ctx.pid = pid;
    if (!this.rooms.has(code)) this.rooms.set(code, new Set());
    this.rooms.get(code).add(ctx);
  }

  send(ctx, obj) { ctx.conn.send(JSON.stringify(obj)); }

  // Не больше 40 сообщений за 5 секунд на соединение.
  rateLimited(ctx) {
    const now = Date.now();
    ctx.window = ctx.window.filter((t) => now - t < 5000);
    ctx.window.push(now);
    return ctx.window.length > 40;
  }

  // ---------- Протокол ----------
  onMessage(ctx, raw) {
    if (this.rateLimited(ctx)) return ctx.conn.close(1008);
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.send(ctx, { t: 'error', code: 'bad_request' }); }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.send(ctx, { t: 'error', code: 'bad_request' });

    try {
      this.dispatch(ctx, msg);
    } catch (e) {
      if (e instanceof AppError) {
        if (e.code === 'limit_exceeded' && ctx.code) {
          const s = this.svc.session(ctx.code);
          if (s) this.svc.event(s.id, 'guest_limit_hit', ctx.pid);
        }
        this.send(ctx, { t: 'error', code: e.code, ...e.extra });
      } else {
        console.error('[hub] internal error:', e);
        this.send(ctx, { t: 'error', code: 'internal' });
      }
    }
  }

  dispatch(ctx, msg) {
    if (msg.t === 'ping') return this.send(ctx, { t: 'pong' });
    if (msg.t === 'hello') return this.hello(ctx, msg);
    if (!ctx.code) throw new AppError('not_joined');

    const s = this.svc.session(ctx.code);
    if (!s) throw new AppError('session_not_found');

    if (msg.t === 'join') return this.join(ctx, s, msg);
    if (!ctx.pid) throw new AppError('not_joined');
    const actor = this.svc.get('SELECT * FROM participants WHERE id = ? AND kicked = 0', ctx.pid);
    if (!actor) throw new AppError('not_joined');
    const svc = this.svc;

    let ev;
    switch (msg.t) {
      case 'set_item': ev = svc.setItem(s, actor, msg); break;
      case 'set_done': ev = svc.setDone(s, actor, msg.done === true); break;
      case 'settings': ev = svc.settings(s, actor, msg); break;
      case 'extend': ev = svc.extend(s, actor, msg.minutes); break;
      case 'lock': ev = svc.lock(s, actor); break;
      case 'unlock': ev = svc.unlock(s, actor); break;
      case 'pay': ev = svc.pay(s, actor); break;
      case 'mark_debt': ev = svc.markDebt(s, actor, msg.participantId, msg.status); break;
      case 'set_payout': ev = svc.setPayout(s, actor, msg.text); break;
      case 'claim_paid': ev = svc.claimPaid(s, actor); break;
      case 'kick': ev = svc.kick(s, actor, msg.participantId); this.kickConnections(s.code, msg.participantId); break;
      case 'close': ev = svc.close(s, actor); break;
      case 'chat_send': {
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!text) return;
        if (!this.chats.has(s.code)) this.chats.set(s.code, []);
        const list = this.chats.get(s.code);
        const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), pid: actor.id, name: actor.name, isHost: !!actor.is_host, text, ts: svc.now() };
        list.push(entry);
        if (list.length > 60) list.shift();
        this.broadcastChat(s.code, entry);
        return;
      }
      case 'track':
        if (TRACKABLE.has(msg.name)) svc.event(s.id, msg.name, actor.id);
        return;
      default: throw new AppError('bad_request');
    }
    this.broadcast(s.code);
    if (ev && ev.kind) this.announce(s.code, ev, ctx);
  }

  hello(ctx, msg) {
    const code = String(msg.code || '').toUpperCase();
    if (!CODE_RE.test(code)) throw new AppError('session_not_found');
    const s = this.svc.session(code);
    if (!s) throw new AppError('session_not_found');
    this.leave(ctx);
    const { participant, kicked } = this.svc.authenticate(s, msg.token);
    if (kicked) { this.send(ctx, { t: 'kicked' }); return ctx.conn.close(1000); }
    if (participant) {
      this.enter(ctx, code, participant.id);
      this.send(ctx, this.welcome(s));
      return this.sendState(ctx, s);
    }
    if (this.svc.isFinished(s)) throw new AppError('session_finished');
    ctx.code = code; // ждём join, в комнату ещё не входим
    ctx.pid = null;
    this.svc.event(s.id, 'guest_link_opened');
    this.send(ctx, { t: 'anon', preview: this.svc.preview(s) });
  }

  join(ctx, s, msg) {
    if (ctx.pid) throw new AppError('bad_request');
    const { participant, token } = this.svc.join(s, msg.name);
    this.enter(ctx, s.code, participant.id);
    this.send(ctx, { ...this.welcome(s), token });
    this.broadcast(s.code);
    this.announce(s.code, { kind: 'guest_joined', by: participant.name }, ctx);
  }

  welcome(s) {
    const rest = this.svc.get('SELECT id, name FROM restaurants WHERE id = ?', s.restaurant_id);
    return { t: 'welcome', restaurant: rest, menu: this.svc.menu(s.restaurant_id), chat: this.chats.get(s.code) || [] };
  }

  // ---------- Рассылка ----------
  sendState(ctx, s, common = this.svc.buildState(s)) {
    const me = this.svc.meFor(common, ctx.pid);
    if (!me) { this.send(ctx, { t: 'kicked' }); return ctx.conn.close(1000); }
    // Расчёт Split Bill хост видит целиком, гость — только свою строку (чужие суммы ему не нужны)
    const view = me.isHost || !common.settlement
      ? common
      : { ...common, settlement: common.settlement.filter((r) => r.pid === me.id) };
    this.send(ctx, { ...view, me });
  }

  broadcast(code) {
    const room = this.rooms.get(code);
    if (!room || !room.size) return;
    const s = this.svc.session(code);
    if (!s) return;
    const common = this.svc.buildState(s);
    for (const ctx of [...room]) this.sendState(ctx, s, common);
  }

  broadcastChat(code, entry) {
    const room = this.rooms.get(code);
    if (!room) return;
    const payload = JSON.stringify({ t: 'chat_msg', msg: entry });
    for (const ctx of room) ctx.conn.send(payload);
  }

  announce(code, ev, except) {
    const room = this.rooms.get(code);
    if (!room) return;
    const payload = JSON.stringify({ t: 'event', ...ev });
    for (const ctx of room) if (ctx !== except) ctx.conn.send(payload);
  }

  kickConnections(code, participantId) {
    // Состояние уже обновлено в БД; sendState сам отправит `kicked` и закроет соединение.
    const room = this.rooms.get(code);
    if (!room) return;
    for (const ctx of [...room]) {
      if (ctx.pid === participantId) { this.send(ctx, { t: 'kicked' }); ctx.conn.close(1000); }
    }
  }

  // ---------- Фоновая задача: таймеры и истечение сессий ----------
  tick() {
    const now = this.svc.now();
    for (const s of this.svc.dueTimers(now)) {
      const key = `${s.code}:${s.deadline_at}`;
      if (this.timeUpSeen.has(key)) continue;
      this.timeUpSeen.add(key);
      this.svc.event(s.id, 'timer_expired');
      this.broadcast(s.code);
    }
    if (this.timeUpSeen.size > 5000) this.timeUpSeen.clear();
    for (const code of this.svc.expire(now)) this.broadcast(code);
    if (++this.ticks % 600 === 0) this.svc.purge(now);
  }
}

module.exports = { Hub };
