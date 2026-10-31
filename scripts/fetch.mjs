// Dnevno osvježavanje podataka za aplikaciju Krunica.
// Pokreće se u GitHub Actions (Node 20+, bez dodatnih paketa).
// - HILP (hilp.hr/liturgija-dana): metapodaci dana + tekstovi čitanja
// - Book.hr: komentar i molitva uz misna čitanja
// - Bog je tu: najnovije molitve i devetnice
// Zaštićeni tekstovi spremaju se šifrirano (AES-GCM, ključ iz tajne KRUNICA_KEY),
// tako da ih može pročitati samo aplikacija vlasnice/vlasnika.

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const DATA = new URL("../data/", import.meta.url);
const DAYS = new URL("days/", DATA);
const DEBUG = process.env.KRUNICA_DEBUG ? new URL("../debug/", import.meta.url) : null;
const AHEAD = Number(process.env.KRUNICA_AHEAD || 14);
const KEEP_PAST = 30;
const UA = "Mozilla/5.0 (KrunicaApp; osobna uporaba)";

const DAYNAMES = ["nedjelja", "ponedjeljak", "utorak", "srijeda", "cetvrtak", "petak", "subota"];
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const zagrebToday = () => {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb" }).format(new Date());
  return new Date(s + "T00:00:00Z");
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const hilpUrl = (d) =>
  `https://hilp.hr/liturgija-dana/${DAYNAMES[d.getUTCDay()]}-${d.getUTCDate()}-${d.getUTCMonth() + 1}-${d.getUTCFullYear()}/`;

const report = { run: new Date().toISOString(), days: {}, book: null, prayers: null, errors: [] };

/* ---------------- HTML -> retci ---------------- */
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…",
  laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚", shy: "" };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
function htmlToLines(html, { keepChrome = false } = {}) {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|form|select|button)[\s\S]*?<\/\1>/gi, "");
  if (!keepChrome) h = h.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "");
  h = h
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|ul|ol|tr|td|th|table|section|article|blockquote|main|figure|figcaption|dt|dd)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(h)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean);
}
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "hr" }, redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.text();
}
async function debugWrite(name, text) {
  if (!DEBUG) return;
  await mkdir(DEBUG, { recursive: true });
  await writeFile(new URL(name, DEBUG), text);
}

