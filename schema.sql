-- Real-Time Group Order: схема БД (SQLite). Деньги хранятся в копейках (INTEGER),
-- время — в миллисекундах Unix epoch.

CREATE TABLE IF NOT EXISTS restaurants (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  delivery_fee     INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  service_fee_pct  INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_pct BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id             INTEGER PRIMARY KEY,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  description    TEXT,
  weight         TEXT,
  price          INTEGER NOT NULL CHECK (price > 0),
  available      INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_restaurant ON menu_items(restaurant_id, sort);

-- Групповая сессия. Статус хранится в БД, а «ожидание / выбор / время вышло»
-- вычисляются из статуса, дедлайна и числа гостей (см. Service.phase).
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  code             TEXT    NOT NULL UNIQUE,            -- короткий код для ссылки /j/<code>
  restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id),
  title            TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'locked', 'paid', 'closed')),
  close_reason     TEXT    CHECK (close_reason IN ('cancelled', 'expired', 'completed')),
  guest_limit      INTEGER CHECK (guest_limit IS NULL OR guest_limit > 0),  -- копейки на гостя
  deadline_at      INTEGER,                                                 -- конец времени выбора
  delivery_fee     INTEGER NOT NULL,                                        -- снимок на момент создания
  service_fee_pct  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  locked_at        INTEGER,
  paid_at          INTEGER,
  expires_at       INTEGER NOT NULL,
  payout_info      TEXT,                                                    -- «Куда переводить»: телефон и банк для СБП
  order_note       TEXT                                                     -- пометка для ресторана: [Совместный заказ · N чел.]
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS participants (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,   -- секрет участника (хранится в localStorage), 192 бита
  is_host     INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  kicked      INTEGER NOT NULL DEFAULT 0,
  joined_at   INTEGER NOT NULL,
  UNIQUE (session_id, name)
);

-- Позиция корзины: одна строка на (участник, блюдо). Автор позиции = participant_id.
CREATE TABLE IF NOT EXISTS cart_items (
  id              INTEGER PRIMARY KEY,
  session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  menu_item_id    INTEGER NOT NULL REFERENCES menu_items(id),
  qty             INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 20),
  unit_price      INTEGER NOT NULL CHECK (unit_price > 0),
  updated_at      INTEGER NOT NULL,
  UNIQUE (participant_id, menu_item_id)
);
CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);

-- Расчёт Split Bill, фиксируется в момент оплаты.
CREATE TABLE IF NOT EXISTS settlements (
  session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  items_total     INTEGER NOT NULL,
  fees_share      INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'owes' CHECK (status IN ('owes', 'paid')),
  claimed         INTEGER NOT NULL DEFAULT 0,   -- гость нажал «Я перевёл», хост ещё не подтвердил
  PRIMARY KEY (session_id, participant_id)
);

-- Аналитика и аудит. Без внешних ключей: события переживают удаление сессии.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY,
  session_id      INTEGER NOT NULL,
  participant_id  INTEGER,
  type            TEXT    NOT NULL,
  payload         TEXT,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, type);
