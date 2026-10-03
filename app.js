/* DSR Trip Mapper - maps a trip from an exported Google Timeline.
   Import Timeline.json (phone export) or Google Takeout files -> choose From/To -> a map with each day in its
   own colour (walked dotted, driven solid, flown dashed), day chips to zoom from the whole trip down to one day,
   a per-day summary (km walked / driven / flown + towns) and PDF / JPEG export, small for phones or A4 for print.
   Everything is worked out on the device; only place-name lookups (OpenStreetMap Nominatim) go out. */
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MODES = { walk: "Walked", drive: "Driven", fly: "Flown" };
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#00a6a6", "#f032e6", "#9a6324", "#808000", "#000075",
  "#e6b400", "#800000", "#2f8f4f", "#ff6f91", "#5b5bd6", "#c45c00"];
const dayColour = i => PALETTE[i % PALETTE.length];
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";   // free; (CARTO now wants an API key)
const ATTRIB = "© OpenStreetMap contributors";

/* ======================= reading the Timeline ======================= */
/* time + the local day it belongs to. Phone exports carry the local offset ("+01:00"); old Takeout files are
   UTC ("Z") - there the offset is estimated from the longitude (15° per hour), good enough to pick the day. */
function stamp(iso, lon) {
  if (iso == null) return null;
  const s = String(iso), t = /^\d+$/.test(s) ? +s : Date.parse(s);
  if (isNaN(t)) return null;
  let off;
  const m = s.match(/([+-])(\d\d):?(\d\d)$/);
  if (m) off = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  else off = Math.round((lon || 0) / 15) * 60;
  const d = new Date(t + off * 60000);
  return { t, day: d.toISOString().slice(0, 10), off };
}
function parseLL(v) {
  if (!v) return null;
  if (typeof v === "object") {
    if (v.latitudeE7 != null) return [v.latitudeE7 / 1e7, v.longitudeE7 / 1e7];
    if (v.latE7 != null) return [v.latE7 / 1e7, v.lngE7 / 1e7];
    if (v.latLng) return parseLL(v.latLng);
    if (v.LatLng) return parseLL(v.LatLng);
    return null;
  }
  const m = String(v).match(/(-?\d+(?:\.\d+)?)[^\d,-]*,\s*(-?\d+(?:\.\d+)?)/);   // "-33.9°, 151.2°" or "geo:-33.9,151.2"
  return m ? [+m[1], +m[2]] : null;
}
function modeOf(type) {
  const t = String(type || "").toUpperCase();
  if (/FLY|PLANE|AIR/.test(t)) return "fly";
  if (/WALK|FOOT|RUN|HIK/.test(t)) return "walk";
  if (!t || /UNKNOWN|STILL/.test(t)) return null;
  return "drive";   // car, bus, train, tram, subway, ferry, cycling, motorcycling ...
}
const R = 6371.0088;
function km(a, b) {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const pathKm = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += km(pts[i - 1], pts[i]); return s; };
/* speed check: Google sometimes labels a flight as driving (or leaves it unknown) */
function judge(mode, distKm, hours) {
  const v = hours > 0 ? distKm / hours : 0;
  if (distKm > 150 && v > 250) return "fly";
  if (mode) return mode;
  if (v < 7) return "walk";
  return "drive";
}

/* -> { legs:[{t0,t1,day,mode,pts:[[lat,lon]],km}], visits:[{t,day,ll}] } */
function parseTimeline(json, into) {
  const legs = into.legs, visits = into.visits, pathPts = [];
  const segs = Array.isArray(json) ? json : json.semanticSegments;
  if (Array.isArray(segs)) {                                   // phone export (Android, and iPhone's array form)
    for (const s of segs) {
      const t0 = Date.parse(s.startTime), base = isNaN(t0) ? null : t0;
      for (const p of s.timelinePath || []) {
        const ll = parseLL(p.point); if (!ll) continue;
        const t = p.time ? Date.parse(p.time) : base != null && p.durationMinutesOffsetFromStartTime != null ? base + p.durationMinutesOffsetFromStartTime * 60000 : NaN;
        if (!isNaN(t)) pathPts.push({ t, ll });
      }
      if (s.activity) {
        const a = s.activity, st = parseLL(a.start), en = parseLL(a.end);
        if (!st || !en) continue;
        const A = stamp(s.startTime, st[1]), B = stamp(s.endTime, en[1]); if (!A || !B) continue;
        legs.push({ t0: A.t, t1: B.t, day: A.day, type: a.topCandidate?.type, start: st, end: en, dist: +a.distanceMeters || 0 });
      } else if (s.visit) {
        const ll = parseLL(s.visit.topCandidate?.placeLocation); const A = ll && stamp(s.startTime, ll[1]);
        if (A) visits.push({ t: A.t, day: A.day, ll });
      }
    }
  }
  if (Array.isArray(json.timelineObjects)) for (const o of json.timelineObjects) {   // Takeout "Semantic Location History"
    const a = o.activitySegment, v = o.placeVisit;
    if (a) {
      const st = parseLL(a.startLocation), en = parseLL(a.endLocation); if (!st || !en) continue;
      const A = stamp(a.duration?.startTimestamp ?? a.duration?.startTimestampMs, st[1]), B = stamp(a.duration?.endTimestamp ?? a.duration?.endTimestampMs, en[1]); if (!A || !B) continue;
      const way = (a.waypointPath?.waypoints || []).map(parseLL).filter(Boolean);
      const sim = (a.simplifiedRawPath?.points || []).map(p => ({ t: Date.parse(p.timestamp ?? +p.timestampMs), ll: parseLL(p) })).filter(p => p.ll && !isNaN(p.t));
      for (const q of sim) pathPts.push(q);
      legs.push({ t0: A.t, t1: B.t, day: A.day, type: a.activityType, start: st, end: en, dist: +a.distance || +a.waypointPath?.distanceMeters || 0, way });
    }
    if (v?.location) { const ll = parseLL(v.location); const A = ll && stamp(v.duration?.startTimestamp ?? v.duration?.startTimestampMs, ll[1]); if (A) visits.push({ t: A.t, day: A.day, ll }); }
  }
  if (Array.isArray(json.locations)) {                         // Takeout "Records.json": raw points only
    for (const l of json.locations) { const ll = parseLL(l); const t = l.timestamp ? Date.parse(l.timestamp) : +l.timestampMs; if (ll && !isNaN(t)) into.raw.push({ t, ll }); }
  }
  for (const q of pathPts) into.path.push(q);   // (not push(...) - a real Timeline has far more points than a call can take)
}