/* ---------------- HILP ---------------- */
const SECTION_RE = /^(Prvo čitanje|Drugo čitanje|Otpjevni psalam|Evanđelje|Pjesma prije evanđelja|Aleluja|Posljednica)\s*:?\s*(.*)$/i;
const REF_RE = /^(\d\s?)?[A-ZČĆŽŠĐ][a-zčćžšđ]{0,5}\.?\s?\d+,\s?\d/;
function parseHilp(lines) {
  const dateIdx = lines.findIndex((l) => /^(Ponedjeljak|Utorak|Srijeda|Četvrtak|Petak|Subota|Nedjelja),\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\.?$/i.test(l));
  if (dateIdx < 0) throw new Error("HILP: nije pronađen redak s datumom");
  const meta = { title: null, rank: null, week: null, psalter: null, color: null, saints: [], namedays: [], note: null, thought: null, readings: [] };

  // Misao iz evanđelja dana (prije datuma)
  const mIdx = lines.findIndex((l) => /^Misao iz evanđelja dana/i.test(l));
  if (mIdx >= 0 && mIdx < dateIdx) {
    const rest = lines[mIdx].replace(/^Misao iz evanđelja dana\s*:?\s*/i, "");
    meta.thought = (rest || lines.slice(mIdx + 1, dateIdx).join(" ")).trim() || null;
  }

  const firstSec = lines.findIndex((l, i) => i > dateIdx && SECTION_RE.test(l));
  const head = lines.slice(dateIdx + 1, firstSec < 0 ? dateIdx + 30 : firstSec);
  const RANKS = /^(Svagdan|Spomendan|Neobvezatni spomendan|Spomen|Blagdan|Svetkovina|Nedjelja)$/i;
  const titleParts = [];
  for (let i = 0; i < head.length; i++) {
    const l = head[i];
    let m;
    if (RANKS.test(l)) meta.rank = l;
    else if (/tjedan kroz godinu|tjedan došašća|tjedan korizme|vazmeni tjedan|tjedan vazma|božićn|osmin|Veliki tjedan/i.test(l) && !/psaltira/i.test(l)) meta.week = l;
    else if (/tjedan psaltira/i.test(l)) meta.psalter = l;
    else if ((m = l.match(/^Boja liturgijskog ruha\s*:?\s*(.*)$/i))) meta.color = (m[1] || head[++i] || "").toLowerCase().trim();
    else if ((m = l.match(/^Imendani\s*:?\s*(.*)$/i))) meta.namedays = (m[1] || head[++i] || "").split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    else if ((m = l.match(/^Napomena\s*:?\s*(.*)$/i))) meta.note = (m[1] || head[++i] || "").trim();
    else if (/^Misna čitanja\s*:?/i.test(l)) { if (!/:\s*\S/.test(l)) i++; }
    else if (/^(Sv\.|Sveti|Sveta|Bl\.|Blaženi|Blažena|Sv\s)/.test(l) || /†/.test(l)) meta.saints.push(l);
    else if (l.length < 120 && !REF_RE.test(l)) titleParts.push(l);
  }
  meta.title = titleParts[0] || lines[dateIdx];
  if (titleParts.length > 1 && meta.saints.length === 0 && /^(sv|bl)/i.test(titleParts[1])) meta.saints.push(titleParts[1]);

  // Čitanja
  const texts = [];
  let cur = null;
  const endRe = /^(Časoslov|Kontakt|Pretplata|Narudžbe|Hrvatski institut za liturgijski pastoral|©)/i;
  for (let i = firstSec; firstSec >= 0 && i < lines.length; i++) {
    const l = lines[i];
    if (endRe.test(l)) break;
    const m = l.match(SECTION_RE);
    if (m) {
      cur = { label: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), ref: "", lines: [] };
      let rest = m[2].trim();
      if (!rest && REF_RE.test(lines[i + 1] || "")) rest = lines[++i];
      cur.ref = rest;
      texts.push(cur);
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  meta.readings = texts.map((t) => ({ label: t.label, ref: t.ref }));
  const readings = texts.map((t) => ({ label: t.label, ref: t.ref, lines: t.lines }));
  return { meta, readings };
}

/* ---------------- Book.hr ---------------- */
async function fetchBook(todayIso) {
  const xml = await get("https://book.hr/feed/");
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const out = {};
  for (const it of items) {
    const title = decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, "");
    if (!/^MISNA ČITANJA/i.test(title)) continue;
    const link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "").trim();
    const pub = new Date((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]);
    // objavljuje se večer prije – pripada datumu u Zagrebu nakon objave (+2 h)
    const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb" }).format(new Date(pub.getTime() + 2 * 3600000));
    try {
      const html = await get(link);
      const lines = htmlToLines(html);
      await debugWrite(`book-${iso}.txt`, lines.join("\n"));
      const k = lines.findIndex((l) => /^Komentar\s*:?$/i.test(l));
      const mo = lines.findIndex((l, i) => i > k && /^Molitva\s*:?$/i.test(l));
      if (k < 0) throw new Error("Book.hr: nema odjeljka Komentar");
      const stop = (l) => /^(Za Book\.hr|Foto:|Podijeli|Share|Pročitajte|Povezano|Napisao|Oznake|Tags|Ostavite komentar)/i.test(l);
      const comment = [];
      for (let i = k + 1; i < (mo > 0 ? mo : lines.length); i++) { if (stop(lines[i])) break; comment.push(lines[i]); }
      const prayer = [];
      for (let i = mo + 1; mo > 0 && i < lines.length; i++) { if (stop(lines[i]) || /^Čita ih/i.test(lines[i])) break; prayer.push(lines[i]); }
      const author = (lines.find((l) => /autor komentara/i.test(l)) || "").replace(/^.*autor komentara i molitve je\s*/i, "").replace(/\.$/, "") || null;
      out[iso] = { url: link, title, author, comment, prayer };
    } catch (e) {
      report.errors.push(`book ${iso}: ${e.message}`);
    }
  }
  return out;
}

