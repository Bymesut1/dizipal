// Dizipal - Nuvio scraper (dizi + film)
// CloudStream Dizipal.kt eklentisinin Nuvio karşılığı. Promise zincirleri kullanır (async/await yok).
// Akış: TMDB id -> başlık -> site araması -> sayfa (doğrulama ekranı PoW ile geçilir)
//       -> /ajax-player-config -> m3u8 / mp4 / iframe -> FirePlayer vb. çözümü

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';

// Site adresi değişirse sıradakine geçilir
var BASES = [
    'https://dizipal2143.com',
    'https://dizipal2144.com',
    'https://dizipal2145.com',
    'https://dizipal2142.com'
];

var UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

var DEBUG = false;

var mainUrl = BASES[0];
var jars = {}; // host -> { çerez adı: değer }

function log() {
    if (DEBUG && typeof console !== 'undefined') {
        console.log.apply(console, ['[Dizipal]'].concat([].slice.call(arguments)));
    }
}

// ------------------------------------------------------------------
// Genel yardımcılar
// ------------------------------------------------------------------
function hostOf(u) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(u || '');
    return m ? m[1].toLowerCase() : '';
}

function originOf(u) {
    var m = /^(https?:\/\/[^\/?#]+)/i.exec(u || '');
    return m ? m[1] : '';
}

function resolveUrl(base, ref) {
    if (!ref) return base;
    if (/^https?:\/\//i.test(ref)) return ref;
    if (ref.indexOf('//') === 0) return 'https:' + ref;
    var o = originOf(base);
    if (ref.charAt(0) === '/') return o + ref;
    var dir = base.replace(/[?#].*$/, '');
    dir = dir.substring(0, dir.lastIndexOf('/') + 1);
    return dir + ref;
}

function fixText(s) {
    return String(s)
        .replace(/\\u002F/gi, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
}

function decodeEntities(s) {
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function seq(arr, fn) {
    var out = [];
    var p = Promise.resolve();
    arr.forEach(function (x, i) {
        p = p.then(function () {
            return fn(x, i);
        }).then(function (r) {
            out.push(r);
        });
    });
    return p.then(function () {
        return out;
    });
}

function sleep(ms) {
    return new Promise(function (r) {
        setTimeout(r, ms);
    });
}

// ------------------------------------------------------------------
// HTTP + çerez deposu (RN fetch'inde Set-Cookie tek satır olarak gelir)
// ------------------------------------------------------------------
function cookieHeader(host) {
    var j = jars[host];
    if (!j) return '';
    var a = [];
    for (var k in j) a.push(k + '=' + j[k]);
    return a.join('; ');
}

function storeCookies(host, sc) {
    if (!sc) return;
    var j = jars[host] || (jars[host] = {});
    String(sc).split(/,(?=\s*[^;,=\s]+=)/).forEach(function (c) {
        var m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
        if (m) j[m[1]] = m[2];
    });
}

function http(method, url, opt) {
    opt = opt || {};
    var h = {};
    var src = opt.headers || {};
    for (var k in src) h[k] = src[k];
    if (!h['User-Agent']) h['User-Agent'] = UA;
    var host = hostOf(url);
    var ck = cookieHeader(host);
    if (ck && !h['Cookie']) h['Cookie'] = ck;
    var init = { method: method, headers: h };
    if (opt.body != null) init.body = opt.body;
    return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () {
            if (!done) {
                done = true;
                resolve(null);
            }
        }, opt.timeout || 15000);
        var fin = function (v) {
            if (!done) {
                done = true;
                clearTimeout(t);
                resolve(v);
            }
        };
        try {
            fetch(url, init).then(function (res) {
                var sc = null;
                try {
                    sc = res.headers.get('set-cookie');
                } catch (e) {}
                return res.text().then(function (text) {
                    storeCookies(host, sc);
                    fin({ status: res.status, text: text, url: url });
                });
            }).catch(function () {
                fin(null);
            });
        } catch (e) {
            fin(null);
        }
    });
}

function getText(url, headers) {
    return http('GET', url, { headers: headers || {} }).then(function (r) {
        return r ? r.text : '';
    });
}

// ------------------------------------------------------------------
// Base64 / UTF-8 / SHA-256 / AES-CBC (modül yok, saf JS)
// ------------------------------------------------------------------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64bin(s) {
    var c = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
    var out = [];
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < c.length; i++) {
        buf = (buf << 6) | B64.indexOf(c.charAt(i));
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 255);
            buf &= (1 << bits) - 1;
        }
    }
    return out;
}

function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
    return s;
}

function utf8Decode(bytes) {
    var s = '';
    var i = 0;
    while (i < bytes.length) {
        var b = bytes[i++];
        if (b < 128) {
            s += String.fromCharCode(b);
        } else if (b >= 192 && b < 224) {
            s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
        } else if (b >= 224 && b < 240) {
            s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        } else {
            var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            cp -= 0x10000;
            s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
        }
    }
    return s;
}

