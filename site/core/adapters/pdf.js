// Minimal, dependency-free PDF text extractor aimed at the NBA official injury report.
// Plain ES module, no node: imports. Works in Node 20 / Deno / Workers / browsers.
//
// STATUS: UNVERIFIED against a real NBA injury-report PDF (network blocked where this was
// written). Validated only on synthetic PDFs (uncompressed + FlateDecode, Tj/TJ/'/",
// literal + hex strings, simple ToUnicode CMaps). Real reports may use object streams,
// CID fonts or column layouts this parser handles imperfectly; callers must treat an
// empty `rows` array as "parse failed" and fall through the chain.
//
// API:
//   await extractPdfText(bytes)        -> { items:[{x,y,page,str}], lines:[{y,page,items}], error }
//   await parseInjuryReportPdf(bytes)  -> { rows:[{gameDate,gameTime,matchup,team,player,status,reason}], lines, error }
//   parseInjuryReportLines(lines)      -> rows   (pure, for tests)

const latin1 = (u8, s = 0, e = u8.length) => {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + 8192)));
  return out;
};
const toU8 = (b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(0));

/** Inflate zlib ('deflate' format) bytes. Returns Uint8Array or null when unsupported/corrupt. */
export async function inflate(u8) {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(fmt);
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      /* try next */
    }
  }
  return null;
}

// ---------- object / stream discovery ----------
function findObjects(u8) {
  const s = latin1(u8);
  const objs = new Map(); // num -> { dict, raw, streamStart, streamEnd }
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1];
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.indexOf('stream');
    let dict = body;
    let streamStart = -1;
    let streamEnd = -1;
    if (si >= 0 && /<</.test(body.slice(0, si))) {
      dict = body.slice(0, si);
      let p = start + si + 6;
      if (s[p] === '\r') p++;
      if (s[p] === '\n') p++;
      const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const es = s.indexOf('endstream', p);
      streamStart = p;
      streamEnd = lenM && p + +lenM[1] <= es ? p + +lenM[1] : es;
      // trim trailing EOL before endstream when length unknown
      if (!lenM) while (streamEnd > p && (s[streamEnd - 1] === '\n' || s[streamEnd - 1] === '\r')) streamEnd--;
    }
    objs.set(num, { dict, raw: body, streamStart, streamEnd });
    re.lastIndex = end + 6;
  }
  return { s, objs };
}

async function streamBytes(u8, o) {
  if (o.streamStart < 0) return null;
  let data = u8.subarray(o.streamStart, o.streamEnd);
  if (/\/FlateDecode|\/Fl\b/.test(o.dict)) {
    const inf = await inflate(data);
    if (!inf) return null;
    data = inf;
  } else if (/\/Filter/.test(o.dict) && !/\/FlateDecode/.test(o.dict)) {
    return null; // unsupported filter (DCT images, LZW...)
  }
  return data;
}

// Expand object streams (/Type /ObjStm) into the object map.
async function expandObjStreams(u8, objs) {
  for (const [, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = await streamBytes(u8, o);
    if (!data) continue;
    const txt = latin1(data);
    const n = +(/\/N\s+(\d+)/.exec(o.dict) || [])[1] || 0;
    const first = +(/\/First\s+(\d+)/.exec(o.dict) || [])[1] || 0;
    const head = txt.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = head[i * 2 + 1];
      const next = i + 1 < n ? head[(i + 1) * 2 + 1] : txt.length - first;
      const body = txt.slice(first + off, first + next);
      if (!objs.has(num)) objs.set(num, { dict: body, raw: body, streamStart: -1, streamEnd: -1 });
    }
  }
}

