// ============================================================
//  dizipal — Nuvio scraper (dizipal2138.com: dizi + film)
//  Akış: TMDB (ad) -> /arama?q= (+ adres tahmini) -> bölüm/film sayfası -> player (embed) adresi
//        -> embed sayfası (packed JS çözülür) -> m3u8 (+ yerleşik altyazı .vtt) -> akış
// ============================================================

var AYAR = {
  SITELER: ['https://dizipal2138.com', 'https://dizipal2139.com'],   // adres değişirse sıradakine geçer
  EKLENTI_ADI: 'Dizipal',
  DEBUG_MODU: true,     // true: akış çıkmazsa neden çıkmadığını yazan DEBUG satırları görünür
  MAX_ADAY: 3,          // en fazla kaç aday dizi/film sayfası denensin
  MAX_SORGU: 3,         // en fazla kaç arama yapılsın
  MAX_EMBED: 3,         // en fazla kaç player (embed) çözülsün
  SES_SIRA: 2,          // HLS listesinde "index-v1-a2.m3u8" gibi ses sırası varsa bunu seç (0 = hepsini göster)
  ALTYAZI: true,        // yerleşik altyazıları bul
  ARAMA_SURESI: 5000,   // ms
  SUNUCU_SURESI: 6000,  // ms
  GENEL_SURE: 24000     // ms
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'dizipal';
var UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';
var dbg = [];

// ---------------- Yardımcılar ----------------
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function waitWithin(promises, ms) {
  return new Promise(function (resolve) {
    var left = promises.length, done = false;
    if (!left) { resolve(); return; }
    var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, ms);
    promises.forEach(function (p) {
      p.then(function () {}, function () {}).then(function () {
        left--;
        if (left === 0 && !done) { done = true; clearTimeout(t); resolve(); }
      });
    });
  });
}
function uniq(list) { var o = []; list.forEach(function (x) { if (x && o.indexOf(x) === -1) o.push(x); }); return o; }
function getJson(url) { return withTimeout(fetch(url), 10000).then(function (r) { return r.json(); }); }
function hdr(ref, extra) {
  var h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' };
  if (ref) h['Referer'] = ref;
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}
function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
var TRM = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/[çğıöşüâîû]/g, function (c) { return TRM[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }
function slugify(s) { return asciiLower(s).replace(/&/g, ' ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
var STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, ve: 1, izle: 1 };
function toks(s) { return asciiLower(s).split(/[^a-z0-9]+/).filter(function (t) { return t && !STOP[t]; }); }
function simScore(a, b) {
  var na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.length >= 4 && nb.length >= 4 && (na.indexOf(nb) > -1 || nb.indexOf(na) > -1)) {
    return 55 + Math.round(30 * Math.min(na.length, nb.length) / Math.max(na.length, nb.length));
  }
  var ta = toks(a), tb = toks(b);
  if (!ta.length || !tb.length) return 0;
  var common = ta.filter(function (x) { return tb.indexOf(x) > -1; }).length;
  return Math.round(60 * common / Math.max(ta.length, tb.length));
}
function hostOf(u) { var m = String(u || '').match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].toLowerCase() : ''; }
function originOf(u) { var m = String(u || '').match(/^(https?:\/\/[^\/?#]+)/i); return m ? m[1] : ''; }
function fixUrl(u) {
  u = decodeHtml(String(u || '')).replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').split('#')[0];
  return u.indexOf('//') === 0 ? 'https:' + u : u;
}
function relUrl(u, base) {
  u = String(u || '').trim();
  if (/^https?:/i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return originOf(base) + u;
  return String(base).replace(/[?#].*$/, '').replace(/\/[^\/]*$/, '/') + u;
}
// base64 (atob her ortamda olmayabilir) -> UTF-8 metin
function b64d(s) {
  var C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var bytes = [], bits = 0, val = 0, i;
  for (i = 0; i < s.length; i++) {
    val = ((val << 6) | C.indexOf(s.charAt(i))) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 255); }
  }
  try { return decodeURIComponent(bytes.map(function (b) { return '%' + ('0' + b.toString(16)).slice(-2); }).join('')); }
  catch (e) { return bytes.map(function (b) { return String.fromCharCode(b); }).join(''); }
}
// Dean Edwards packer: eval(function(p,a,c,k,e,d){...}('...',62,300,'a|b'.split('|'),0,{}))
function unpackAll(text) {
  var out = [], re = /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/g, m;
  while ((m = re.exec(text)) !== null) {
    try {
      var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'), a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
      var enc = function (n) { return (n < a ? '' : enc(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); };
      while (c--) { if (k[c]) { (function (kk) { p = p.replace(new RegExp('\\b' + enc(c) + '\\b', 'g'), function () { return kk; }); })(k[c]); } }
      out.push(p);
    } catch (e) {}
  }
  return out;
}


function cookieOf(res) {
  var raw = '';
  try { raw = String(res.headers.get('set-cookie') || ''); } catch (e) {}
  if (!raw) return '';
  return raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/).map(function (c) { return c.split(';')[0].trim(); }).filter(Boolean).join('; ');
}
// { status, url (yönlendirme sonrası), ct, text, media, cookie }
function fetchInfo(url, headers, wantText) {
  return withTimeout(fetch(url, { headers: headers }), AYAR.SUNUCU_SURESI).then(function (res) {
    var ct = ''; try { ct = String(res.headers.get('content-type') || ''); } catch (e) {}
    var fin = res.url || url;
    var ck = cookieOf(res);
    if (!wantText && /^(video|audio)\/|mpegurl|dash\+xml|octet-stream/i.test(ct)) return { status: res.status, url: fin, ct: ct, text: '', media: true, cookie: ck };
    return withTimeout(res.text(), 6000).then(
      function (t) { return { status: res.status, url: fin, ct: ct, text: t || '', media: false, cookie: ck }; },
      function () { return { status: res.status, url: fin, ct: ct, text: '', media: false, cookie: ck }; });
  }).catch(function (e) { return { status: 0, url: url, ct: '', text: '', media: false, err: (e && e.message) || 'hata' }; });
}
// Site adresi değişmiş / erişilemiyorsa sıradaki adresi dene
function fetchSite(path) {
  var i = 0;
  function next() {
    if (i >= AYAR.SITELER.length) return Promise.resolve({ status: 0, url: '', ct: '', text: '', media: false });
    var base = AYAR.SITELER[i++];
    return fetchInfo(base + path, hdr(base + '/'), true).then(function (r) {
      r.base = base;
      if (r.status === 0 || r.status >= 500 || r.status === 403) return next().then(function (r2) { return r2.status ? r2 : r; });
      return r;
    });
  }
  return next();
}

// ---------------- Arama ----------------
function parseSearch(html) {
  var map = {}, order = [], m;
  html = String(html || '');
  var re = /href=["'](?:https?:\/\/[^\/"']+)?\/(dizi|film)\/([a-z0-9\-]+)\/?["']([^>]*)>/gi;
  while ((m = re.exec(html)) !== null) {
    var kind = m[1], slug = m[2], path = '/' + kind + '/' + slug;
    var end = html.indexOf('</a>', m.index);
    var ctx = html.slice(m.index, end > -1 && end - m.index < 1500 ? end + 4 : m.index + 600);
    var titles = [], t1 = (m[3] || '').match(/title=["']([^"']+)["']/i), t2 = ctx.match(/alt=["']([^"']{2,80})["']/i), t3 = ctx.match(/>\s*([^<>]{2,80}?)\s*<\/(?:span|h\d|div|p|a)/i);
    [t1 && t1[1], t2 && t2[1], t3 && t3[1]].forEach(function (t) { t = decodeHtml(t || '').trim(); if (t && !/^reklam$/i.test(t)) titles.push(t); });
    titles.push(slug.replace(/-/g, ' '));
    var ym = html.slice(m.index, m.index + 900).match(/\b((?:19|20)\d{2})\b/);
    if (!map[path]) { map[path] = { path: path, kind: kind, titles: [], year: 0 }; order.push(path); }
    titles.forEach(function (t) { if (map[path].titles.indexOf(t) === -1) map[path].titles.push(t); });
    if (ym && !map[path].year) map[path].year = parseInt(ym[1], 10);
  }
  return order.map(function (p) { return map[p]; });
}

// ---------------- Player (embed) adresi ----------------
function findEmbeds(html) {
  var out = [], seen = {}, m;
  function add(u) {
    u = fixUrl(u);
    if (!/^https?:/i.test(u) || seen[u]) return;
    if (/google|youtube|facebook|twitter|blogger|googletagmanager|cloudflare|shrgo|t\.ly|bit\.ly|cutt\.ly|sivo\.|rebrand|gshort|girgara|rogagir/i.test(hostOf(u))) return;
    if (AYAR.SITELER.some(function (s) { return hostOf(s) === hostOf(u); })) return;
    seen[u] = true; out.push(u);
  }
  function scan(t) {
    var re = /<iframe[^>]+src=["']([^"']+)["']/gi, mm;
    while ((mm = re.exec(t)) !== null) add(mm[1]);
    var re2 = /https?:\\?\/\\?\/[a-z0-9.\-]+\\?\/(?:embed-|embed\/|e\/|v\/)[A-Za-z0-9_\-]+(?:\.html)?/gi;
    while ((mm = re2.exec(t)) !== null) add(mm[0]);
  }
  html = String(html || '');
  scan(html);
  if (!out.length) {                                     // sayfada saklanan base64 / JSON bloklarına bak
    var re3 = /(?:aHR0c|eyJ)[A-Za-z0-9+\/=_\-]{20,}/g, n = 0;
    while ((m = re3.exec(html)) !== null && n++ < 40) scan(b64d(m[0]));
  }
  return out;
}

// ---------------- Embed çözme ----------------
var LANGN = { tur: 'Türkçe', eng: 'İngilizce', en: 'İngilizce', tr: 'Türkçe', ger: 'Almanca', fre: 'Fransızca', spa: 'İspanyolca', ara: 'Arapça', rus: 'Rusça' };
function subLang(label, url) {
  var l = asciiLower(label || '');
  if (/turk|^tr$|\btur\b/.test(l)) return 'tur';
  if (/engl|ingiliz|^en$|\beng\b/.test(l)) return 'eng';
  var m = String(url).match(/_([a-z]{2,3})\.(?:vtt|srt)/i);
  return m ? m[1].toLowerCase() : 'und';
}
function mkSub(url, label) {
  var lang = subLang(label, url);
  return { url: url, lang: lang, label: LANGN[lang] || label || lang };
}
function scanText(t, origin) {
  t = fixUrl(t);
  var res = { hls: [], mp4: [], subs: [] }, seen = {}, m;
  function push(arr, u) { if (!seen[u]) { seen[u] = true; arr.push(u); } }
  var re = /https?:\/\/[^\s"'<>\\)]+?\.m3u8(?:\?[^\s"'<>\\)]*)?/gi;
  while ((m = re.exec(t)) !== null) push(res.hls, m[0]);
  var reRel = /["'](\/[^"'\s]+?\.m3u8[^"'\s]*)["']/gi;
  while ((m = reRel.exec(t)) !== null) push(res.hls, origin + m[1]);
  var re2 = /https?:\/\/[^\s"'<>\\)]+?\.mp4(?:\?[^\s"'<>\\)]*)?/gi;
  while ((m = re2.exec(t)) !== null) push(res.mp4, m[0]);
  var re3 = /https?:\/\/[^\s"'<>\\)]+?\.(?:vtt|srt)(?:\?[^\s"'<>\\)]*)?/gi;
  while ((m = re3.exec(t)) !== null) {
    var ctx = t.slice(Math.max(0, m.index - 220), m.index + m[0].length + 220);
    var lb = ctx.match(/label\s*["']?\s*:\s*["']([^"']+)["']/i);
    if (!seen[m[0]]) { seen[m[0]] = true; res.subs.push(mkSub(m[0], lb && lb[1])); }
  }
  return res;
}

// Gizlenmiş (hex/unicode kaçışlı, url-kodlu, base64) metinleri de aç
function deepTexts(texts) {
  var out = [], seen = {};
  function add(t) { if (t && t.length > 8 && !seen[t]) { seen[t] = true; out.push(t); } }
  texts.forEach(function (t) {
    t = String(t || '');
    if (/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/.test(t)) {
      add(t.replace(/\\x([0-9a-fA-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }));
    }
    if (/%[0-9a-fA-F]{2}/.test(t)) { try { add(decodeURIComponent(t.replace(/%(?![0-9a-fA-F]{2})/g, '%25'))); } catch (e) {} }
    var re = /[A-Za-z0-9+\/_\-]{28,}={0,2}/g, m, n = 0;
    while ((m = re.exec(t)) !== null && n++ < 400) {
      var d = b64d(m[0]);
      if (/https?:\/\/|\.m3u8|\.mp4|"file"|sources/i.test(d) && d.length > 12) add(d);
    }
  });
  return out;
}
function resolveEmbed(embedUrl, pageUrl, depth) {
  var origin = originOf(embedUrl);
  return fetchInfo(embedUrl, hdr(pageUrl), true).then(function (r) {
    var texts = [r.text || ''].concat(unpackAll(r.text || ''));
    texts = texts.concat(deepTexts(texts));
    var found = { hls: [], mp4: [], subs: [], origin: origin };
    texts.forEach(function (t) {
      var s = scanText(t, origin);
      found.hls = found.hls.concat(s.hls); found.mp4 = found.mp4.concat(s.mp4); found.subs = found.subs.concat(s.subs);
    });
    found.hls = uniq(found.hls); found.mp4 = uniq(found.mp4);
    dbg.push('embed ' + hostOf(embedUrl) + ' ' + (r.status || r.err) + ' ' + (r.text || '').length + 'b hls=' + found.hls.length + ' mp4=' + found.mp4.length + ' altyazi=' + found.subs.length);
    if (!found.hls.length && !found.mp4.length) {
      var raw = String(r.text || ''), scr = [], ms, rs = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      while ((ms = rs.exec(raw)) !== null && scr.length < 10) scr.push(ms[1].length + ':' + ms[1].slice(0, 28).replace(/\s+/g, ' '));
      dumpLong('zF', 'metin=' + texts.length + ' scriptler ' + scr.join(' | '), 110, 4);
      var oi = raw.search(/var\s+_[0-9a-z]{5,8}\s*=\s*function/);
      if (oi > -1) dumpLong('zG', raw.slice(oi, oi + 700), 110, 7);
      var si = raw.search(/setup\s*\(/);
      if (si > -1) dumpLong('zH', raw.slice(Math.max(0, si - 120), si + 380), 110, 5);
      var fi = raw.search(/\.m3u8|"file"|sources\s*:/i);
      if (fi > -1) dumpLong('zI', raw.slice(Math.max(0, fi - 100), fi + 300), 110, 4);
    }
    if (!found.hls.length && !found.mp4.length && (depth || 0) < 1) {     // iç içe iframe
      var inner = findEmbeds(r.text || '');
      if (inner.length) return resolveEmbed(inner[0], embedUrl, 1);
    }
    return found;
  });
}
function qualOf(h) { return h ? h + 'p' : 'Auto'; }
// Ana liste (master) mı? Ses sırasına göre varyant seç, yerleşik altyazı satırlarını al
function inspectHls(url, ref) {
  return fetchInfo(url, hdr(ref, { 'Origin': String(ref).replace(/\/$/, '') }), true).then(function (r) {
    var t = r.text || '', base = r.url || url;
    if (t.indexOf('#EXT-X-STREAM-INF') === -1) return { list: [{ url: url, quality: 'Auto' }], subs: [] };
    var lines = t.split(/\r?\n/), vars = [], subs = [], i, j;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^#EXT-X-STREAM-INF:/.test(ln)) {
        var uri = '';
        for (j = i + 1; j < lines.length; j++) { if (lines[j] && lines[j].charAt(0) !== '#') { uri = lines[j].trim(); break; } }
        if (uri) vars.push({ url: relUrl(uri, base), bw: parseInt((ln.match(/BANDWIDTH=(\d+)/) || [])[1], 10) || 0, h: parseInt((ln.match(/RESOLUTION=\d+x(\d+)/) || [])[1], 10) || 0 });
      } else if (/^#EXT-X-MEDIA:/.test(ln) && /TYPE=SUBTITLES/.test(ln)) {
        var su = (ln.match(/URI="([^"]+)"/) || [])[1];
        if (su && /\.(vtt|srt)(\?|$)/i.test(su)) subs.push(mkSub(relUrl(su, base), (ln.match(/NAME="([^"]+)"/) || [])[1] || (ln.match(/LANGUAGE="([^"]+)"/) || [])[1]));
      }
    }
    var byAudio = {};
    vars.forEach(function (v) {
      var m = v.url.match(/-a(\d+)\.m3u8/i);
      if (m) { var k = parseInt(m[1], 10); if (!byAudio[k] || v.bw > byAudio[k].bw || v.h > byAudio[k].h) byAudio[k] = v; }
    });
    var keys = Object.keys(byAudio), list;
    if (keys.length && AYAR.SES_SIRA && byAudio[AYAR.SES_SIRA]) {
      list = [{ url: byAudio[AYAR.SES_SIRA].url, quality: qualOf(byAudio[AYAR.SES_SIRA].h) }];
    } else if (keys.length > 1) {
      list = keys.map(function (k) { return { url: byAudio[k].url, quality: qualOf(byAudio[k].h), ses: k }; });
    } else {
      list = [{ url: url, quality: 'Auto' }];
    }
    return { list: list, subs: subs, variants: vars.map(function (v) { return v.url; }) };
  });
}
// /hls2/01/00009/<kod>_h/...  ->  /vtt/01/00009/<kod>_tur.vtt
function guessVtt(u) {
  var m = String(u).match(/^(https?:\/\/[^\/]+)\/hls\d*\/(\d+)\/(\d+)\/([a-z0-9]+)_[a-z0-9]+\//i);
  if (!m) return [];
  return ['tur', 'eng'].map(function (l) { return mkSub(m[1] + '/vtt/' + m[2] + '/' + m[3] + '/' + m[4] + '_' + l + '.vtt', l); });
}
function verifySub(s, ref) {
  return fetchInfo(s.url, hdr(ref, { 'Origin': String(ref).replace(/\/$/, '') }), true).then(function (r) { return (r.status === 200 && /^\s*WEBVTT/.test(r.text || '')) ? s : null; });
}


// ---------------- Oyuncu ayarı: /ajax-player-config (AES-CBC, anahtar = k1 XOR k2) ----------------
function b64bytes(s) {
  var C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = [], bits = 0, val = 0, i;
  for (i = 0; i < s.length; i++) {
    val = ((val << 6) | C.indexOf(s.charAt(i))) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 255); }
  }
  return out;
}
var AES = { sb: null, isb: null };
function aesInit() {
  if (AES.sb) return;
  var sb = new Array(256), isb = new Array(256), p = 1, q = 1, x;
  function rotl(v, n) { return ((v << n) | (v >> (8 - n))) & 255; }
  do {
    p = (p ^ ((p << 1) & 255) ^ ((p & 0x80) ? 0x1b : 0)) & 255;
    q ^= (q << 1) & 255; q ^= (q << 2) & 255; q ^= (q << 4) & 255; if (q & 0x80) q ^= 0x09;
    x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4);
    sb[p] = (x ^ 0x63) & 255;
  } while (p !== 1);
  sb[0] = 0x63;
  for (x = 0; x < 256; x++) isb[sb[x]] = x;
  AES.sb = sb; AES.isb = isb;
}
function gmul(a, b) { var r = 0; while (b) { if (b & 1) r ^= a; a = ((a << 1) ^ ((a & 0x80) ? 0x11b : 0)) & 255; b >>= 1; } return r; }
function aesCbcDecrypt(key, iv, data) {
  aesInit();
  var sb = AES.sb, isb = AES.isb, nk = key.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) return null;
  if (!data.length || data.length % 16 || iv.length !== 16) return null;
  var nr = nk + 6, w = key.slice(), i, j, r, c, t, rcon = 1;
  for (i = nk; i < 4 * (nr + 1); i++) {
    t = [w[4 * i - 4], w[4 * i - 3], w[4 * i - 2], w[4 * i - 1]];
    if (i % nk === 0) { t = [sb[t[1]] ^ rcon, sb[t[2]], sb[t[3]], sb[t[0]]]; rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x11b : 0)) & 255; }
    else if (nk > 6 && i % nk === 4) t = [sb[t[0]], sb[t[1]], sb[t[2]], sb[t[3]]];
    for (j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - nk) + j] ^ t[j];
  }
  var out = [], prev = iv.slice(), off, blk, s, u, a0, a1, a2, a3;
  for (off = 0; off < data.length; off += 16) {
    blk = data.slice(off, off + 16); s = blk.slice();
    for (j = 0; j < 16; j++) s[j] ^= w[16 * nr + j];
    for (r = nr - 1; r >= 0; r--) {
      u = s.slice();
      for (c = 0; c < 4; c++) for (j = 0; j < 4; j++) s[4 * c + j] = u[4 * ((c - j + 4) % 4) + j];
      for (j = 0; j < 16; j++) s[j] = isb[s[j]];
      for (j = 0; j < 16; j++) s[j] ^= w[16 * r + j];
      if (r > 0) {
        for (c = 0; c < 4; c++) {
          a0 = s[4 * c]; a1 = s[4 * c + 1]; a2 = s[4 * c + 2]; a3 = s[4 * c + 3];
          s[4 * c]     = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
          s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
          s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
          s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
        }
      }
    }
    for (j = 0; j < 16; j++) out.push(s[j] ^ prev[j]);
    prev = blk;
  }
  var pad = out[out.length - 1];
  if (!(pad >= 1 && pad <= 16)) return null;
  out.length -= pad;
  return out;
}
function bytesToStr(b) {
  try { return decodeURIComponent(b.map(function (x) { return '%' + ('0' + x.toString(16)).slice(-2); }).join('')); }
  catch (e) { return b.map(function (x) { return String.fromCharCode(x); }).join(''); }
}
function decryptEnc(enc) {
  try {
    var k1 = b64bytes(enc.k1), k2 = b64bytes(enc.k2), iv = b64bytes(enc.iv), ct = b64bytes(enc.c), n = Math.min(k1.length, k2.length), key = [], i;
    for (i = 0; i < n; i++) key.push(k1[i] ^ k2[i]);
    var plain = aesCbcDecrypt(key, iv, ct);
    if (!plain && n > 32) plain = aesCbcDecrypt(key.slice(0, 32), iv, ct);
    return plain ? bytesToStr(plain) : null;
  } catch (e) { return null; }
}
function postForm(url, body, headers) {
  return withTimeout(fetch(url, { method: 'POST', headers: headers, body: body }), 5000).then(function (res) {
    return withTimeout(res.text(), 6000).then(
      function (t) { return { status: res.status, text: t || '' }; },
      function () { return { status: res.status, text: '' }; });
  }).catch(function (e) { return { status: 0, text: '', err: (e && e.message) || 'hata' }; });
}
function dumpLong(tag, str, size, max) {
  str = String(str || '').replace(/\s+/g, ' ');
  for (var i = 0; i < max && i * size < str.length; i++) dbg.push(tag + (i + 1) + ' ' + str.substr(i * size, size));
}
// Sayfadaki #videoContainer[data-cfg] -> POST /ajax-player-config -> { t, v, p }
function parseConfigResp(r, tag) {
  var o = null; try { o = JSON.parse(r.text); } catch (e) {}
  if (!o) { dbg.push(tag + ' ' + (r.status || r.err) + ' ' + r.text.length + 'b ' + r.text.slice(0, 90).replace(/\s+/g, ' ')); return null; }
  var c = o.config || {};
  if (o.enc) { var v = decryptEnc(o.enc); dbg.push(tag + ' sifre ' + (v ? 'ok' : 'COZULEMEDI')); if (v) c.v = v; }
  if (!c.v) { dbg.push(tag + ' ' + (r.status || r.err) + ' ' + JSON.stringify(o).slice(0, 110)); return null; }
  dbg.push(tag + ' oyuncu t=' + (c.t || 'embed') + ' ' + String(c.v).slice(0, 100));
  return c;
}
function getPlayerConfig(html, base, pageUrl, pageCookie) {
  html = String(html || '');
  var tag = html.match(/<[^>]*id=["']videoContainer["'][^>]*>/i);
  var cm = (tag && tag[0].match(/data-cfg=["']([^"']+)["']/i)) || html.match(/data-cfg=["']([^"']+)["']/i);
  if (!cm) { dbg.push('cfg yok'); return Promise.resolve(null); }
  var cfg = decodeHtml(cm[1]), url = base + '/ajax-player-config';
  var csrfM = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  var csrf = csrfM ? csrfM[1] : '';
  dbg.push('cfg ' + cfg.length + ' cookie=' + (pageCookie ? pageCookie.length : 0) + ' csrf=' + (csrf ? 1 : 0));
  var ct = 'application/x-www-form-urlencoded; charset=UTF-8';
  function H(extra) { return hdr(pageUrl, extra); }
  // A: tarayıcıdaki gibi
  var hA = { 'Content-Type': ct, 'X-Requested-With': 'XMLHttpRequest', 'Origin': base, 'Accept': 'application/json, text/javascript, */*; q=0.01' };
  if (pageCookie) hA['Cookie'] = pageCookie;
  return postForm(url, 'cfg=' + encodeURIComponent(cfg), H(hA)).then(function (r) {
    var c = parseConfigResp(r, 'A');
    if (c) return c;
    // B: ajax-token + csrf
    return fetchInfo(base + '/ajax-token', H({ 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'Cookie': pageCookie || '' }), true).then(function (tr) {
      var tok = ''; try { tok = JSON.parse(tr.text).t || ''; } catch (e) {}
      dbg.push('token ' + (tr.status || tr.err) + ' ' + (tok ? tok.length : 0) + ' cookie=' + (tr.cookie ? 1 : 0));
      var ck = [pageCookie, tr.cookie, tok ? '_ct=' + tok : ''].filter(Boolean).join('; ');
      var hB = { 'Content-Type': ct, 'X-Requested-With': 'XMLHttpRequest', 'Origin': base, 'Accept': 'application/json, text/javascript, */*; q=0.01' };
      if (ck) hB['Cookie'] = ck;
      if (csrf || tok) hB['X-CSRF-Token'] = csrf || tok;
      var body = 'cfg=' + encodeURIComponent(cfg) + (tok ? '&token=' + encodeURIComponent(tok) + '&csrf_token=' + encodeURIComponent(tok) : (csrf ? '&csrf_token=' + encodeURIComponent(csrf) : ''));
      return postForm(url, body, H(hB)).then(function (r2) {
        var c2 = parseConfigResp(r2, 'B');
        if (c2) return c2;
        // C: sade istek
        return postForm(url, 'cfg=' + encodeURIComponent(cfg), { 'Content-Type': ct, 'User-Agent': UA, 'Referer': pageUrl }).then(function (r3) { return parseConfigResp(r3, 'C'); });
      });
    });
  });
}
function configTargets(c, base) {
  var t = String(c.t || 'embed').toLowerCase(), v = String(c.v || ''), res = { embeds: [], direct: null }, u;
  if (t === 'm3u8' || t === 'mp4') {
    u = fixUrl(v);
    res.direct = { hls: t === 'm3u8' ? [u] : [], mp4: t === 'mp4' ? [u] : [], subs: [], origin: base };
  } else if (v.indexOf('<iframe') > -1) {
    var m = v.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (m) res.embeds = [fixUrl(m[1]).split('#')[0]];
  } else {
    u = fixUrl(v).split('#')[0];
    if (/^https?:/i.test(u)) res.embeds = [u];
  }
  return res;
}

// ---------------- Ana akış ----------------
function debugStream(msg) {
  if (!AYAR.DEBUG_MODU) return [];
  return [msg].concat(dbg.slice(0, 120)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}
function buildStreams(found, pageUrl, label) {
  var ref = (found.origin || originOf(pageUrl)) + '/';
  var headers = { 'User-Agent': UA, 'Referer': ref, 'Origin': ref.replace(/\/$/, '') };
  var subsAll = found.subs.slice(), items = [];
  var hlsJobs = found.hls.slice(0, 3).map(function (u) {
    return inspectHls(u, ref).then(function (x) {
      x.list.forEach(function (it) { items.push({ url: it.url, quality: it.quality, ses: it.ses, src: u }); });
      subsAll = subsAll.concat(x.subs);
      guessVtt(u).concat((x.variants || []).slice(0, 1).reduce(function (a, v) { return a.concat(guessVtt(v)); }, [])).forEach(function (g) { subsAll.push(g); });
    });
  });
  found.mp4.slice(0, 2).forEach(function (u) { items.push({ url: u, quality: 'Auto', src: u, mp4: true }); });
  return waitWithin(hlsJobs, AYAR.SUNUCU_SURESI).then(function () {
    var seenS = {}, subs = [];
    subsAll.forEach(function (s) { if (!seenS[s.url]) { seenS[s.url] = true; subs.push(s); } });
    var verify = AYAR.ALTYAZI ? subs.map(function (s) {
      // sayfadan/ana listeden gelenler zaten gerçek; sadece tahmin edilenleri doğrula
      var guessed = /\/vtt\/\d+\/\d+\/[a-z0-9]+_[a-z]{3}\.vtt/i.test(s.url) && found.subs.every(function (f) { return f.url !== s.url; });
      return guessed ? verifySub(s, ref).catch(function () { return null; }) : Promise.resolve(s);
    }) : [];
    return Promise.all(verify).then(function (vs) {
      var good = vs.filter(Boolean).sort(function (a, b) { return (a.lang === 'tur' ? 0 : 1) - (b.lang === 'tur' ? 0 : 1); });
      var seen = {};
      return items.filter(function (it) { if (seen[it.url]) return false; seen[it.url] = true; return true; }).map(function (it) {
        var parts = ['Dizipal', it.mp4 ? 'MP4' : 'HLS'];
        if (it.ses) parts.push('Ses ' + it.ses);
        parts.push(it.quality);
        if (good.length) parts.push('Altyazı');
        var st = { name: AYAR.EKLENTI_ADI, title: parts.join(' | '), url: it.url, quality: it.quality, headers: headers, provider: PROVIDER_ID };
        if (it.mp4) st.type = 'mp4';
        if (good.length) st.subtitles = good.map(function (s) { return { url: s.url, lang: s.lang, label: s.label, id: s.lang }; });
        return st;
      });
    });
  });
}

function getStreamsInner(tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv';
  if (!isTv && mediaType !== 'movie') return Promise.resolve([]);
  season = parseInt(season, 10) || 1; episode = parseInt(episode, 10) || 1;
  dbg = ['dizipal v1.3.0'];
  var base = 'https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_KEY;
  return Promise.all([
    getJson(base + '&language=tr-TR&append_to_response=alternative_titles'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var tr = both[0] || {}, en = both[1] || {};
    var year = parseInt(((isTv ? tr.first_air_date : tr.release_date) || (isTv ? en.first_air_date : en.release_date) || '').slice(0, 4), 10) || 0;
    var alts = [];
    try {
      var at = tr.alternative_titles || {};
      (at.results || at.titles || []).forEach(function (a) { if (a && a.title && /^(TR|US|GB)$/.test(a.iso_3166_1 || '')) alts.push(a.title); });
    } catch (e) {}
    var names = uniq(isTv ? [tr.name, en.name, tr.original_name].concat(alts.slice(0, 4)) : [tr.title, en.title, tr.original_title].concat(alts.slice(0, 4)));
    if (!names.length) return debugStream('TMDB bilgisi eksik');
    var kind = isTv ? 'dizi' : 'film';
    dbg.push((isTv ? 'dizi ' : 'film ') + names[0] + ' ' + year + (isTv ? ' S' + season + 'E' + episode : ''));

    var sinks = [], jobs = [];
    names.slice(0, AYAR.MAX_SORGU).forEach(function (q) {
      var sink = []; sinks.push(sink);
      jobs.push(fetchSite('/arama?q=' + encodeURIComponent(q)).then(function (r) {
        var items = r.status === 200 ? parseSearch(r.text).filter(function (x) { return x.kind === kind; }) : [];
        dbg.push('ara "' + q + '" ' + (r.status || r.err) + ' n=' + items.length);
        sink.push.apply(sink, items);
      }));
    });
    return waitWithin(jobs, AYAR.ARAMA_SURESI).then(function () {
      var cand = {};
      sinks.forEach(function (l) { l.forEach(function (it) { if (!cand[it.path]) cand[it.path] = it; }); });
      names.forEach(function (n) {                                    // adres tahmini
        var sl = slugify(n);
        if (sl && !cand['/' + kind + '/' + sl]) cand['/' + kind + '/' + sl] = { path: '/' + kind + '/' + sl, kind: kind, titles: [n], year: 0, guess: true };
      });
      var ranked = Object.keys(cand).map(function (p) {
        var c = cand[p], best = 0;
        c.titles.forEach(function (t) { names.forEach(function (n) { best = Math.max(best, simScore(t, n)); }); });
        if (c.guess) best = Math.min(best, 75);
        if (c.year && year) { var d = Math.abs(c.year - year); best += d === 0 ? 20 : (d === 1 ? 10 : (d > 3 ? -25 : 0)); }
        return { c: c, score: best };
      }).filter(function (x) { return x.score >= 50; }).sort(function (a, b) { return b.score - a.score; }).slice(0, AYAR.MAX_ADAY);
      dbg.push('aday ' + ranked.map(function (x) { return x.c.path + ':' + x.score; }).join(' '));
      if (!ranked.length) return debugStream('icerik bulunamadi');

      var pages = ranked.map(function () { return null; });
      var pj = ranked.map(function (x, i) {
        var path = isTv ? '/bolum/' + x.c.path.replace('/dizi/', '') + '-' + season + '-sezon-' + episode + '-bolum' : x.c.path;
        return fetchSite(path).then(function (r) {
          var base = r.base || AYAR.SITELER[0], pageUrl = base + path, html = r.status === 200 ? (r.text || '') : '';
          dbg.push('sayfa ' + path + ' ' + (r.status || r.err) + ' ' + html.length + 'b');
          if (!html) return;
          return getPlayerConfig(html, base, pageUrl, r.cookie || '').then(function (cfg) {
            var t = cfg ? configTargets(cfg, base) : { embeds: [], direct: null };
            if (!t.embeds.length && !t.direct) t.embeds = findEmbeds(html);
            dbg.push('player embed=' + t.embeds.length + (t.direct ? ' direct' : ''));
            if (t.embeds.length || t.direct) pages[i] = { url: pageUrl, embeds: t.embeds, direct: t.direct };
          });
        });
      });
      return waitWithin(pj, 10000).then(function () {
        var pg = null;
        pages.forEach(function (p) { if (!pg && p) pg = p; });
        if (!pg) return debugStream('sayfa/player bulunamadi');
        var results = [];
        var ej = pg.embeds.slice(0, AYAR.MAX_EMBED).map(function (e, i) {
          return resolveEmbed(e, pg.url, 0).then(function (found) {
            if (!found.hls.length && !found.mp4.length) return;
            return buildStreams(found, pg.url).then(function (st) { results[i] = st; });
          });
        });
        if (pg.direct) ej.push(buildStreams(pg.direct, pg.url).then(function (st) { results[99] = st; }));
        return waitWithin(ej, AYAR.SUNUCU_SURESI + 3000).then(function () {
          var streams = [], seen = {};
          results.forEach(function (l) { (l || []).forEach(function (s) { if (!seen[s.url]) { seen[s.url] = true; streams.push(s); } }); });
          if (!streams.length) return debugStream('video linki cikmadi');
          return AYAR.DEBUG_MODU ? streams.concat(debugStream('akis: ' + streams.length)) : streams;
        });
      });
    });
  }).catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(debugStream('zaman asimi ' + AYAR.GENEL_SURE + 'ms')); } }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    }, function () { if (!done) { done = true; clearTimeout(timer); resolve([]); } });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { parseSearch: parseSearch, findEmbeds: findEmbeds, unpackAll: unpackAll, scanText: scanText, b64d: b64d } };
} else {
  global.getStreams = getStreams;
}