function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 128) {
            out.push(c);
        } else if (c < 2048) {
            out.push(192 | (c >> 6), 128 | (c & 63));
        } else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
            var cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
            out.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
        } else {
            out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
        }
    }
    return out;
}

var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256Hex(str) {
    var bytes = utf8Encode(str);
    var l = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor((l * 8) / 4294967296);
    var lo = (l * 8) >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
        (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
        var i;
        for (i = 0; i < 16; i++) {
            w[i] = ((bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3]) | 0;
        }
        for (i = 16; i < 64; i++) {
            var a15 = w[i - 15];
            var a2 = w[i - 2];
            var s0 = ((a15 >>> 7) | (a15 << 25)) ^ ((a15 >>> 18) | (a15 << 14)) ^ (a15 >>> 3);
            var s1 = ((a2 >>> 17) | (a2 << 15)) ^ ((a2 >>> 19) | (a2 << 13)) ^ (a2 >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (i = 0; i < 64; i++) {
            var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            var ch = (e & f) ^ (~e & g);
            var t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
            var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            var mj = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (S0 + mj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (var k = 0; k < 8; k++) hex += ('00000000' + (H[k] >>> 0).toString(16)).slice(-8);
    return hex;
}

var SBOX = new Array(256);
var INV_SBOX = new Array(256);
(function () {
    function rotl8(x, s) {
        return ((x << s) | (x >> (8 - s))) & 255;
    }
    var p = 1;
    var q = 1;
    do {
        p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1B : 0)) & 255;
        q = (q ^ (q << 1)) & 255;
        q = (q ^ (q << 2)) & 255;
        q = (q ^ (q << 4)) & 255;
        if (q & 0x80) q ^= 0x09;
        var x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
        SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (var i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hi = a & 0x80;
        a = (a << 1) & 255;
        if (hi) a ^= 0x1B;
        b >>= 1;
    }
    return p;
}

function aesExpand(key) {
    var Nk = key.length / 4;
    var Nr = Nk + 6;
    var w = [];
    var i;
    for (i = 0; i < Nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
    var rcon = 1;
    for (i = Nk; i < 4 * (Nr + 1); i++) {
        var t = w[i - 1].slice();
        if (i % Nk === 0) {
            t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
            rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1B : 0)) & 255;
        } else if (Nk > 6 && i % Nk === 4) {
            t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]];
        }
        w[i] = [w[i - Nk][0] ^ t[0], w[i - Nk][1] ^ t[1], w[i - Nk][2] ^ t[2], w[i - Nk][3] ^ t[3]];
    }
    return { w: w, Nr: Nr };
}

function aesDecBlock(ks, blk) {
    var s = blk.slice();
    var w = ks.w;
    var r;
    var c;
    var i;
    function addKey(round) {
        for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[4 * c + r] ^= w[4 * round + c][r];
    }
    function invShift() {
        var t = s.slice();
        for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[4 * ((c + r) % 4) + r] = t[4 * c + r];
    }
    function invSub() {
        for (i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    }
    function invMix() {
        for (c = 0; c < 4; c++) {
            var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
            s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
            s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
            s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
            s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
        }
    }
    addKey(ks.Nr);
    for (var round = ks.Nr - 1; round >= 1; round--) {
        invShift();
        invSub();
        addKey(round);
        invMix();
    }
    invShift();
    invSub();
    addKey(0);
    return s;
}

// AES-CBC + PKCS7; geçersizse null
function aesCbcDecrypt(key, iv, ct) {
    if ((key.length !== 16 && key.length !== 24 && key.length !== 32) || iv.length !== 16) return null;
    if (ct.length === 0 || ct.length % 16 !== 0) return null;
    var ks = aesExpand(key);
    var out = [];
    var prev = iv;
    for (var off = 0; off < ct.length; off += 16) {
        var blk = ct.slice(off, off + 16);
        var d = aesDecBlock(ks, blk);
        for (var i = 0; i < 16; i++) out.push(d[i] ^ prev[i]);
        prev = blk;
    }
    var pad = out[out.length - 1];
    if (pad < 1 || pad > 16) return null;
    for (var j = out.length - pad; j < out.length; j++) if (out[j] !== pad) return null;
    return out.slice(0, out.length - pad);
}

function decryptEnc(enc) {
    try {
        var k1 = b64bin(enc.k1);
        var k2 = b64bin(enc.k2);
        var iv = b64bin(enc.iv);
        var ct = b64bin(enc.c);
        var n = Math.min(k1.length, k2.length);
        var key = [];
        for (var i = 0; i < n; i++) key.push((k1[i] ^ k2[i]) & 255);
        var r = aesCbcDecrypt(key, iv, ct);
        if (!r && n > 32) r = aesCbcDecrypt(key.slice(0, 32), iv, ct);
        return r ? utf8Decode(r) : null;
    } catch (e) {
        return null;
    }
}

// ------------------------------------------------------------------
// Sayfa ayrıştırma (cheerio yok, regex)
// ------------------------------------------------------------------
function titleOf(t) {
    var m = /<title[^>]*>([^<]*)<\/title>/i.exec(t || '');
    return m ? m[1].trim() : '';
}

function parseMetas(html) {
    var out = {};
    var re = /<meta\b[^>]*>/gi;
    var m;
    while ((m = re.exec(html))) {
        var tag = m[0];
        var n = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag);
        var c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
        if (n) out[n[1]] = c ? decodeEntities(c[1]) : '';
    }
    return out;
}

// "Erişim doğrulanıyor" / "Doğrulama" ara sayfası mı?
function isChallenge(t) {
    t = t || '';
    var title = titleOf(t);
    if (/doğrulama/i.test(title) || /dogrulama/i.test(title)) return true;
    var phrase = /Erişim doğrulanıyor/i.test(t) || /Erisim dogrulaniyor/i.test(t);
    if (!phrase) return false;
    var real = t.indexOf('content-card') >= 0 || t.indexOf('data-cfg') >= 0 ||
        t.indexOf('trending-item') >= 0 || t.indexOf('episode-list-item') >= 0;
    return !real;
}

// ------------------------------------------------------------------
// Doğrulama ekranı: meta _bc/_bn/_bk/_br, sha256 PoW, /_bc_verify
// ------------------------------------------------------------------
function passChallenge(base, text, pageUrl) {
    var srcs = [];
    var re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    var m;
    while ((m = re.exec(text))) {
        var u = resolveUrl(pageUrl, decodeEntities(m[1]));
        if (hostOf(u) === hostOf(base)) srcs.push(u);
    }
    srcs = srcs.slice(0, 2);
    return seq(srcs, function (u) {
        return getText(u, {
            Referer: pageUrl,
            Accept: '*/*',
            'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-origin'
        });
    }).then(function (texts) {
        var scriptText = texts.join('\n');
        var dec = '';
        var km = /var k=["']([0-9A-Za-z]{8,64})["'],p=["']([A-Za-z0-9+\/=_-]{40,})["']/.exec(scriptText);
        if (km) {
            var key = km[1];
            var bytes = b64bin(km[2]);
            for (var i = 0; i < bytes.length; i++) {
                dec += String.fromCharCode((bytes[i] & 255) ^ key.charCodeAt(i % key.length));
            }
        }
        var nBc = '_bc', nBn = '_bn', nBk = '_bk', nBr = '_br';
        var nm = /B=meta\("([^"]+)"\),N=meta\("([^"]+)"\),Z=parseInt\(meta\("([^"]+)"\)/.exec(dec);
        if (nm) {
            nBc = nm[1];
            nBn = nm[2];
            nBk = nm[3];
        }
        var rm = /R=meta\("([^"]+)"\)/.exec(dec);
        if (rm) nBr = rm[1];
        var epm = /fetch\(["'](\/[^"']+)["']/.exec(dec);
        var endpoint = epm ? epm[1] : '/_bc_verify';
        var sm = /sha256Hex\(nonce\+["'](.)["']\+guess\)/.exec(dec);
        var sep = sm ? sm[1] : ':';

        var metas = parseMetas(text);
        var bc = metas[nBc] || '';
        var bn = metas[nBn] || '';
        var zeros = parseInt(metas[nBk], 10);
        if (isNaN(zeros)) zeros = 4;
        var ret = metas[nBr] || '/';
        if (!bc || !bn) {
            log('doğrulama metası eksik', nBc, nBn);
            return null;
        }

        var t0 = Date.now();
        return sleep(500).then(function () {
            var pre = '';
            for (var z = 0; z < zeros; z++) pre += '0';
            var ans = null;
            for (var i = 0; i <= 8000000; i++) {
                if (sha256Hex(bn + sep + i).indexOf(pre) === 0) {
                    ans = String(i);
                    break;
                }
            }
            if (ans === null) return null;
            var o = {
                b: bc, a: ans, t: (Date.now() - t0) + 150, m: 9, tc: 6, sc: 1,
                c: '7f3a9c2e5b1d4068',
                w: 'Qualcomm|Adreno (TM) 619|WebGL 1.0 (OpenGL ES 2.0 Chromium)',
                au: '124.04347', pl: 0, hw: 8, dp: 2.75, sw: '393x873', tz: -180,
                tn: 'Europe/Istanbul', lg: 'tr-TR', wd: 0, ck: 1, pm: 'prompt', vs: 'visible', r: ret
            };
            return http('POST', base + endpoint, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    Origin: base,
                    Referer: pageUrl,
                    Accept: '*/*'
                },
                body: JSON.stringify(o)
            }).then(function (r) {
                log('verify', r ? r.status : 'yok', r ? r.text.slice(0, 120) : '');
            });
        });
    });
}

// tries: doğrulama ekranı çıkarsa kaç kez çözülsün
function fetchSite(path, tries) {
    var order = [mainUrl].concat(BASES.filter(function (b) {
        return b !== mainUrl;
    }));
    function tryBase(i) {
        if (i >= order.length) return Promise.resolve(null);
        var b = order[i];
        var get = function () {
            return http('GET', b + path, {
                headers: {
                    Referer: b + '/',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
                }
            });
        };
        var solve = function (r, n) {
            if (!r || !isChallenge(r.text) || n >= tries) return Promise.resolve(r);
            return passChallenge(b, r.text, b + path).then(get).then(function (r2) {
                return solve(r2, n + 1);
            });
        };
        return get().then(function (r) {
            if (!r) return tryBase(i + 1);
            return solve(r, 0).then(function (r2) {
                if (r2 && r2.status === 200 && r2.text && !isChallenge(r2.text)) {
                    mainUrl = b;
                    return { base: b, text: r2.text };
                }
                if (r2 && r2.status === 200) return null; // site ayakta ama doğrulama geçilemedi
                return tryBase(i + 1);
            });
        });
    }
    return tryBase(0);
}

// ------------------------------------------------------------------
// Oyuncu ayarı: /ajax-player-config (data-cfg, AES-CBC, anahtar = k1 XOR k2)
// ------------------------------------------------------------------
function parseCfg(text) {
    if (!text) return null;
    var o;
    try {
        o = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!o || typeof o !== 'object') return null;
    var c = o.config;
    var t = c ? (c.t || '') : (o.t || '');
    var v = c ? (c.v || '') : '';
    if (t === 'null') t = '';
    if (v === 'null') v = '';
    if (o.enc) {
        var d = decryptEnc(o.enc);
        if (d) v = d;
    }
    if (!v) return null;
    return { t: String(t), v: String(v), raw: text };
}

function formBody(o) {
    var a = [];
    for (var k in o) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    return a.join('&');
}

function playerConfig(site, pageUrl) {
    var tags = [];
    var re = /<[^>]*\bdata-cfg\s*=\s*["']([^"']*)["'][^>]*>/gi;
    var m;
    while ((m = re.exec(site.text))) tags.push({ tag: m[0], cfg: decodeEntities(m[1]) });
    if (!tags.length) return Promise.resolve(null);
    var pick = tags.filter(function (x) {
        return /videoContainer/.test(x.tag);
    })[0] || tags[0];
    var cfg = pick.cfg;
    if (!cfg) return Promise.resolve(null);
    var metas = parseMetas(site.text);
    var csrf = metas['csrf-token'] || '';
    var url = site.base + '/ajax-player-config';
    var hA = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: site.base,
        Referer: pageUrl,
        Accept: 'application/json, text/javascript, */*; q=0.01'
    };
    // A: tarayıcıdaki gibi
    return http('POST', url, { headers: hA, body: formBody({ cfg: cfg }) }).then(function (ra) {
        var r = ra ? parseCfg(ra.text) : null;
        if (r) return r;
        // B: ajax-token + csrf
        return http('GET', site.base + '/ajax-token', {
            headers: { Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }
        }).then(function (tr) {
            var tok = '';
            try {
                tok = JSON.parse(tr ? tr.text : '').t || '';
            } catch (e) {}
            if (tok && tok !== 'null') {
                var j = jars[hostOf(site.base)] || (jars[hostOf(site.base)] = {});
                j._ct = tok;
            }
            var hB = {};
            for (var k in hA) hB[k] = hA[k];
            var xt = csrf || tok;
            if (xt && xt !== 'null') hB['X-CSRF-Token'] = xt;
            var body = { cfg: cfg };
            if (tok && tok !== 'null') {
                body.token = tok;
                body.csrf_token = tok;
            } else if (csrf) body.csrf_token = csrf;
            return http('POST', url, { headers: hB, body: formBody(body) }).then(function (rb) {
                var r2 = rb ? parseCfg(rb.text) : null;
                if (r2) return r2;
                // C: sade istek
                return http('POST', url, {
                    headers: { Referer: pageUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formBody({ cfg: cfg })
                }).then(function (rc) {
                    return rc ? parseCfg(rc.text) : null;
                });
            });
        });
    });
}

// ------------------------------------------------------------------
// Embed çözme: packer, XOR, base64, FirePlayer
// ------------------------------------------------------------------
function unpackAll(text) {
    var out = [];
    var re = /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/g;
    var m;
    while ((m = re.exec(text))) {
        try {
            var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            var a = parseInt(m[2], 10);
            var c = parseInt(m[3], 10);
            var k = m[4].split('|');
            var enc = function (n) {
                var hi = n < a ? '' : enc(Math.floor(n / a));
                var r = n % a;
                return hi + (r > 35 ? String.fromCharCode(r + 29) : r.toString(36));
            };
            while (c-- > 0) {
                if (c < k.length && k[c]) {
                    var word = k[c];
                    var e = enc(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    p = p.replace(new RegExp('\\b' + e + '\\b', 'g'), function () {
                        return word;
                    });
                }
            }
            out.push(p);
        } catch (e) {}
    }
    return out;
}

function deepTexts(texts) {
    var out = [];
    var seen = {};
    function add(s) {
        if (!seen[s]) {
            seen[s] = 1;
            out.push(s);
        }
    }
    texts.forEach(function (t) {
        if (/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/.test(t)) {
            var d = t.replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) {
                return String.fromCharCode(parseInt(h, 16));
            });
            d = d.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
                return String.fromCharCode(parseInt(h, 16));
            });
            add(d);
        }
        if (/%[0-9a-fA-F]{2}/.test(t)) {
            try {
                add(decodeURIComponent(t.replace(/%(?![0-9a-fA-F]{2})/g, '%25')));
            } catch (e) {}
        }
        var re = /[A-Za-z0-9+\/_\-]{28,}={0,2}/g;
        var m;
        var n = 0;
        while ((m = re.exec(t)) && n++ < 400) {
            var bytes = b64bin(m[0]);
            if (bytes.length) {
                var d2 = latin1(bytes);
                if (d2.length > 12 && /https?:\/\/|\.m3u8|\.mp4|"file"|sources/i.test(d2)) add(d2);
            }
        }
    });
    return out;
}