// ---------- ToUnicode CMap ----------
function hexToStr(h) {
  let out = '';
  for (let i = 0; i + 3 < h.length + 1; i += 4) {
    const cp = parseInt(h.slice(i, i + 4).padEnd(4, '0'), 16);
    if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
  }
  return out;
}
export function parseCMap(txt) {
  const map = new Map();
  let codeLen = 1;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(txt);
  if (cs) {
    const h = /<([0-9A-Fa-f]+)>/.exec(cs[1]);
    if (h) codeLen = Math.max(1, h[1].length / 2);
  }
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (p[3][0] === '<') {
        const base = parseInt(p[3].slice(1, -1), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else {
        const arr = [...p[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]));
        arr.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return { map, codeLen };
}

// ---------- content-stream tokenizer ----------
function unescapeLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '\r' || n === '\n') {
      if (n === '\r' && s[i + 1] === '\n') i++;
    } else if (/[0-7]/.test(n)) {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i];
      out += String.fromCharCode(parseInt(o, 8) & 255);
    } else out += n;
  }
  return out;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const L = src.length;
  while (i < L) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '%') {
      while (i < L && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      let buf = '';
      while (j < L && depth > 0) {
        const d = src[j];
        if (d === '\\') {
          buf += d + (src[j + 1] || '');
          j += 2;
          continue;
        }
        if (d === '(') depth++;
        else if (d === ')') {
          depth--;
          if (depth === 0) break;
        }
        buf += d;
        j++;
      }
      toks.push({ t: 'str', v: unescapeLiteral(buf) });
      i = j + 1;
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const j = src.indexOf('>', i);
      const hex = src.slice(i + 1, j < 0 ? L : j).replace(/\s+/g, '');
      let v = '';
      const h = hex.length % 2 ? hex + '0' : hex;
      for (let k = 0; k < h.length; k += 2) v += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
      toks.push({ t: 'str', v, hex: true });
      i = j < 0 ? L : j + 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      toks.push({ t: 'op', v: '<<' });
      i += 2;
      continue;
    }
    if (c === '>' && src[i + 1] === '>') {
      toks.push({ t: 'op', v: '>>' });
      i += 2;
      continue;
    }
    if (c === '[' || c === ']') {
      toks.push({ t: c });
      i++;
      continue;
    }
    if (c === '/') {
      let j = i + 1;
      while (j < L && !/[\s/[\]()<>{}%]/.test(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < L && !/[\s/[\]()<>{}%]/.test(src[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    const w = src.slice(i, j);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) toks.push({ t: 'num', v: parseFloat(w) });
    else toks.push({ t: 'op', v: w });
    i = j;
  }
  return toks;
}

function decodeWith(font, raw) {
  if (!font || !font.map || font.map.size === 0) return raw;
  const n = font.codeLen || 1;
  let out = '';
  for (let i = 0; i + n <= raw.length; i += n) {
    let code = 0;
    for (let k = 0; k < n; k++) code = (code << 8) | raw.charCodeAt(i + k);
    out += font.map.has(code) ? font.map.get(code) : n === 1 ? String.fromCharCode(code) : '';
  }
  return out;
}

function runContent(src, fonts, page, items) {
  const toks = tokenize(src);
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0];
  let lm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let font = null;
  let fontSize = 10;
  const ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const emit = (str) => {
    if (!str) return;
    const m = mul(tm, ctm);
    items.push({ x: m[4], y: m[5], page, str, size: fontSize });
    // advance roughly so consecutive Tj on same line keep increasing x
    tm = mul([1, 0, 0, 1, str.length * fontSize * 0.5, 0], tm);
  };
  const nextLine = (tx, ty) => {
    lm = mul([1, 0, 0, 1, tx, ty], lm);
    tm = lm.slice();
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== 'op') {
      if (tk.t === '[') {
        const arr = [];
        let j = i + 1;
        for (; j < toks.length && toks[j].t !== ']'; j++) arr.push(toks[j]);
        stack.push({ t: 'arr', v: arr });
        i = j;
      } else stack.push(tk);
      continue;
    }
    const op = tk.v;
    const nums = () => stack.filter((x) => x.t === 'num').map((x) => x.v);
    switch (op) {
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        lm = [1, 0, 0, 1, 0, 0];
        break;
      case 'q':
        ctmStack.push(ctm.slice());
        break;
      case 'Q':
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        break;
      case 'cm': {
        const n = nums().slice(-6);
        if (n.length === 6) ctm = mul(n, ctm);
        break;
      }
      case 'Tf': {
        const nm = stack.filter((x) => x.t === 'name').pop();
        const n = nums();
        font = nm ? fonts.get(nm.v) || null : null;
        if (n.length) fontSize = n[n.length - 1];
        break;
      }
      case 'TL': {
        const n = nums();
        if (n.length) leading = n[n.length - 1];
        break;
      }
      case 'Td': {
        const n = nums().slice(-2);
        if (n.length === 2) nextLine(n[0], n[1]);
        break;
      }
      case 'TD': {
        const n = nums().slice(-2);
        if (n.length === 2) {
          leading = -n[1];
          nextLine(n[0], n[1]);
        }
        break;
      }
      case 'Tm': {
        const n = nums().slice(-6);
        if (n.length === 6) {
          lm = n.slice();
          tm = n.slice();
        }
        break;
      }
      case 'T*':
        nextLine(0, -leading);
        break;
      case 'Tj': {
        const s = stack.filter((x) => x.t === 'str').pop();
        if (s) emit(decodeWith(font, s.v));
        break;
      }
      case "'": {
        nextLine(0, -leading);
        const s = stack.filter((x) => x.t === 'str').pop();
        if (s) emit(decodeWith(font, s.v));
        break;
      }
      case '"': {
        nextLine(0, -leading);
        const s = stack.filter((x) => x.t === 'str').pop();
        if (s) emit(decodeWith(font, s.v));
        break;
      }
      case 'TJ': {
        const a = stack.filter((x) => x.t === 'arr').pop();
        if (a) {
          let str = '';
          for (const el of a.v) {
            if (el.t === 'str') str += decodeWith(font, el.v);
            else if (el.t === 'num' && el.v < -200) str += ' '; // large kerning gap = word space
          }
          emit(str);
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
}

function resolveRef(objs, txt) {
  const m = /^\s*(\d+)\s+\d+\s+R/.exec(txt);
  return m ? objs.get(+m[1]) : null;
}

async function collectFonts(u8, objs) {
  // name -> {map, codeLen}. Font names collected from every /Font << /F1 n 0 R >> dict.
  const fonts = new Map();
  const cmapCache = new Map();
  const fontObj = async (num) => {
    if (cmapCache.has(num)) return cmapCache.get(num);
    const o = objs.get(num);
    let entry = { map: new Map(), codeLen: 1 };
    if (o) {
      const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o.dict);
      if (tu && objs.get(+tu[1])) {
        const data = await streamBytes(u8, objs.get(+tu[1]));
        if (data) entry = parseCMap(latin1(data));
      }
    }
    cmapCache.set(num, entry);
    return entry;
  };
  for (const [, o] of objs) {
    for (const fm of o.dict.matchAll(/\/Font\s*(<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/g)) {
      let inner = fm[2];
      if (!inner && fm[3]) {
        const ref = objs.get(+fm[3]);
        inner = ref ? ref.dict.replace(/^\s*<<|>>\s*$/g, '') : '';
      }
      if (!inner) continue;
      for (const nm of inner.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
        if (!fonts.has(nm[1])) fonts.set(nm[1], await fontObj(+nm[2]));
      }
    }
  }
  return fonts;
}

/** Extract positioned text items from PDF bytes. Never throws. */
export async function extractPdfText(bytes) {
  try {
    const u8 = toU8(bytes);
    if (latin1(u8, 0, 5) !== '%PDF-') return { items: [], lines: [], error: 'not a PDF' };
    const { objs } = findObjects(u8);
    await expandObjStreams(u8, objs);
    const fonts = await collectFonts(u8, objs);
    // pages in document order: find /Type /Page objects, take their /Contents
    const pageObjs = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b(?!s)/.test(o.dict)).sort((a, b) => a[0] - b[0]);
    const items = [];
    const used = new Set();
    let page = 0;
    for (const [, po] of pageObjs) {
      page++;
      const cm = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(po.dict);
      if (!cm) continue;
      const refs = [...cm[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => +x[1]);
      let src = '';
      for (const r of refs) {
        const o = objs.get(r);
        if (!o) continue;
        used.add(r);
        const data = await streamBytes(u8, o);
        if (data) src += latin1(data) + '\n';
      }
      runContent(src, fonts, page, items);
    }
    if (!items.length) {
      // fallback: scan every decodable stream that looks like a content stream
      for (const [num, o] of objs) {
        if (used.has(num) || o.streamStart < 0) continue;
        const data = await streamBytes(u8, o);
        if (!data) continue;
        const src = latin1(data);
        if (/\bBT\b/.test(src) && /(Tj|TJ)/.test(src)) runContent(src, fonts, ++page, items);
      }
    }
    return { items, lines: groupLines(items), error: items.length ? null : 'no text found' };
  } catch (e) {
    return { items: [], lines: [], error: String((e && e.message) || e) };
  }
}

export function groupLines(items, tol = 2.5) {
  const byPage = new Map();
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  const lines = [];
  for (const [page, arr] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const it of arr) {
      if (cur && Math.abs(cur.y - it.y) <= tol) cur.items.push(it);
      else {
        cur = { y: it.y, page, items: [it] };
        lines.push(cur);
      }
    }
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

// ---------- NBA injury-report row model ----------
const HEADERS = [
  ['gameDate', /^game\s*date$/i],
  ['gameTime', /^game\s*time$/i],
  ['matchup', /^matchup$/i],
  ['team', /^team$/i],
  ['player', /^player\s*name$/i],
  ['status', /^current\s*status$/i],
  ['reason', /^reason$/i],
];
const STATUS_RE = /^(Out|Questionable|Doubtful|Probable|Available)$/i;
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const TIME_RE = /^\d{1,2}:\d{2}\s*\(ET\)$/i;
const MATCHUP_RE = /^[A-Z]{2,3}@[A-Z]{2,3}$/;

/** Turn grouped text lines into injury rows. Pure; exported for tests. */
export function parseInjuryReportLines(lines) {
  let cols = null; // [{key, x}]
  const rows = [];
  let carry = { gameDate: '', gameTime: '', matchup: '', team: '' };
  for (const line of lines) {
    const texts = line.items.map((i) => i.str.trim()).filter(Boolean);
    const found = [];
    for (const it of line.items) {
      const h = HEADERS.find(([, re]) => re.test(it.str.trim()));
      if (h) found.push({ key: h[0], x: it.x });
    }
    if (found.length >= 4) {
      cols = found.sort((a, b) => a.x - b.x);
      continue;
    }
    if (!cols) continue;
    if (/^Injury Report:|^Page \d+ of \d+/i.test(texts.join(' '))) continue;
    const cell = {};
    for (const it of line.items) {
      const s = it.str.trim();
      if (!s) continue;
      let k = cols[0].key;
      for (const c of cols) if (it.x >= c.x - 3) k = c.key;
      // content-based correction for tokens that clearly belong elsewhere
      if (DATE_RE.test(s)) k = 'gameDate';
      else if (TIME_RE.test(s)) k = 'gameTime';
      else if (MATCHUP_RE.test(s)) k = 'matchup';
      else if (STATUS_RE.test(s) && k !== 'reason') k = 'status';
      cell[k] = cell[k] ? `${cell[k]} ${s}` : s;
    }
    if (cell.gameDate) carry = { gameDate: cell.gameDate, gameTime: '', matchup: '', team: '' };
    if (cell.gameTime) carry.gameTime = cell.gameTime;
    if (cell.matchup) carry = { ...carry, matchup: cell.matchup, team: '' };
    if (cell.team) carry.team = cell.team;
    if (cell.player && cell.status) {
      rows.push({ gameDate: carry.gameDate, gameTime: carry.gameTime, matchup: carry.matchup, team: carry.team, player: cell.player, status: cell.status, reason: cell.reason || '' });
    } else if (cell.reason && !cell.player && rows.length) {
      rows[rows.length - 1].reason = `${rows[rows.length - 1].reason} ${cell.reason}`.trim(); // wrapped reason
    } else if (cell.player && !cell.status && /NOT YET SUBMITTED/i.test(cell.reason || cell.player)) {
      rows.push({ ...carry, player: '', status: 'NOT YET SUBMITTED', reason: '' });
    } else if (cell.reason && /NOT YET SUBMITTED/i.test(cell.reason)) {
      rows.push({ ...carry, player: '', status: 'NOT YET SUBMITTED', reason: '' });
    }
  }
  return rows;
}

/** Full pipeline: bytes -> rows. Never throws. UNVERIFIED on real NBA PDFs. */
export async function parseInjuryReportPdf(bytes) {
  const { lines, error } = await extractPdfText(bytes);
  if (error && !lines.length) return { rows: [], lines: [], error, unverified: true };
  const rows = parseInjuryReportLines(lines);
  return { rows, lines, error: rows.length ? null : 'no injury rows parsed', unverified: true };
}
