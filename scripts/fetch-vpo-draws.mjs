#!/usr/bin/env node
/*
 * Pull the "Житло для ВПО" (IDP housing) draw schedule from Держмолодьжитло.
 *
 * The Fund's RSS feed is empty (their CMS emits a channel with no <item>s), so
 * we scrape the news listing pages instead. Each article is a
 * `<div class="teaser-item">` with an <a href="/pres-tsentr/novyny/…"
 * title="…"> and a "DD.MM.YY | HH:MM" date. We find the "N-й етап … ВПО"
 * articles, take the latest completed one, and — if a future draw is announced
 * — open that item to read "Відбір відбудеться <date> о <time>" + the YouTube
 * livestream link.
 *
 * Output (written in-build, NEVER committed back to git):
 *   - data/vpo_zhereb.json : read by Hugo to render the block. Updated only on
 *                            a successful scan → its checkedAt honestly shows
 *                            the last time data was actually pulled.
 *   - static/vpo.json      : shipped to /vpo.json — a self-diagnosing status
 *                            file { ranAt, ok, error?, …data }. Open it to see
 *                            whether the last run succeeded.
 *
 * Never fails the build: on error it records the reason in /vpo.json, leaves
 * the block data untouched, and exits 0. Run it in CI before `hugo`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT        = path.join(ROOT, 'data', 'vpo_zhereb.json'); // Hugo data → server-side render
const OUT_STATIC = path.join(ROOT, 'static', 'vpo.json');      // /vpo.json → browsable status
const BASE = 'https://www.molod-kredit.gov.ua';
const NEWS = BASE + '/pres-tsentr/novyny';
const UA   = 'Mozilla/5.0 (compatible; artem.im-bot/1.0; +https://artem.im)';

const MONTHS = { // Ukrainian month name (genitive) -> number
  'січня': 1, 'лютого': 2, 'березня': 3, 'квітня': 4, 'травня': 5, 'червня': 6,
  'липня': 7, 'серпня': 8, 'вересня': 9, 'жовтня': 10, 'листопада': 11, 'грудня': 12,
};

function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/\s+/g, ' ').trim();
}

async function get(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000); // don't let a hung request stall the build
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, redirect: 'follow', signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}

export const isEtap     = (t) => /етап/i.test(t) && /ВПО|переселен|Житло\s+для\s+ВПО|Житлові\s+приміщення/i.test(t);
export const stageNo    = (t) => { const m = /(\d+)\s*[-–—]?\s*(?:й|ий|го|е)?\s*етап/i.exec(t || ''); return m ? +m[1] : null; };
export const isDone     = (t) => /провел[аои]|провів|відбувся|відбул[ао]|проведено|підсумк/i.test(t || '');
export const isAnnounce = (t) => /проведе|оголош\S*\s+про|відбудеться|стартує|розпочина/i.test(t || '');

function fmtKyiv(d) {
  try {
    return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
async function readJSON(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function writeJSON(p, obj) { await writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }

// Extract the "Відбір відбудеться DD MONTH о HH:MM" draw datetime + YouTube link from an announcement page.
export function drawFromDetail(html, pubISO) {
  const text = decode(html);
  const out = {};
  const dm = /Відбір\s+відбудеться\s+(\d{1,2})\s+([а-яіїєґ']+)\s+о\s+(\d{1,2})[:.](\d{2})/i.exec(text);
  if (dm) {
    const day = +dm[1], mon = MONTHS[dm[2].toLowerCase()], hh = dm[3], mm = dm[4];
    out.whenText = `${day} ${dm[2]} о ${hh}:${mm}`;
    out.whenTime = `${String(hh).padStart(2, '0')}:${mm}`;
    if (mon) {
      let year = pubISO ? +pubISO.slice(0, 4) : new Date().getFullYear();
      if (pubISO && +pubISO.slice(5, 7) === 12 && mon === 1) year++; // Dec announce -> Jan draw
      out.whenISO = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const ym = /(https?:\/\/(?:www\.)?youtube\.com\/live\/[A-Za-z0-9_\-]+)/i.exec(text)
          || /(https?:\/\/(?:www\.)?youtu\.be\/[A-Za-z0-9_\-]+)/i.exec(text);
  if (ym) out.youtube = ym[1];
  return out;
}

// Parse one listing page into [{ title, link, dateISO }], newest-first.
export function extractArticles(html) {
  const out = [];
  const blocks = html.split(/<div class="teaser-item"[^>]*>/i).slice(1);
  for (const b of blocks) {
    const lm = /<a\b[^>]*\bhref="([^"]*\/pres-tsentr\/novyny\/[^"?#]+)"[^>]*\btitle="([^"]+)"/i.exec(b);
    if (!lm) continue;
    const dm = /(\d{2})\.(\d{2})\.(\d{2})\s*\|\s*\d{2}:\d{2}/.exec(b);
    out.push({
      title: decode(lm[2]),
      link: lm[1].startsWith('http') ? lm[1] : BASE + lm[1],
      dateISO: dm ? `20${dm[3]}-${dm[2]}-${dm[1]}` : null,
    });
  }
  return out;
}

async function collectArticles(maxPages = 5) {
  const out = [], seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1 ? NEWS : `${NEWS}/${p}`;
    let html;
    try { html = await get(url); } catch (e) { if (p === 1) throw e; break; }
    let added = 0;
    for (const a of extractArticles(html)) { if (seen.has(a.link)) continue; seen.add(a.link); out.push(a); added++; }
    if (!added) break; // ran past the last page
  }
  return out; // newest-first
}

async function main() {
  const prev = await readJSON(OUT);
  const nowD = new Date(), ranAt = nowD.toISOString(), ranAtText = fmtKyiv(nowD), today = ranAt.slice(0, 10);

  let articles;
  try { articles = await collectArticles(5); }
  catch (e) {
    const error = 'listing fetch failed: ' + e.message;
    console.warn('[vpo]', error);
    await writeJSON(OUT_STATIC, { ranAt, ranAtText, ok: false, error, newsUrl: NEWS,
      checkedAt: prev?.checkedAt ?? null, checkedAtText: prev?.checkedAtText ?? null,
      upcoming: prev?.upcoming ?? null, latest: prev?.latest ?? null });
    return;
  }

  const etaps = articles.filter((a) => isEtap(a.title)); // newest-first
  let latest = null, upcoming = null, tries = 0;
  for (const a of etaps) {
    const st = stageNo(a.title);
    if (!latest && isDone(a.title)) latest = { stage: st, dateISO: a.dateISO, url: a.link };
    if (!upcoming && isAnnounce(a.title) && !isDone(a.title) && tries < 3) {
      tries++;
      let det = {};
      try { det = drawFromDetail(await get(a.link), a.dateISO); } catch (e) { console.warn('[vpo] detail:', e.message); }
      if (det.whenISO && det.whenISO >= today) {
        upcoming = { stage: st, whenText: det.whenText || null, whenTime: det.whenTime || null, whenISO: det.whenISO, url: a.link, youtube: det.youtube || null };
      }
    }
    if (latest && upcoming) break;
  }
  // keep the last-known values when this scan finds nothing newer
  if (!latest) latest = prev?.latest ?? null;
  if (!upcoming && prev?.upcoming?.whenISO && prev.upcoming.whenISO >= today) upcoming = prev.upcoming;

  const data = { checkedAt: ranAt, checkedAtText: ranAtText, newsUrl: NEWS, upcoming, latest };
  await writeJSON(OUT, data);                                                    // block source (advances on success)
  await writeJSON(OUT_STATIC, { ranAt, ranAtText, ok: true, foundEtaps: etaps.length, ...data });
  console.log('[vpo] OK', JSON.stringify(data));
}

// run only when executed directly (not when imported by tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.warn('[vpo] non-fatal error:', e.message); process.exit(0); });
}
