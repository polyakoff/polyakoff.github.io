#!/usr/bin/env node
/*
 * Pull the "Житло для ВПО" (IDP housing) draw schedule from Держмолодьжитло.
 *
 * Source of truth: the Fund's news RSS feed (Joomla-generated). There is no
 * official API, so we read the standard RSS and, for an announced upcoming
 * draw, open that one news item to extract the exact date/time + YouTube link.
 *
 * Output: data/vpo_zhereb.json — consumed by layouts/partials/zhereb-block.html.
 *
 * Resilience: this must NEVER fail the site build. On any error (network,
 * markup change, empty result) it logs a warning, leaves the last-known
 * snapshot in place, and exits 0. Run it in CI before `hugo`.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'data', 'vpo_zhereb.json');
const NEWS = 'https://www.molod-kredit.gov.ua/pres-tsentr/novyny';
const FEED = NEWS + '?format=feed&type=rss';
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
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,text/html,*/*' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return await r.text();
}

export function parseItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const mm = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(block);
      return mm ? decode(mm[1]) : '';
    };
    items.push({ title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), description: pick('description') });
  }
  return items;
}

export const isEtap     = (t) => /етап/i.test(t) && /ВПО|переселен|Житло\s+для\s+ВПО|Житлові\s+приміщення/i.test(t);
export const stageNo    = (t) => { const m = /(\d+)\s*[-–—]?\s*(?:й|ий|го|е)?\s*етап/i.exec(t || ''); return m ? +m[1] : null; };
export const isDone     = (t) => /провел[аои]|провів|підсумк/i.test(t || '');
export const isAnnounce = (t) => /проведе|оголош\S*\s+про|відбудеться|стартує|розпочина/i.test(t || '');

function toISO(d) { const dt = new Date(d); return isNaN(dt) ? null : dt.toISOString().slice(0, 10); }

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

async function main() {
  let items = [];
  try { items = parseItems(await get(FEED)); }
  catch (e) { console.warn('[vpo] feed failed:', e.message); }

  if (!items.length) { // fallback: scrape the listing page
    try {
      const html = await get(NEWS);
      const re = /<a[^>]+href="(https:\/\/www\.molod-kredit\.gov\.ua\/pres-tsentr\/novyny\/[^"]+)"[^>]*title="([^"]+)"/gi;
      const seen = new Set(); let m;
      while ((m = re.exec(html))) { if (seen.has(m[1])) continue; seen.add(m[1]); items.push({ title: decode(m[2]), link: m[1], pubDate: '', description: '' }); }
    } catch (e) { console.warn('[vpo] listing failed:', e.message); }
  }

  const etaps = items.filter((it) => isEtap(it.title) || isEtap(it.description));
  if (!etaps.length) { console.warn('[vpo] no etap items found; keeping existing snapshot'); return; }
  etaps.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)); // newest first

  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  let upcoming = null, latest = null;

  for (const it of etaps) {
    const st = stageNo(it.title) || stageNo(it.description);
    const iso = toISO(it.pubDate);
    if (!latest && isDone(it.title)) latest = { stage: st, dateISO: iso, url: it.link };
    if (!upcoming && isAnnounce(it.title) && !isDone(it.title) && it.pubDate && (now - Date.parse(it.pubDate) < 60 * 864e5)) {
      let det = {};
      try { det = drawFromDetail(await get(it.link), iso); } catch (e) { console.warn('[vpo] detail failed:', e.message); }
      if (det.whenISO && det.whenISO >= today) {
        upcoming = { stage: st, whenText: det.whenText || null, whenTime: det.whenTime || null, whenISO: det.whenISO, url: it.link, youtube: det.youtube || null };
      }
    }
    if (latest && upcoming) break;
  }
  if (!latest) { const it = etaps[0]; latest = { stage: stageNo(it.title) || stageNo(it.description), dateISO: toISO(it.pubDate), url: it.link }; }

  const data = { updated: today, newsUrl: NEWS, feedUrl: FEED, upcoming, latest };
  if (!data.latest && !data.upcoming) { console.warn('[vpo] nothing extracted; keeping snapshot'); return; }
  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[vpo] wrote', path.relative(ROOT, OUT), JSON.stringify(data));
}

// run only when executed directly (not when imported by tests)
if (process.argv[1] && import.meta.url === 'file://' + process.argv[1]) {
  main().catch((e) => { console.warn('[vpo] non-fatal error:', e.message); process.exit(0); });
}