/* attach the recorded path to each journey and settle its mode and length */
function finish(d) {
  d.path.sort((a, b) => a.t - b.t);
  const P = d.path, at = t => { let lo = 0, hi = P.length; while (lo < hi) { const m = (lo + hi) >> 1; if (P[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const legs = [];
  for (const g of d.legs) {
    let pts = [g.start];
    if (g.way?.length) for (const q of g.way) pts.push(q);
    else for (let i = at(g.t0); i < P.length && P[i].t <= g.t1; i++) pts.push(P[i].ll);
    pts.push(g.end);
    const straight = km(g.start, g.end), hours = (g.t1 - g.t0) / 3.6e6;
    const mode = judge(modeOf(g.type), Math.max(straight, g.dist / 1000), hours);
    if (mode === "fly") pts = [g.start, g.end];
    let dist = mode === "fly" ? straight : (g.dist / 1000 || pathKm(pts));
    if (dist < 0.05) continue;
    legs.push({ t0: g.t0, t1: g.t1, day: g.day, mode, pts, km: dist });
  }
  if (!d.legs.length && d.raw.length) for (const q of fromRaw(d.raw)) legs.push(q);   // only raw points: work the journeys out by speed
  legs.sort((a, b) => a.t0 - b.t0);
  d.visits.sort((a, b) => a.t - b.t);
  return { legs, visits: d.visits };
}
function fromRaw(raw) {
  raw.sort((a, b) => a.t - b.t);
  const out = []; let cur = null;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i], d = km(a.ll, b.ll), h = (b.t - a.t) / 3.6e6;
    if (d < 0.05 || h <= 0) { cur = null; continue; }
    if (h > 3 && d / h < 250) { cur = null; continue; }        // a long gap that isn't a flight: don't join it up
    const mode = judge(null, d, h), A = stamp(a.t, a.ll[1]);
    if (cur && cur.mode === mode && mode !== "fly" && cur.day === A.day) { cur.pts.push(b.ll); cur.km += d; cur.t1 = b.t; }
    else { cur = { t0: a.t, t1: b.t, day: A.day, mode, pts: [a.ll, b.ll], km: d }; out.push(cur); }
  }
  return out;
}

/* ======================= stored data (IndexedDB - stays on this device) ======================= */
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open("dsrtripmapper", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("kv", mode), s = t.objectStore("kv"); const r = fn(s); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); };
  return { get: k => tx("readonly", s => s.get(k)), set: (k, v) => tx("readwrite", s => s.put(v, k)) };
})();
let DATA = null;   // { legs, visits, from, to, files }

function setInfo() {
  if (!DATA) return;
  const n = DATA.legs.length;
  $("#dataInfo").innerHTML = `Loaded <b>${esc(DATA.files)}</b>: ${n.toLocaleString()} journeys, ${fmtDate(DATA.from)} to ${fmtDate(DATA.to)}. Stored on this device only.`;
  $("#dFrom").min = $("#dTo").min = DATA.from; $("#dFrom").max = $("#dTo").max = DATA.to;
  if (!$("#dFrom").value) { const to = DATA.to, from = addDays(to, -6) < DATA.from ? DATA.from : addDays(to, -6); $("#dFrom").value = from; $("#dTo").value = to; }
  $("#bMap").disabled = false;
  renderTrips();
}
async function importFiles(files) {
  status("Reading the Timeline…");
  const d = { legs: [], visits: [], path: [], raw: [] };
  let names = [];
  for (const f of files) {
    try { parseTimeline(JSON.parse(await f.text()), d); names.push(f.name); }
    catch (e) { status(`Couldn't read ${f.name}: ${e.message}`); return; }
  }
  const r = finish(d); TRIPS = null;
  if (!r.legs.length) { status("No journeys found in that file. Is it the Timeline export (Timeline.json)?"); return; }
  const days = r.legs.map(l => l.day).sort();
  DATA = { legs: r.legs, visits: r.visits, from: days[0], to: days[days.length - 1], files: names.join(", ") };
  // keep it compact: rounded coordinates
  const slim = { ...DATA, legs: DATA.legs.map(l => ({ ...l, pts: l.pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]) })) };
  try { await DB.set("data", slim); } catch {}
  $("#dFrom").value = ""; setInfo(); status("Timeline loaded - choose the dates and tap Map the trip.");
}