function xorDecode(b64, key) {
    var b = b64bin(b64);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode((b[i] & 255) ^ key.charCodeAt(i % key.length));
    return s;
}

function xorTexts(t) {
    var out = [];
    var seen = {};
    var names = {};
    var keys = [];
    function addKey(k) {
        if (keys.indexOf(k) < 0) keys.push(k);
    }
    var m;
    var r1 = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(\s*\w+\s*\)\s*\{\s*var\s+\w+\s*=\s*(["'])([^"']{3,64})\2/g;
    while ((m = r1.exec(t))) {
        names[m[1]] = m[3];
        addKey(m[3]);
    }
    var r2 = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\w+\s*\)\s*\{\s*var\s+\w+\s*=\s*(["'])([^"']{3,64})\2/g;
    while ((m = r2.exec(t))) {
        names[m[1]] = m[3];
        addKey(m[3]);
    }
    var r3 = /(?:var|let|const)\s+\w+\s*=\s*(["'])([A-Za-z0-9]{6,24})\1/g;
    while ((m = r3.exec(t))) addKey(m[2]);
    var r4 = /([A-Za-z_$][\w$]*)\s*\(\s*(["'])([A-Za-z0-9+\/=_-]{24,})\2\s*\)/g;
    while ((m = r4.exec(t))) {
        var fn = m[1];
        var data = m[3];
        var tryKeys = names[fn] ? [names[fn]] : keys.slice(0, 8);
        for (var i = 0; i < tryKeys.length; i++) {
            var d = xorDecode(data, tryKeys[i]);
            if (/https?:\/\/|\.m3u8|\.mp4|\.vtt|"file"|sources/i.test(d) && !seen[d]) {
                seen[d] = 1;
                out.push(d);
            }
        }
    }
    return out;
}

function newFound(origin) {
    return { origin: origin, hls: [], mp4: [], cookies: {} };
}

function addUniq(arr, v) {
    if (arr.indexOf(v) < 0) arr.push(v);
}

// Metin içinden m3u8 / mp4 adreslerini topla
function scan(raw, origin, f) {
    var t = fixText(raw);
    var m;
    var r = /https?:\/\/[^\s"'<>\\)]+?\.m3u8(?:\?[^\s"'<>\\)]*)?/gi;
    while ((m = r.exec(t))) addUniq(f.hls, m[0]);
    r = /["'](\/[^"'\s]+?\.m3u8[^"'\s]*)["']/gi;
    while ((m = r.exec(t))) addUniq(f.hls, origin + m[1]);
    // uzantısız HLS: https://host/m3/<şifreli-token>
    r = /https?:\/\/[^\s"'<>\\)]+?\/m3\/[A-Za-z0-9+\/=_%\-.]{24,}/g;
    while ((m = r.exec(t))) addUniq(f.hls, m[0]);
    // Fire HLS Player: .../cdn/hls/<kod>/master.txt
    r = /https?:\/\/[^\s"'<>\\)]+?\/master\.txt(?:\?[^\s"'<>\\)]*)?/gi;
    while ((m = r.exec(t))) addUniq(f.hls, m[0]);
    r = /["'](\/[^"'\s]+?\/master\.txt[^"'\s]*)["']/gi;
    while ((m = r.exec(t))) addUniq(f.hls, origin + m[1]);
    r = /https?:\/\/[^\s"'<>\\)]+?\.mp4(?:\?[^\s"'<>\\)]*)?/gi;
    while ((m = r.exec(t))) addUniq(f.mp4, m[0]);
}

function isAdHost(u, siteBase) {
    var h = hostOf(u);
    if (h === hostOf(siteBase)) return true;
    for (var i = 0; i < BASES.length; i++) if (hostOf(BASES[i]) === h) return true;
    return /google|youtube|facebook|twitter|blogger|googletagmanager|cloudflare|shrgo|t\.ly|bit\.ly|cutt\.ly|sivo\.|rebrand|gshort|girgara|rogagir/.test(h);
}

function cookiesOnly(jarHost) {
    var out = {};
    var j = jars[jarHost] || {};
    for (var k in j) if (/fireplayer/i.test(k)) out[k] = j[k];
    return out;
}

// FirePlayer: POST <embed>/player/index.php?data=<id>&do=getVideo
function fireVideo(embedUrl, pageUrl, id, found) {
    var origin = originOf(embedUrl);
    var url = origin + '/player/index.php?data=' + id + '&do=getVideo';
    var h = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: embedUrl,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: origin,
        Accept: 'application/json, text/javascript, */*; q=0.01'
    };
    function attempt(list) {
        if (!list.length) return Promise.resolve();
        var rf = list[0];
        return http('POST', url, { headers: h, body: formBody({ hash: id, r: rf }) }).then(function (resp) {
            var t = resp ? resp.text : '';
            var c = cookiesOnly(hostOf(origin));
            for (var k in c) found.cookies[k] = c[k];
            try {
                var o = JSON.parse(t);
                ['videoSource', 'securedLink', 'source', 'file', 'url'].forEach(function (key) {
                    var v = o[key];
                    if (!v || v === 'null' || typeof v !== 'string') return;
                    if (!/^(?:https?:)?\/\//i.test(v)) return;
                    var u = fixText(v);
                    if (u.indexOf('//') === 0) u = 'https:' + u;
                    if (/\.mp4(?:\?|$)/i.test(u) && !o.hls) addUniq(found.mp4, u);
                    else addUniq(found.hls, u);
                });
            } catch (e) {}
            scan(t, origin, found);
            if (found.hls.length || found.mp4.length) return;
            return attempt(list.slice(1));
        });
    }
    return attempt([pageUrl, '']);
}

function resolveEmbed(embedUrl, pageUrl, depth) {
    var origin = originOf(embedUrl);
    var found = newFound(origin);
    return http('GET', embedUrl, { headers: { Referer: pageUrl } }).then(function (r) {
        var html = r ? r.text : '';
        var c = cookiesOnly(hostOf(origin));
        for (var k in c) found.cookies[k] = c[k];

        var texts = [html];
        unpackAll(html).forEach(function (x) {
            texts.push(x);
        });
        deepTexts(texts).forEach(function (x) {
            texts.push(x);
        });
        var xored = [];
        texts.slice().forEach(function (x) {
            xorTexts(x).forEach(function (d) {
                addUniq(xored, d);
            });
        });
        xored.forEach(function (x) {
            texts.push(x);
        });
        texts.forEach(function (x) {
            scan(x, origin, found);
        });
        // XOR ile çözülen düz adres (.m3u8 uzantısı olmasa da) HLS sayılır
        xored.forEach(function (d) {
            var m = /^\s*(https?:\/\/[^\s"'<>\\]+)/.exec(d);
            var u = m ? m[1] : null;
            if (u && found.hls.indexOf(u) < 0 && found.mp4.indexOf(u) < 0 && !/\.(?:vtt|srt)(?:\?|$)/i.test(u)) {
                found.hls.push(u);
            }
        });

        var next = Promise.resolve();
        if (!found.hls.length && !found.mp4.length) {
            var joined = texts.join('\n');
            var fm = /FirePlayer\(\s*["']([A-Za-z0-9]{16,64})["']/.exec(joined);
            var fid = fm ? fm[1] : null;
            if (!fid && /FirePlayer|fireplay/i.test(html)) {
                var vm = /\/video\/([A-Za-z0-9]{16,64})/.exec(embedUrl);
                fid = vm ? vm[1] : null;
            }
            if (!fid) {
                var im = /index\.php\?data=([A-Za-z0-9]{16,64})/.exec(joined);
                fid = im ? im[1] : null;
            }
            if (fid) next = fireVideo(embedUrl, pageUrl, fid, found);
        }
        return next.then(function () {
            // iç içe iframe
            if (!found.hls.length && !found.mp4.length && depth < 1) {
                var re = /<iframe[^>]+src=["']([^"']+)["']/gi;
                var m;
                var inner = null;
                while ((m = re.exec(html))) {
                    var u = resolveUrl(embedUrl, fixText(m[1]));
                    if (/^https?:/i.test(u) && !isAdHost(u, mainUrl)) {
                        inner = u;
                        break;
                    }
                }
                if (inner) return resolveEmbed(inner, embedUrl, depth + 1);
            }
            return found;
        });
    });
}

// ------------------------------------------------------------------
// Akış üretimi
// ------------------------------------------------------------------
function ckHeader(cookies) {
    var a = [];
    for (var k in cookies) a.push(k + '=' + cookies[k]);
    return a.join('; ');
}

function mkHeaders(ref, cookies) {
    var h = { 'User-Agent': UA, Referer: ref, Origin: ref.replace(/\/$/, '') };
    var ck = ckHeader(cookies || {});
    if (ck) h.Cookie = ck;
    return h;
}

function mkStream(url, h, label, headers) {
    return {
        name: 'Dizipal',
        title: label,
        url: url,
        quality: h > 0 ? h + 'p' : 'Auto',
        headers: headers,
        provider: 'dizipal'
    };
}

function emitMp4(url, refBase, cookies) {
    var ref = refBase.replace(/\/$/, '') + '/';
    return [mkStream(url, 0, 'Dizipal', mkHeaders(ref, cookies))];
}

// Ana liste (master): kalite varyantları ve ses seçenekleri
function emitHls(url, refBase, pageBase, cookies) {
    var ref = refBase.replace(/\/$/, '') + '/';
    var ck = cookies || {};
    var fetchBody = function (r) {
        return getText(url, mkHeaders(r, ck));
    };
    return fetchBody(ref).then(function (body) {
        if (body.indexOf('#EXTM3U') >= 0 || pageBase.replace(/\/$/, '') === refBase.replace(/\/$/, '')) return body;
        var alt = pageBase.replace(/\/$/, '') + '/';
        return fetchBody(alt).then(function (b2) {
            if (b2.indexOf('#EXTM3U') >= 0) {
                ref = alt;
                return b2;
            }
            return body;
        });
    }).then(function (body) {
        if (body.indexOf('#EXTM3U') >= 0 || Object.keys(ck).length) return body;
        // Yedek: oynatıcı sunucusu çerez istiyorsa ana adresine uğrayıp fireplayer_* çerezini al
        var own = originOf(url) + '/';
        return http('GET', own, { headers: { Referer: ref } }).then(function () {
            var c2 = cookiesOnly(hostOf(url));
            if (!Object.keys(c2).length) return body;
            ck = c2;
            return fetchBody(own).then(function (b3) {
                if (b3.indexOf('#EXTM3U') >= 0) {
                    ref = own;
                    return b3;
                }
                return body;
            });
        });
    }).then(function (body) {
        var headers = mkHeaders(ref, ck);
        var vars = [];
        var hasAudio = false;
        var lines = body.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (ln.indexOf('#EXT-X-STREAM-INF:') === 0) {
                var uri = '';
                for (var j = i + 1; j < lines.length; j++) {
                    var l = lines[j].trim();
                    if (l && l.charAt(0) !== '#') {
                        uri = l;
                        break;
                    }
                }
                if (uri) {
                    var bw = /BANDWIDTH=(\d+)/.exec(ln);
                    var rs = /RESOLUTION=\d+x(\d+)/.exec(ln);
                    vars.push({ url: resolveUrl(url, uri), bw: bw ? parseInt(bw[1], 10) : 0, h: rs ? parseInt(rs[1], 10) : 0 });
                }
            } else if (ln.indexOf('#EXT-X-MEDIA:') === 0 && ln.indexOf('TYPE=AUDIO') >= 0) {
                hasAudio = true;
            }
        }
        if (!vars.length) return [mkStream(url, 0, 'Dizipal', headers)];

        var best = vars.slice().sort(function (a, b) {
            return b.h - a.h || b.bw - a.bw;
        })[0];
        var byAudio = {};
        vars.forEach(function (v) {
            var m = /-a(\d+)\.m3u8/i.exec(v.url);
            if (!m) return;
            var k = parseInt(m[1], 10);
            var cur = byAudio[k];
            if (!cur || v.h > cur.h || (v.h === cur.h && v.bw > cur.bw)) byAudio[k] = v;
        });
        var keys = Object.keys(byAudio).map(Number).sort(function (a, b) {
            return a - b;
        });
        if (hasAudio || !keys.length) return [mkStream(url, best.h, 'Dizipal', headers)];
        return keys.map(function (k) {
            return mkStream(byAudio[k].url, byAudio[k].h, keys.length > 1 ? 'Dizipal Ses ' + k : 'Dizipal', headers);
        });
    });
}

// Sayfadaki oynatıcıdan akışları çıkar (CloudStream loadLinks karşılığı)
function linksFromPage(site, path) {
    var pageUrl = site.base + path;
    return playerConfig(site, pageUrl).then(function (cfg) {
        var streams = [];
        var embeds = [];
        var pageFound = newFound(site.base);
        var chain = Promise.resolve();
        var any = false;
        var add = function (arr) {
            if (arr && arr.length) {
                any = true;
                streams = streams.concat(arr);
            }
        };

        if (cfg) {
            scan(cfg.raw + ' ' + cfg.v, site.base, pageFound);
            var t = cfg.t.toLowerCase();
            var v = fixText(cfg.v).trim();
            if (t === 'm3u8') {
                chain = chain.then(function () {
                    return emitHls(v, site.base, site.base, {}).then(add);
                });
            } else if (t === 'mp4') {
                add(emitMp4(v, site.base, {}));
            } else if (/<iframe/i.test(v)) {
                var im = /<iframe[^>]+src=["']([^"']+)["']/i.exec(v);
                if (im) embeds.push(resolveUrl(site.base, fixText(im[1])).replace(/#.*$/, ''));
            } else if (/^https?:/i.test(v) || v.indexOf('//') === 0) {
                var u = v.indexOf('//') === 0 ? 'https:' + v : v;
                if (/\.m3u8/i.test(u)) {
                    chain = chain.then(function () {
                        return emitHls(u, site.base, site.base, {}).then(add);
                    });
                } else embeds.push(u.replace(/#.*$/, ''));
            }
        }

        return chain.then(function () {
            if (!embeds.length && !any) {
                var re = /<iframe[^>]+src=["']([^"']+)["']/gi;
                var m;
                while ((m = re.exec(site.text))) {
                    var u2 = resolveUrl(site.base, fixText(m[1]));
                    if (/^https?:/i.test(u2) && !isAdHost(u2, site.base)) embeds.push(u2);
                }
            }
            var uniq = embeds.filter(function (e, i) {
                return embeds.indexOf(e) === i;
            }).slice(0, 3);
            return seq(uniq, function (embed) {
                return resolveEmbed(embed, pageUrl, 0).then(function (found) {
                    return seq(found.hls.slice(0, 3), function (u3) {
                        return emitHls(u3, found.origin, site.base, found.cookies).then(add);
                    }).then(function () {
                        found.mp4.slice(0, 2).forEach(function (u4) {
                            add(emitMp4(u4, found.origin, found.cookies));
                        });
                    });
                });
            });
        }).then(function () {
            var seen = {};
            return streams.filter(function (s) {
                if (seen[s.url]) return false;
                seen[s.url] = 1;
                return true;
            });
        });
    });
}

// ------------------------------------------------------------------
// TMDB -> başlık -> site araması
// ------------------------------------------------------------------
function normTitle(s) {
    return String(s || '')
        .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
        .toLowerCase()
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '');
}

function tmdbTitles(tmdbId, isMovie) {
    if (!TMDB_KEY || TMDB_KEY.indexOf('BURAYA') === 0) return Promise.resolve(null);
    var kind = isMovie ? 'movie' : 'tv';
    var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&language=tr-TR';
    return getText(url, { Accept: 'application/json' }).then(function (t) {
        try {
            var o = JSON.parse(t);
            var tr = isMovie ? o.title : o.name;
            var orig = isMovie ? o.original_title : o.original_name;
            var out = [];
            if (tr) out.push(tr);
            if (orig && out.indexOf(orig) < 0) out.push(orig);
            return out.length ? out : null;
        } catch (e) {
            return null;
        }
    });
}

function parseCards(html) {
    var out = [];
    var parts = html.split('content-card');
    for (var i = 1; i < parts.length; i++) {
        var chunk = parts[i].slice(0, 1500);
        var hm = /href=["'](\/(?:film|dizi|anime)\/[^"'#?]+)["']/i.exec(chunk) ||
            /href=["'](https?:\/\/[^"']+\/(?:film|dizi|anime)\/[^"'#?]+)["']/i.exec(chunk);
        if (!hm) continue;
        var tm = /class=["'][^"']*card-title[^"']*["'][^>]*>\s*([^<]+)/i.exec(chunk) ||
            /<img[^>]*\balt=["']([^"']+)["']/i.exec(chunk);
        if (!tm) continue;
        var href = hm[1].replace(/^https?:\/\/[^\/]+/i, '');
        out.push({ path: href, title: decodeEntities(tm[1]).replace(/\s*[-|–]\s*Dizipal.*$/i, '').replace(/\s+izle$/i, '').trim() });
    }
    return out;
}

function findPath(titles, isMovie) {
    function okType(p) {
        return isMovie ? p.indexOf('/film/') === 0 : (p.indexOf('/dizi/') === 0 || p.indexOf('/anime/') === 0);
    }
    function tryTitle(i) {
        if (i >= titles.length) return Promise.resolve(null);
        var q = encodeURIComponent(titles[i]).replace(/\+/g, '%20');
        return fetchSite('/arama?q=' + q, 1).then(function (site) {
            if (!site) return tryTitle(i + 1);
            var cards = parseCards(site.text).filter(function (c) {
                return okType(c.path);
            });
            var nt = titles.map(normTitle);
            var exact = cards.filter(function (c) {
                return nt.indexOf(normTitle(c.title)) >= 0;
            })[0];
            if (exact) return exact.path;
            var near = cards.filter(function (c) {
                var n = normTitle(c.title);
                return nt.some(function (x) {
                    return x && (n.indexOf(x) === 0 || x.indexOf(n) === 0);
                });
            })[0];
            if (near) return near.path;
            return tryTitle(i + 1);
        });
    }
    return tryTitle(0);
}

// ------------------------------------------------------------------
// Nuvio giriş noktası
// ------------------------------------------------------------------
function getStreams(tmdbId, mediaType, season, episode) {
    var isMovie = mediaType === 'movie';
    return tmdbTitles(tmdbId, isMovie).then(function (titles) {
        if (!titles) return [];
        return findPath(titles, isMovie).then(function (p) {
            if (!p) {
                log('içerik bulunamadı', titles);
                return [];
            }
            var path = p;
            if (!isMovie) {
                var slug = p.substring(p.lastIndexOf('/') + 1);
                path = '/bolum/' + slug + '-' + (season || 1) + '-sezon-' + (episode || 1) + '-bolum';
            }
            return fetchSite(path, 2).then(function (site) {
                if (!site) {
                    log('sayfa alınamadı', path);
                    return [];
                }
                return linksFromPage(site, path);
            });
        });
    }).catch(function (e) {
        log('hata', e && e.message);
        return [];
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams: getStreams };
} else if (typeof global !== 'undefined') {
    global.getStreams = getStreams;
}
