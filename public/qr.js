/* Генератор QR-кодов без зависимостей: байтовый режим, коррекция M, версии 1–10
   (до 213 байт, для ссылок вида https://host/j/ABC123 с запасом).
   Работает и в браузере (window.QR), и в Node (require). */
(function (root) {
  'use strict';

  // ---- Поле Галуа GF(256) и код Рида-Соломона ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, n) {
    const gen = rsGenerator(n);
    const res = new Array(n).fill(0);
    for (const b of data) {
      const f = b ^ res.shift();
      res.push(0);
      if (f) for (let i = 0; i < n; i++) res[i] ^= gmul(gen[i + 1], f);
    }
    return res;
  }

  // ---- Таблицы для уровня M: ec — байтов коррекции на блок, g — [блоков, байтов данных в блоке] ----
  const TABLE = [null,
    { ec: 10, g: [[1, 16]] },
    { ec: 16, g: [[1, 28]] },
    { ec: 26, g: [[1, 44]] },
    { ec: 18, g: [[2, 32]] },
    { ec: 24, g: [[2, 43]] },
    { ec: 16, g: [[4, 27]] },
    { ec: 18, g: [[4, 31]] },
    { ec: 22, g: [[2, 38], [2, 39]] },
    { ec: 22, g: [[3, 36], [2, 37]] },
    { ec: 26, g: [[4, 43], [1, 44]] },
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  const dataCapacity = (v) => TABLE[v].g.reduce((s, [n, k]) => s + n * k, 0);

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    return Array.from(Buffer.from(str, 'utf8'));
  }

  function buildCodewords(bytes, version) {
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const cap = dataCapacity(version) * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    for (let pad = 0xec; data.length < dataCapacity(version); pad ^= 0xec ^ 0x11) data.push(pad);

    const { ec, g } = TABLE[version];
    const blocks = [];
    let pos = 0;
    for (const [count, k] of g) {
      for (let i = 0; i < count; i++) {
        const d = data.slice(pos, pos + k);
        pos += k;
        blocks.push({ data: d, ec: rsEncode(d, ec) });
      }
    }
    const out = [];
    const maxK = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);

    const result = [];
    for (const cw of out) for (let i = 7; i >= 0; i--) result.push((cw >>> i) & 1);
    for (let i = 0; i < REMAINDER_BITS[version]; i++) result.push(0);
    return result;
  }

  // ---- Матрица ----
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const getBit = (x, i) => ((x >>> i) & 1) === 1;

  function makeMatrix(version, codewords, mask) {
    const size = 17 + 4 * version;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

    // Вспомогательные шаблоны
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const pos = ALIGN[version];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    // Информация о формате (уровень M = 00) и версии
    const fdata = (0b00 << 3) | mask;
    let rem = fdata;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fdata << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fbits, i));
    setFn(8, 7, getBit(fbits, 6));
    setFn(8, 8, getBit(fbits, 7));
    setFn(7, 8, getBit(fbits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(fbits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(fbits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(fbits, i));
    setFn(8, size - 8, true);
    if (version >= 7) {
      let r = version;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      const vbits = (version << 12) | r;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setFn(a, b, getBit(vbits, i));
        setFn(b, a, getBit(vbits, i));
      }
    }

    // Данные: змейкой снизу вверх по парам колонок, колонка 6 пропускается
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && idx < codewords.length) {
            mod[y][x] = codewords[idx] === 1;
            idx++;
          }
        }
      }
    }
    // Маска
    const m = MASKS[mask];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && m(y, x)) mod[y][x] = !mod[y][x];
    return mod;
  }

  function penalty(mod) {
    const size = mod.length;
    let score = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(mod[i].map((b) => (b ? 1 : 0)).join(''));
      lines.push(mod.map((row) => (row[i] ? 1 : 0)).join(''));
    }
    for (const s of lines) {
      const runs = s.match(/(.)\1{4,}/g) || [];
      for (const r of runs) score += 3 + (r.length - 5);
      for (const p of ['10111010000', '00001011101']) {
        for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + 1)) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = mod[y][x];
          if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function encode(text) {
    const bytes = utf8(String(text));
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new RangeError('QR: текст слишком длинный (максимум 213 байт)');
    const codewords = buildCodewords(bytes, version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const mod = makeMatrix(version, codewords, mask);
      const p = penalty(mod);
      if (p < bestScore) { bestScore = p; best = mod; }
    }
    return { version, size: best.length, modules: best };
  }

  function svg(text, opts) {
    const o = Object.assign({ margin: 4, dark: '#000', light: '#fff', label: 'QR-код' }, opts);
    const { size, modules } = encode(text);
    const dim = size + o.margin * 2;
    let d = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + o.margin} ${y + o.margin}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${o.label}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="${o.light}"/><path d="${d}" fill="${o.dark}"/></svg>`;
  }

  const api = { encode, svg };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