/* ======================= place names (OpenStreetMap Nominatim, cached) ======================= */
const placeCache = (() => { try { return JSON.parse(localStorage.getItem("dsrtrip.places3") || "{}"); } catch { return {}; } })();
let lastAsk = 0;
/* the place at a point: { big: city or town, small: village / hamlet / suburb }, tidied ("City of Edinburgh" -> "Edinburgh") */
const tidy = n => String(n || "").replace(/^City of /i, "").replace(/^Greater /i, "").replace(/^(Royal )?Borough of /i, "").trim();
/* one lookup at a time, at most one a second (their rule); the summary's towns (hi) go ahead of trip-list names (lo) */
const asks = { hi: [], lo: [] }; let asking = false;
function place(ll, low, needCountry) {
  const key = ll[0].toFixed(2) + "," + ll[1].toFixed(2), hit = placeCache[key];
  if (hit && (!needCountry || hit.country != null)) return Promise.resolve(hit);
  return new Promise(res => { asks[low ? "lo" : "hi"].push({ key, ll, res, needCountry }); pump(); });
}
async function pump() {
  if (asking) return; asking = true;
  for (let job; (job = asks.hi.shift() || asks.lo.shift());) {
    if (job.key in placeCache && (!job.needCountry || placeCache[job.key].country != null)) { job.res(placeCache[job.key]); continue; }
    const wait = 1100 - (Date.now() - lastAsk); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAsk = Date.now();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&accept-language=en&lat=${job.ll[0]}&lon=${job.ll[1]}`);
      const a = (await r.json()).address || {};
      placeCache[job.key] = { big: tidy(a.city || a.town), small: tidy(a.village || a.hamlet || a.suburb), country: a.country || "" };   // never councils, counties or states
      try { localStorage.setItem("dsrtrip.places3", JSON.stringify(placeCache)); } catch {}
      job.res(placeCache[job.key]);
    } catch { job.res({ big: "", small: "" }); }   // offline - not cached, tried again next time
  }
  asking = false;
}
/* where you stopped: the town (or the village if there's no town); passing through: towns and cities only */
async function placeName(ll, passing, low) { const p = await place(ll, low); return passing ? p.big : (p.big || p.small); }
/* the towns a day passed through, in order: where each journey starts/ends, visits, and every ~25 km on the road */
async function townsFor(day, progress) {
  const pts = [];
  for (const l of day.legs) {
    pts.push({ t: l.t0, ll: l.pts[0] });
    if (l.mode !== "fly") { let run = 0; for (let i = 1; i < l.pts.length; i++) { run += km(l.pts[i - 1], l.pts[i]); if (run >= 25) { pts.push({ t: l.t0 + 1, ll: l.pts[i], passing: true }); run = 0; } } }
    pts.push({ t: l.t1, ll: l.pts[l.pts.length - 1] });
  }
  for (const v of day.visits) pts.push({ t: v.t, ll: v.ll });
  pts.sort((a, b) => a.t - b.t);
  const pick = pts.length > 14 ? pts.filter((_, i) => i % Math.ceil(pts.length / 14) === 0 || i === pts.length - 1) : pts;
  const out = [];
  for (const p of pick) { const n = await placeName(p.ll, p.passing); progress && progress(); if (n && out[out.length - 1] !== n && !out.includes(n)) out.push(n); }
  return out;
}

/* ======================= finding the trips by themselves ======================= */
/* Home = where most nights end (the last place each day). A day is "away" when any of it is over 40 km from home;
   a run of away days (allowing up to 2 days with no data in between) is a trip, from the day you left to the day you
   got back. One-day ones are day trips. */
const AWAY_KM = 40;
let TRIPS = null;
function detectTrips() {
  const per = new Map(), get = d => per.get(d) || (per.set(d, { pts: [], night: null, nightT: -Infinity, km: 0, flights: 0 }), per.get(d));
  for (const l of DATA.legs) {
    const d = get(l.day), step = Math.max(1, Math.floor(l.pts.length / 30));
    for (let i = 0; i < l.pts.length; i += step) d.pts.push(l.pts[i]);
    d.pts.push(l.pts[l.pts.length - 1]); d.km += l.km; if (l.mode === "fly") d.flights++;
    if (l.t1 > d.nightT) { d.nightT = l.t1; d.night = l.pts[l.pts.length - 1]; }
  }
  for (const v of DATA.visits) { const d = get(v.day); d.pts.push(v.ll); if (v.t > d.nightT) { d.nightT = v.t; d.night = v.ll; } }
  // homes: ~10 km cells holding at least a quarter of all nights (usually one; two if you live in two places)
  const cells = new Map();
  for (const d of per.values()) if (d.night) { const k = Math.round(d.night[0] * 10) + "," + Math.round(d.night[1] * 10); const c = cells.get(k) || { n: 0, la: 0, lo: 0 }; c.n++; c.la += d.night[0]; c.lo += d.night[1]; cells.set(k, c); }
  const all = [...cells.values()], nights = all.reduce((a, c) => a + c.n, 0), sorted = all.sort((a, b) => b.n - a.n);
  const homes = sorted.filter((c, i) => i === 0 || c.n >= nights * 0.25).map(c => [c.la / c.n, c.lo / c.n]);
  if (!homes.length) return { homes, trips: [] };
  const fromHome = p => { let m = Infinity; for (const h of homes) m = Math.min(m, km(h, p)); return m; };
  const days = [...per.keys()].sort(), info = {};
  for (const day of days) { const d = per.get(day); let far = 0, at = null; for (const p of d.pts) { const k = fromHome(p); if (k > far) { far = k; at = p; } } info[day] = { far, at, km: d.km, flights: d.flights, night: d.night }; }
  const trips = []; let cur = null, gap = 0;
  for (let day = days[0]; day <= days[days.length - 1]; day = addDays(day, 1)) {
    const i = info[day];
    if (i && i.far > AWAY_KM) {
      if (!cur) cur = { from: day, to: day, far: 0, at: null, km: 0, flights: 0, days: 0, nights: [] };
      if (i.night && fromHome(i.night) > AWAY_KM) cur.nights.push(i.night);
      cur.to = day; cur.days = daysBetween(cur.from, day) + 1; cur.km += i.km; cur.flights += i.flights;
      if (i.far > cur.far) { cur.far = i.far; cur.at = i.at; }
      gap = 0;
    } else if (cur) {
      if (!i && ++gap <= 2) continue;              // no data for a day or two mid-trip: still away
      trips.push(cur); cur = null; gap = 0;
    }
  }
  if (cur) trips.push(cur);
  trips.reverse();                                  // newest first
  return { homes, trips };
}
/* named after where the nights were spent (the two places with most nights away), else the furthest point */
async function tripName(t) {
  const cells = new Map();
  for (const p of t.nights) { const k = Math.round(p[0] * 10) + "," + Math.round(p[1] * 10); const c = cells.get(k) || { n: 0, p }; c.n++; cells.set(k, c); }
  const spots = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 3).map(c => c.p);
  if (!spots.length && t.at) spots.push(t.at);
  const names = [];
  for (const p of spots) { const n = await placeName(p, false, true); if (n && !names.includes(n)) names.push(n); if (names.length === 2) break; }
  return names.length ? "Trip to " + names.join(" & ") : `Trip ${t.far.toFixed(0)} km from home`;
}
let showDayTrips = false, tripsShown = 15;
function renderTrips() {
  const box = $("#trips"); if (!DATA) return;
  if (!TRIPS) TRIPS = detectTrips();
  const list = TRIPS.trips.filter(t => showDayTrips || t.days > 1);
  if (!TRIPS.homes.length || !TRIPS.trips.length) { box.innerHTML = '<div class="small dim">No trips away from home found - choose the dates yourself below.</div>'; return; }
  const range = t => t.from === t.to ? fmtDate(t.from) : `${shortDate(t.from)} – ${fmtDate(t.to)}`;
  box.innerHTML = `<div class="small dim" style="margin-bottom:6px">Home: <b id="homeName">…</b> (where you sleep most nights). ${list.length} ${list.length === 1 ? "trip" : showDayTrips ? "trips and day trips" : "trips"} found - tap one to map it.</div>` +
    list.slice(0, tripsShown).map(t => `<button class="trip" data-i="${TRIPS.trips.indexOf(t)}"><span class="tn">${t.flights ? "✈ " : ""}<span class="tname">${esc(t.name || "…")}</span></span>
      <span class="small dim">${range(t)} · ${t.days} day${t.days > 1 ? "s" : ""} · ${Math.round(t.km).toLocaleString()} km${t.flights ? ` · ${t.flights} flight${t.flights > 1 ? "s" : ""}` : ""}</span></button>`).join("") +
    `<div class="row" style="margin-top:8px">${list.length > tripsShown ? '<button class="btn ghost" id="tMore">Show more</button>' : ""}
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="tDay" ${showDayTrips ? "checked" : ""}> Include day trips</label></div>`;
  box.querySelectorAll(".trip").forEach(b => b.onclick = () => { const t = TRIPS.trips[+b.dataset.i]; $("#dFrom").value = t.from; $("#dTo").value = t.to; mapTrip(t.name); });
  if ($("#tMore")) $("#tMore").onclick = () => { tripsShown += 15; renderTrips(); };
  $("#tDay").onchange = e => { showDayTrips = e.target.checked; tripsShown = 15; renderTrips(); };
  // names, slowly (shared one-a-second lookups; the open trip's towns go first)
  const shown = TRIPS;
  placeName(TRIPS.homes[0], false, true).then(n => { const h = $("#homeName"); if (h && shown === TRIPS) h.textContent = n || "found"; });
  for (const b of box.querySelectorAll(".trip")) {
    const t = TRIPS.trips[+b.dataset.i];
    if (t.name) continue;
    tripName(t).then(n => { t.name = n; const el = b.querySelector(".tname"); if (el) el.textContent = n; });
  }
}

/* ======================= the trip ======================= */
let TRIP = null;   // { from, to, days:[{day, colour, legs, visits, km:{walk,drive,fly}, towns, flights}] }
function buildTrip(from, to) {
  const legs = DATA.legs.filter(l => l.day >= from && l.day <= to);
  const visits = DATA.visits.filter(v => v.day >= from && v.day <= to);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const L = legs.filter(l => l.day === d);
    const k = { walk: 0, drive: 0, fly: 0 }; L.forEach(l => k[l.mode] += l.km);
    days.push({ day: d, legs: L, visits: visits.filter(v => v.day === d), km: k, towns: null });
  }
  days.forEach((d, i) => d.colour = dayColour(i));
  unwrap(days);
  return { from, to, days };
}
/* a trip over the Pacific: keep longitudes continuous so the line doesn't wrap the whole world */
function unwrap(days) {
  let prev = null;
  for (const d of days) for (const l of d.legs) {
    l.draw = l.pts.map(p => [p[0], p[1]]);
    for (const p of l.draw) { if (prev != null) { while (p[1] - prev > 180) p[1] -= 360; while (p[1] - prev < -180) p[1] += 360; } prev = p[1]; }
    if (l.mode === "fly") l.draw = arc(l.draw[0], l.draw[1]);
  }
}
/* great-circle path for a flight (what the plane roughly flies), in continuous longitudes */
function arc(a, b) {
  const r = Math.PI / 180, toV = p => [Math.cos(p[0] * r) * Math.cos(p[1] * r), Math.cos(p[0] * r) * Math.sin(p[1] * r), Math.sin(p[0] * r)];
  const A = toV(a), B = toV(b), dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])), w = Math.acos(dot);
  if (w < 1e-4) return [a, b];
  const n = Math.max(8, Math.min(96, Math.round(w / r / 2))), out = [];
  let prev = a[1];
  for (let i = 0; i <= n; i++) {
    const f = i / n, s1 = Math.sin((1 - f) * w) / Math.sin(w), s2 = Math.sin(f * w) / Math.sin(w);
    const x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
    let lat = Math.atan2(z, Math.hypot(x, y)) / r, lon = Math.atan2(y, x) / r;
    while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; prev = lon;
    out.push([lat, lon]);
  }
  return out;
}

/* ======================= countries / areas within a trip ======================= */
/* 1h: the ground travel (walks + drives) split wherever there's a flight, then parts within 500 km of each other joined
   (so a country visited twice is one area); short airport stopovers dropped. Two or more areas -> each gets a map. */
function findRegions() {
  const groups = []; let cur = null;
  for (const d of TRIP.days) for (const l of d.legs) {
    if (l.mode === "fly") { cur = null; continue; }
    if (!cur) { cur = { legs: [] }; groups.push(cur); }
    cur.legs.push(l);
  }
  const centre = g => { let la = 0, lo = 0, n = 0; for (const l of g.legs) for (const p of [l.draw[0], l.draw[l.draw.length - 1]]) { la += p[0]; lo += p[1]; n++; } return [la / n, lo / n]; };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++)
      if (km(centre(groups[i]), centre(groups[j])) < 500) { groups[i].legs.push(...groups[j].legs); groups.splice(j, 1); merged = true; break outer; }
  }
  const out = [];
  for (const g of groups) {
    g.legs.sort((a, b) => a.t0 - b.t0);
    const k = { walk: 0, drive: 0, fly: 0 }; g.legs.forEach(l => k[l.mode] += l.km);
    const days = TRIP.days.filter(d => d.legs.some(l => g.legs.includes(l)));
    if (k.walk + k.drive < 15 && days.length < 2) continue;          // a stopover
    const c = centre(g); let rep = g.legs[0].draw[0], best = Infinity;
    for (const l of g.legs) for (const p of [l.draw[0], l.draw[l.draw.length - 1]]) { const dd = km(c, p); if (dd < best) { best = dd; rep = p; } }
    out.push({ legs: g.legs, days, km: k, from: days[0].day, to: days[days.length - 1].day, rep, name: null });
  }
  return out.length >= 2 ? out : [];
}
async function nameRegions(regions) {
  for (const r of regions) { const p = await place([r.rep[0], ((r.rep[1] + 540) % 360) - 180], false, true); r.country = p.country || ""; r.town = p.big || p.small || ""; }
  for (const r of regions) {
    const same = regions.filter(x => x.country === r.country).length > 1;
    r.name = r.country ? (same && r.town ? `${r.country} – ${r.town}` : r.country) : (r.town || "Area");
  }
}
const regionDates = r => r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`;

/* ======================= the map ======================= */
let map = null, layer = null;
function styleFor(mode, colour, scale = 1) {
  if (mode === "walk") return { color: colour, weight: 4.5 * scale, dashArray: `0.1 ${8 * scale}`, lineCap: "round", opacity: 1 };
  if (mode === "fly") return { color: colour, weight: 3 * scale, dashArray: `${11 * scale} ${8 * scale}`, lineCap: "butt", opacity: 0.95 };
  return { color: colour, weight: 4 * scale, opacity: 0.95, lineCap: "round", lineJoin: "round" };
}
function drawMap() {
  $("#out").classList.remove("hidden");
  if (!map) {
    map = L.map("map", { minZoom: 1, maxZoom: 19, worldCopyJump: false, zoomSnap: 0.25 });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB, crossOrigin: true }).addTo(map);
    lockControl().addTo(map);
  }
  if (layer) layer.remove();
  layer = L.featureGroup().addTo(map);
  for (const d of TRIP.days) for (const l of d.legs) {
    const pl = L.polyline(l.draw, styleFor(l.mode, d.colour)).addTo(layer);
    pl.bindPopup(`<b>${fmtDate(d.day)}</b><br>${MODES[l.mode]} ${l.km.toFixed(1)} km<br>${fmtTime(l.t0)} - ${fmtTime(l.t1)}`);
  }
  // a small dot where each day starts
  for (const d of TRIP.days) if (d.legs.length) L.circleMarker(d.legs[0].draw[0], { radius: 5, color: "#fff", weight: 2, fillColor: d.colour, fillOpacity: 1 }).addTo(layer).bindTooltip(fmtDate(d.day));
  chips();
  fitTo(null);
}
/* 1h: a little padlock on the map - locked, the map can't be dragged or zoomed by touch, so the page scrolls past it
   freely (the day / area chips still move it). Remembered. */