/* ---------------- Bog je tu ---------------- */
function cleanHtml(html) {
  // dopušta samo osnovno oblikovanje teksta
  let h = html
    .replace(/<(script|style|iframe|figure|noscript|form)[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<(\/?)(p|br|strong|b|em|i|h2|h3|h4|ul|ol|li|blockquote)(\s[^>]*)?>/gi, "<$1$2>")
    .replace(/<(?!\/?(p|br|strong|b|em|i|h2|h3|h4|ul|ol|li|blockquote)>)[^>]+>/gi, "")
    .replace(/<p>\s*<\/p>/g, "");
  return decode(h.replace(/&nbsp;/g, " ")).trim();
}
async function fetchPrayers() {
  const feeds = [
    ["https://bogjetu.com/category/duhovnost/molitve/feed/", "Molitva"],
    ["https://bogjetu.com/category/duhovnost/devetnice/feed/", "Devetnica"],
  ];
  const items = [];
  for (const [url, kind] of feeds) {
    try {
      const xml = await get(url);
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const it = m[1];
        const pick = (tag) => ((it.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
        const link = pick("link");
        const content = pick("content:encoded");
        items.push({ title: decode(pick("title")), url: link, date: isoOf(new Date(pick("pubDate"))), kind, html: cleanHtml(content) });
      }
    } catch (e) { report.errors.push(`bogjetu ${kind}: ${e.message}`); }
  }
  const seen = new Set();
  return items.filter((x) => (seen.has(x.url) ? false : seen.add(x.url))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

/* ---------------- Šifriranje ---------------- */
const b64 = (u8) => Buffer.from(u8).toString("base64");
async function getKey() {
  const pass = process.env.KRUNICA_KEY;
  if (!pass) return null;
  const kf = new URL("key.json", DATA);
  let info;
  if (existsSync(kf)) info = JSON.parse(await readFile(kf, "utf8"));
  else {
    info = { v: 1, kdf: "PBKDF2-SHA256", iter: 210000, salt: b64(crypto.getRandomValues(new Uint8Array(16))) };
  }
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(info.salt, "base64"), iterations: info.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  if (!info.check) {
    info.check = await encrypt(key, "krunica-ok");
    await writeFile(kf, JSON.stringify(info, null, 1));
  }
  return key;
}
async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(typeof obj === "string" ? obj : JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { iv: b64(iv), ct: b64(ct) };
}

/* ---------------- Glavni tijek ---------------- */
async function main() {
  await mkdir(DAYS, { recursive: true });
  const key = await getKey();
  if (!key) report.errors.push("KRUNICA_KEY nije postavljen – tekstovi se ne spremaju, samo metapodaci");
  const today = zagrebToday();
  // Book.hr blokira automatski pristup – komentar ostaje samo kao poveznica u aplikaciji.
  const book = {};
  report.book = Object.keys(book);

  for (let n = -1; n <= AHEAD; n++) {
    const d = addDays(today, n), iso = isoOf(d);
    const file = new URL(`${iso}.json`, DAYS);
    let old = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : null;
    const needHilp = !old || !old.enc || !old.parsedAt || process.env.KRUNICA_FORCE;
    const needBook = book[iso] && (!old || !old.book);
    if (!needHilp && !needBook) { report.days[iso] = "ok (postoji)"; continue; }
    try {
      let meta = old || {}, readings = null;
      if (needHilp) {
        const html = await get(hilpUrl(d));
        const lines = htmlToLines(html);
        await debugWrite(`hilp-${iso}.txt`, lines.join("\n"));
        const p = parseHilp(lines);
        meta = { ...p.meta, source: hilpUrl(d), parsedAt: new Date().toISOString() };
        readings = p.readings;
      }
      // čitanja: nova ili zadrži postojeća
      const thought = meta.thought; delete meta.thought; // i misao dana ide u šifrirani dio
      if (readings && key) meta.enc = await encrypt(key, { readings, thought });
      else if (old?.enc) meta.enc = old.enc;
      // komentar Book.hr: novi ili zadrži postojeći
      const b = book[iso];
      if (b && key) { meta.book = { url: b.url, author: b.author }; meta.encBook = await encrypt(key, { comment: b.comment, prayer: b.prayer, author: b.author }); }
      else if (b) meta.book = { url: b.url, author: b.author };
      else if (old?.book) { meta.book = old.book; if (old.encBook) meta.encBook = old.encBook; }
      await writeFile(file, JSON.stringify(meta, null, 1));
      report.days[iso] = `ok · ${meta.readings?.length || 0} čitanja${meta.book ? " · komentar" : ""}`;
    } catch (e) {
      report.days[iso] = "greška: " + e.message;
      report.errors.push(`${iso}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  // Molitve
  const prayers = await fetchPrayers();
  const list = prayers.map(({ html, ...m }) => m);
  const pfile = { items: list, updated: new Date().toISOString() };
  if (key && prayers.length) pfile.enc = await encrypt(key, Object.fromEntries(prayers.map((p) => [p.url, p.html])));
  if (prayers.length) await writeFile(new URL("prayers.json", DATA), JSON.stringify(pfile, null, 1));
  report.prayers = prayers.length;

  // Čišćenje starih dana
  const cutoff = isoOf(addDays(today, -KEEP_PAST));
  for (const f of await readdir(DAYS)) if (f.endsWith(".json") && f.slice(0, 10) < cutoff) await unlink(new URL(f, DAYS));

  await writeFile(new URL("status.json", DATA), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
}

if (process.argv[2] === "--parse-file") {
  // lokalni test: node fetch.mjs --parse-file stranica.html
  const html = await readFile(process.argv[3], "utf8");
  console.log(JSON.stringify(parseHilp(htmlToLines(html)), null, 1));
} else {
  await main();
}