let locked = (() => { try { return localStorage.getItem("dsrtrip.locked") === "1"; } catch { return false; } })();
function applyLock() {
  for (const h of ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"]) map[h] && (locked ? map[h].disable() : map[h].enable());
  document.querySelectorAll(".lockbtn").forEach(b => { b.textContent = locked ? "🔒" : "🔓"; b.title = locked ? "Map locked - tap to unlock" : "Tap to lock the map"; });
  document.querySelectorAll(".leaflet-control-zoom").forEach(z => z.style.display = locked ? "none" : "");
}
function lockControl() {
  const C = L.Control.extend({ options: { position: "topright" }, onAdd() {
    const b = L.DomUtil.create("button", "lockbtn");
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => { locked = !locked; try { localStorage.setItem("dsrtrip.locked", locked ? "1" : "0"); } catch {} applyLock(); };
    setTimeout(applyLock); return b;
  } });
  return new C();
}
function boundsOf(days) { const b = L.latLngBounds([]); for (const d of days) for (const l of d.legs) b.extend(l.draw); return b; }
function boundsOfLegs(legs) { const b = L.latLngBounds([]); for (const l of legs) b.extend(l.draw); return b; }
function fitBox(b) { if (b.isValid()) map.fitBounds(b.pad(0.08), { maxZoom: 16 }); else map.setView([20, 0], 2); }
function fitTo(i) { fitBox(boundsOf(i == null ? TRIP.days : [TRIP.days[i]])); }
function chips() {
  const c = $("#chips"); c.innerHTML = "";
  const add = (html, fn) => { const b = document.createElement("button"); b.className = "chip"; b.innerHTML = html;
    b.onclick = () => { c.querySelectorAll(".chip").forEach(x => x.classList.toggle("sel", x === b)); fn(); }; c.appendChild(b); return b; };
  add("🌍 Whole trip", () => fitTo(null)).classList.add("sel");
  for (const r of TRIP.regions) { r.chip = add(`🗺 <span class="rn">${esc(r.name || "…")}</span> · ${r.days.length} day${r.days.length > 1 ? "s" : ""}`, () => fitBox(boundsOfLegs(r.legs))); }
  TRIP.days.forEach((d, i) => { const t = d.km.walk + d.km.drive + d.km.fly; add(`<span class="sw" style="background:${d.colour}"></span>${shortDate(d.day)} · ${t.toFixed(0)} km`, () => d.legs.length ? fitTo(i) : toast("No travel recorded that day")); });
}

/* ======================= summary ======================= */
const f1 = n => n >= 100 ? n.toFixed(0) : n.toFixed(1);
const kmOr = n => n < 0.05 ? "–" : f1(n) + " km";   // nothing that way that day
function totals() { const t = { walk: 0, drive: 0, fly: 0 }; TRIP.days.forEach(d => { t.walk += d.km.walk; t.drive += d.km.drive; t.fly += d.km.fly; }); return t; }
function flightsOf(d) { return d.legs.filter(l => l.mode === "fly"); }
/* 1e: stacked day blocks (a 6-column table was too wide for a phone and pushed the day totals off screen) */
function renderSummary() {
  const t = totals();
  const parts = k => [["🚶", "Walked", k.walk], ["🚗", "Driven", k.drive], ["✈", "Flown", k.fly]].filter(x => x[2] >= 0.05)
    .map(([ic, lb, v]) => `<span class="part">${ic} ${lb} <b>${f1(v)} km</b></span>`).join("") || '<span class="part dim">No travel recorded</span>';
  let h = "";
  TRIP.days.forEach((d, i) => {
    const tot = d.km.walk + d.km.drive + d.km.fly;
    h += `<div class="sday" style="border-left-color:${d.colour}">
      <div class="shead"><span><b>Day ${i + 1}</b> · ${fmtDate(d.day)}</span><span class="stot">${f1(tot)} km</span></div>
      <div class="stowns">${d.towns == null ? '<span class="dim">finding the towns…</span>' : esc(d.towns.join(" → ") || "-")}</div>
      ${flightsOf(d).map(l => `<div class="sfly">✈ ${esc(l.from || "…")} → ${esc(l.to || "…")} · ${f1(l.km)} km</div>`).join("")}
      <div class="sparts">${parts(d.km)}</div></div>`;
  });
  const nf = TRIP.days.reduce((n, d) => n + flightsOf(d).length, 0);
  h += `<div class="stotal"><div class="shead"><b>Trip total</b><span class="stot">${f1(t.walk + t.drive + t.fly)} km</span></div>
    <div class="trow"><span>🚶 Walked</span><b>${f1(t.walk)} km</b></div>
    <div class="trow"><span>🚗 Driven</span><b>${f1(t.drive)} km</b></div>
    <div class="trow strong"><span>On the ground</span><b>${f1(t.walk + t.drive)} km</b></div>
    ${t.fly ? `<div class="trow strong"><span>✈ Flown (${nf} flight${nf > 1 ? "s" : ""})</span><b>${f1(t.fly)} km</b></div>` : ""}</div>`;
  $("#summary").innerHTML = h;
}
async function findTowns() {
  const need = TRIP.days.filter(d => d.towns == null && (d.legs.length || d.visits.length)).length;
  let done = 0; const trip = TRIP;
  for (const d of trip.days) {
    if (trip !== TRIP) return;
    if (!d.legs.length && !d.visits.length) { d.towns = []; continue; }
    status(`Finding the towns… day ${++done} of ${need}`);
    d.towns = await townsFor(d);
    for (const l of flightsOf(d)) { l.from = await placeName(l.pts[0]); l.to = await placeName(l.pts[l.pts.length - 1]); }
    renderSummary();
  }
  status("");
}
async function mapTrip(title) {
  const from = $("#dFrom").value, to = $("#dTo").value;
  if (!from || !to) return status("Choose the From and To dates.");
  if (to < from) return status("The To date is before the From date.");
  if (daysBetween(from, to) > 400) return status("That's over a year - choose up to 400 days.");
  TRIP = buildTrip(from, to);
  if (!TRIP.days.some(d => d.legs.length)) { status("No travel recorded between those dates."); $("#out").classList.add("hidden"); return; }
  status(""); showTrip(typeof title === "string" ? title : "");
  TRIP.regions = findRegions();
  drawMap(); renderSummary();
  const trip = TRIP;
  nameRegions(trip.regions).then(() => { if (trip !== TRIP) return; for (const r of trip.regions) if (r.chip) r.chip.querySelector(".rn").textContent = r.name; regionsNote(); });
  regionsNote();
  findTowns();
}

/* ======================= export: draw our own map picture (tiles + lines) ======================= */
const SIZES = {
  mobile: { land: [1350, 1000], port: [1080, 1440], q: 0.8, font: 1, tile: 1 },
  a4: { land: [3508, 2480], port: [2480, 3508], q: 0.88, font: 2.6, tile: 2.5 },   // A4 at 300 dpi; map tiles drawn 2.5x so their labels print readably
};
const loadImg = src => new Promise(res => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
const project = (lat, lon, z) => { const s = 256 * 2 ** z, x = (lon + 180) / 360 * s, sl = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return [x, (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * s]; };
/* view = null for the whole trip, else { title, legs:Set, days, km, note } for a day or a country/area page
   (everything outside it drawn faintly for context) */
const dayView = i => { const d = TRIP.days[i]; return { title: `Day ${i + 1} · ${fmtDate(d.day)}`, legs: new Set(d.legs), days: [d], km: d.km, note: `This day${TRIP.days.length > 1 ? " - the rest of the trip is shown faintly" : ""}` }; };
const regionView = r => ({ title: `${r.name} · ${regionDates(r)}`, legs: new Set(r.legs), days: r.days, km: r.km, note: null });
async function renderMapCanvas(sz, onProgress, view = null) {
  const focus = view ? view.days : TRIP.days, inView = l => !view || view.legs.has(l);
  let b = view ? boundsOfLegs([...view.legs]) : boundsOf(focus);
  if (b.getNorthEast().lat - b.getSouthWest().lat < 0.01 && b.getNorthEast().lng - b.getSouthWest().lng < 0.01) b = b.pad(2);   // a tiny walk: don't zoom to the pavement
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const land = (ne.lng - sw.lng) * Math.cos((sw.lat + ne.lat) / 2 * Math.PI / 180) >= (ne.lat - sw.lat);
  const [W, H] = land ? sz.land : sz.port, U = sz.font;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  // title band, map box, key band
  const pad = Math.round(28 * U), titleH = Math.round(70 * U), keyRows = view && view.note ? 1 : Math.ceil(focus.length / (land ? 5 : 3));
  const keyH = Math.round((52 + Math.min(keyRows, 8) * 26) * U);
  const mx = pad, my = titleH, mw = W - 2 * pad, mh = H - titleH - keyH - pad;
  g.fillStyle = "#111"; g.font = `700 ${Math.round(30 * U)}px system-ui, sans-serif`; g.textBaseline = "middle";
  g.fillText(view ? view.title : `Trip map · ${fmtDate(TRIP.from)} – ${fmtDate(TRIP.to)}`, pad, titleH / 2);
  const t = view ? view.km : totals(); g.font = `${Math.round(18 * U)}px system-ui, sans-serif`; g.fillStyle = "#555"; g.textAlign = "right";
  g.fillText(`${f1(t.walk + t.drive)} km on the ground${t.fly ? ` · ${f1(t.fly)} km flown` : ""}`, W - pad, titleH / 2); g.textAlign = "left";
  // the zoom that fits the trip into the box (fractional), tiles from the next whole zoom up for sharpness
  const fit = z => { const a = project(ne.lat, sw.lng, z), q = project(sw.lat, ne.lng, z); return [q[0] - a[0], q[1] - a[1]]; };
  let zf = 0; for (let z = 0; z <= 17; z += 0.05) { const [bw, bh] = fit(z); if (bw > mw * 0.9 || bh > mh * 0.9) break; zf = z; }
  const zt = Math.min(18, Math.max(0, Math.ceil(zf - Math.log2(sz.tile)))), k = 2 ** (zf - zt), ts = 256 * k;
  const ctr = project((sw.lat + ne.lat) / 2, (sw.lng + ne.lng) / 2, zf);
  const ox = ctr[0] - mw / 2, oy = ctr[1] - mh / 2;           // map box's top-left in world pixels at zf
  g.save(); g.beginPath(); g.rect(mx, my, mw, mh); g.clip();
  g.fillStyle = "#e9eef0"; g.fillRect(mx, my, mw, mh);
  const n = 2 ** zt, x0 = Math.floor(ox / ts), x1 = Math.floor((ox + mw) / ts), y0 = Math.max(0, Math.floor(oy / ts)), y1 = Math.min(n - 1, Math.floor((oy + mh) / ts));
  const jobs = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  let done = 0;
  const run = async ([x, y]) => {
    const wx = ((x % n) + n) % n, img = await loadImg(TILES.replace("{z}", zt).replace("{x}", wx).replace("{y}", y));
    if (img) g.drawImage(img, mx + x * ts - ox, my + y * ts - oy, ts + 0.5, ts + 0.5);
    onProgress && onProgress(++done, jobs.length);
  };
  for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(run));   // gently - it's a free service
  // the journeys (flights and drives under walks, so the dotted walks stay visible)
  const P = ll => { const p = project(ll[0], ll[1], zf); return [mx + p[0] - ox, my + p[1] - oy]; };
  const lineScale = U * 1.1;
  for (const faint of view ? [true, false] : [false]) for (const want of ["fly", "drive", "walk"]) for (const d of TRIP.days) for (const l of d.legs) {
    if (l.mode !== want || inView(l) === faint) continue;
    const st = styleFor(l.mode, d.colour, lineScale);
    g.globalAlpha = faint ? 0.3 : 1;
    g.beginPath(); l.draw.forEach((ll, i) => { const [x, y] = P(ll); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.lineWidth = st.weight + 2.5 * U; g.strokeStyle = "rgba(255,255,255,.85)"; g.setLineDash(st.dashArray ? st.dashArray.split(" ").map(Number) : []); g.lineCap = st.lineCap; g.lineJoin = "round"; g.stroke();
    g.lineWidth = st.weight; g.strokeStyle = d.colour; g.stroke();
  }
  g.globalAlpha = 1; g.setLineDash([]);
  for (const d of focus) { const first = d.legs.find(inView); if (!first) continue; const [x, y] = P(first.draw[0]); g.beginPath(); g.arc(x, y, 6 * U, 0, 7); g.fillStyle = d.colour; g.fill(); g.lineWidth = 2.2 * U; g.strokeStyle = "#fff"; g.stroke(); }
  g.restore();
  g.strokeStyle = "#999"; g.lineWidth = 1.5 * U; g.strokeRect(mx, my, mw, mh);
  g.font = `${Math.round(12 * U)}px system-ui, sans-serif`; g.fillStyle = "rgba(0,0,0,.6)"; g.textAlign = "right"; g.fillText(ATTRIB, mx + mw - 6 * U, my + mh - 10 * U); g.textAlign = "left";
  // key: line styles, then the day colours
  let ky = my + mh + Math.round(26 * U);
  g.font = `${Math.round(16 * U)}px system-ui, sans-serif`; g.fillStyle = "#333"; let kx = pad;
  for (const m of ["walk", "drive", "fly"]) {
    const st = styleFor(m, "#444", lineScale); g.beginPath(); g.moveTo(kx, ky); g.lineTo(kx + 46 * U, ky); g.lineWidth = st.weight; g.strokeStyle = "#444";
    g.setLineDash(st.dashArray ? st.dashArray.split(" ").map(Number) : []); g.lineCap = st.lineCap; g.stroke(); g.setLineDash([]);
    g.fillText(MODES[m], kx + 56 * U, ky); kx += 56 * U + g.measureText(MODES[m]).width + 34 * U;
  }
  const cols = land ? 5 : 3, cw = (W - 2 * pad) / cols;
  (view && view.note ? [focus[0]] : focus.slice(0, cols * 8)).forEach((d, i) => {
    const x = pad + (i % cols) * cw, y = ky + Math.round((30 + Math.floor(i / cols) * 26) * U);
    g.beginPath(); g.arc(x + 8 * U, y, 7 * U, 0, 7); g.fillStyle = d.colour; g.fill();
    g.fillStyle = "#333"; g.fillText(view && view.note ? view.note : `Day ${TRIP.days.indexOf(d) + 1} · ${shortDate(d.day)}`, x + 22 * U, y);
  });
  if (!(view && view.note) && focus.length > cols * 8) { g.fillStyle = "#777"; g.fillText(`… ${focus.length - cols * 8} more days - see the summary`, pad, ky + Math.round((30 + 8 * 26) * U)); }
  return c;
}
/* the summary page(s): one row per day, flights listed, totals at the end */
function renderSummaryCanvases(sz) {
  const [W, H] = sz.port, U = sz.font, pad = Math.round(40 * U), pages = [];
  let c, g, y;
  const page = () => { c = document.createElement("canvas"); c.width = W; c.height = H; g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.textBaseline = "alphabetic"; pages.push(c); y = pad; };
  const font = (px, w = 400) => g.font = `${w} ${Math.round(px * U)}px system-ui, sans-serif`;
  const wrap = (text, maxW) => { const words = text.split(" "), lines = []; let cur = ""; for (const w of words) { const t = cur ? cur + " " + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines; };
  const colX = [W - pad - 420 * U, W - pad - 290 * U, W - pad - 160 * U, W - pad];   // walked, driven, flown, total (right-aligned)
  const nums = (vals, bold) => { font(17, bold ? 700 : 400); g.textAlign = "right"; vals.forEach((v, i) => g.fillText(v, colX[i], y)); g.textAlign = "left"; };
  page();
  font(30, 700); g.fillStyle = "#111"; g.fillText("Trip summary", pad, y + 30 * U); y += 48 * U;
  font(17); g.fillStyle = "#666"; g.fillText(`${fmtDate(TRIP.from)} – ${fmtDate(TRIP.to)} · ${TRIP.days.length} days`, pad, y + 14 * U); y += 44 * U;
  const head = () => { font(14, 700); g.fillStyle = "#8a6d00"; g.textAlign = "right"; ["WALKED", "DRIVEN", "FLOWN", "DAY TOTAL"].forEach((h, i) => g.fillText(h, colX[i], y)); g.textAlign = "left"; g.fillText("DAY / TOWNS", pad, y); y += 12 * U; g.fillStyle = "#d4af37"; g.fillRect(pad, y, W - 2 * pad, 2 * U); y += 26 * U; };
  head();
  const textW = colX[0] - 110 * U - pad;
  TRIP.days.forEach((d, i) => {
    font(15); const towns = wrap(d.towns?.length ? d.towns.join(" → ") : d.legs.length ? "-" : "No travel recorded", textW);
    const fl = flightsOf(d).map(l => `✈ ${l.from || "?"} → ${l.to || "?"} · ${f1(l.km)} km`);
    const need = (26 + (towns.length + fl.length) * 21 + 16) * U;
    if (y + need > H - pad) { page(); head(); }
    g.beginPath(); g.arc(pad + 8 * U, y - 6 * U, 8 * U, 0, 7); g.fillStyle = d.colour; g.fill();
    font(17, 700); g.fillStyle = "#111"; g.fillText(`Day ${i + 1} · ${fmtDate(d.day)}`, pad + 24 * U, y);
    const tot = d.km.walk + d.km.drive + d.km.fly; g.fillStyle = "#111";
    nums([kmOr(d.km.walk), kmOr(d.km.drive), kmOr(d.km.fly)], false);
    font(17, 700); g.textAlign = "right"; g.fillText(`${f1(tot)} km`, colX[3], y); g.textAlign = "left";
    y += 24 * U; font(15); g.fillStyle = "#444";
    for (const line of towns) { g.fillText(line, pad + 24 * U, y); y += 21 * U; }
    g.fillStyle = "#1a4fa0"; for (const line of fl) { g.fillText(line, pad + 24 * U, y); y += 21 * U; }
    y += 8 * U; g.fillStyle = "#e4e4e4"; g.fillRect(pad, y - 4 * U, W - 2 * pad, 1.2 * U); y += 16 * U;
  });
  const t = totals();
  if (y + 190 * U > H - pad) page();
  y += 10 * U; g.fillStyle = "#d4af37"; g.fillRect(pad, y, W - 2 * pad, 2.5 * U); y += 40 * U;
  font(22, 700); g.fillStyle = "#111"; g.fillText("Trip total", pad, y); y += 36 * U;
  const line = (label, v, bold) => { font(18, bold ? 700 : 400); g.fillStyle = bold ? "#111" : "#333"; g.fillText(label, pad + 24 * U, y); g.textAlign = "right"; g.fillText(`${f1(v)} km`, colX[3], y); g.textAlign = "left"; y += 30 * U; };
  line("Walked", t.walk); line("Driven", t.drive); line("On the ground", t.walk + t.drive, true);
  if (t.fly) line(`Flown (${TRIP.days.reduce((n, d) => n + flightsOf(d).length, 0)} flights)`, t.fly, true);
  line("Everything", t.walk + t.drive + t.fly, true);
  pages.forEach((p, i) => { const q = p.getContext("2d"); q.font = `${Math.round(12 * U)}px system-ui, sans-serif`; q.fillStyle = "#999"; q.textAlign = "right"; q.fillText(`DSR Trip Mapper · page ${i + 2}`, W - pad, H - pad / 2); });
  return pages;
}
let lastFiles = null;
async function doExport() {
  if (!TRIP) return;
  const sz = SIZES[$("#xSize").value], fmt = $("#xFmt").value, xs = t => $("#xStatus").textContent = t;
  if (TRIP.days.some(d => d.towns == null)) xs("Still finding town names - the export will have what's found so far…");
  $("#bExport").disabled = true;
  try {
    const mapC = await renderMapCanvas(sz, (a, b) => xs(`Drawing the map… ${a}/${b}`));
    const dayPages = [];
    if (TRIP.regions.length >= 2 && $("#xRegions").checked) for (const r of TRIP.regions)
      dayPages.push(await renderMapCanvas(sz, (a, b) => xs(`Drawing the ${r.name || "area"} map… ${a}/${b}`), regionView(r)));
    const nRegionPages = dayPages.length;
    if ($("#xDays").checked) for (let i = 0; i < TRIP.days.length; i++) if (TRIP.days[i].legs.length)
      dayPages.push(await renderMapCanvas(sz, (a, b) => xs(`Drawing day ${i + 1}'s map… ${a}/${b}`), dayView(i)));
    const sum = renderSummaryCanvases(sz), name = `Trip ${TRIP.from} to ${TRIP.to}` + (sz === SIZES.a4 ? " A4" : "");
    const all = [mapC, ...dayPages, ...sum];
    const jpeg = c => new Promise(res => c.toBlob(res, "image/jpeg", sz.q));
    let files = [];
    if (fmt === "jpg") {
      for (let i = 0; i < all.length; i++) files.push(new File([await jpeg(all[i])], `${name} ${String(i + 1).padStart(2, "0")} ${i === 0 ? "map" : i <= nRegionPages ? (TRIP.regions[i - 1].name || "area") : i <= dayPages.length ? "day " + (i - nRegionPages) : "summary"}.jpg`, { type: "image/jpeg" }));
    } else {
      const { jsPDF } = window.jspdf;
      const pageOf = c => sz === SIZES.a4 ? { f: "a4", o: c.width > c.height ? "l" : "p" } : { f: [c.width * 0.75, c.height * 0.75], o: c.width > c.height ? "l" : "p" };
      let pdf = null;
      for (const c of all) {
        const p = pageOf(c);
        if (!pdf) pdf = new jsPDF({ orientation: p.o, unit: "pt", format: p.f, compress: true }); else pdf.addPage(p.f, p.o);
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        pdf.addImage(c.toDataURL("image/jpeg", sz.q), "JPEG", 0, 0, pw, ph);
      }
      files.push(new File([pdf.output("blob")], name + ".pdf", { type: "application/pdf" }));
    }
    for (const f of files) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    lastFiles = files;
    const kb = files.reduce((s, f) => s + f.size, 0) / 1024;
    xs(`Saved ${files.length > 1 ? files.length + " files" : files[0].name} (${kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB"}) to Downloads.`);
    $("#bShare").classList.toggle("hidden", !(navigator.canShare && navigator.canShare({ files })));
  } catch (e) { xs("Export failed: " + e.message); }
  $("#bExport").disabled = false;
}

/* ======================= little helpers ======================= */
function addDays(d, n) { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5); }
function fmtDate(d) { return new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); }
function shortDate(d) { return new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); }
function fmtTime(t) { return new Date(t).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }); }
function regionsNote() {
  const n = TRIP.regions.length, el = $("#xRegionsLbl");
  $("#xRegionsRow").classList.toggle("hidden", n < 2);
  if (el) el.textContent = `Add a map of each country / area (${TRIP.regions.map(r => r.name || "…").join(", ")})`;
}
function status(t) { $("#status").textContent = t; $("#status2").textContent = t; }
/* 1g: while a trip is open, the import + trip list step aside; "‹ All trips" (or the phone's Back) brings them back */
function showTrip(title) {
  $("#tripTitle").textContent = title || "Your trip";
  $("#tripDates").textContent = `${fmtDate(TRIP.from)} – ${fmtDate(TRIP.to)}`;
  if (!document.body.classList.contains("viewing")) { document.body.classList.add("viewing"); history.pushState({ trip: 1 }, ""); }
  window.scrollTo(0, 0);
  if (map) setTimeout(() => map.invalidateSize(), 50);
}
function backToTrips() {
  document.body.classList.remove("viewing"); $("#out").classList.add("hidden");
  const sel = $("#trips"); if (sel) sel.scrollIntoView(); else window.scrollTo(0, 0);
}
$("#bBack").onclick = () => history.state?.trip ? history.back() : backToTrips();
window.addEventListener("popstate", () => { if (document.body.classList.contains("viewing")) backToTrips(); });
function toast(t) { status(t); setTimeout(() => { if ($("#status").textContent === t) status(""); }, 3000); }

/* ======================= wiring ======================= */
$("#bImport").onclick = () => $("#file").click();
$("#file").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) importFiles(f); };
$("#bHow").onclick = () => alert("Export your Google Timeline (it lives on your phone now):\n\n" +
  "Android: Settings › Location › Location services › Timeline › Export Timeline data - save Timeline.json.\n" +
  "(Or in Google Maps: your picture › Your Timeline › ⋮ › Location & privacy settings › Export Timeline data.)\n\n" +
  "iPhone: Google Maps › your picture › Settings › Personal content › Export Timeline data.\n\n" +
  "Older Google Takeout downloads work too (Records.json or the Semantic Location History month files - pick several at once).\n\nThen tap Import Timeline file and choose it.");
$("#bMap").onclick = mapTrip;
$("#bExport").onclick = doExport;
$("#bShare").onclick = () => lastFiles && navigator.share({ files: lastFiles, title: "Trip map" }).catch(() => {});
(async () => {
  try { const d = await DB.get("data"); if (d?.legs?.length) { DATA = d; setInfo(); } } catch {}
})();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
