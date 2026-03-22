import { useState, useMemo, useEffect } from "react";

// ── Zmanim / rest window helpers ──────────────────────────────────────────────
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function fmtDateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const YT_EVES = {
  2024: [
    "2024-04-22",
    "2024-04-28",
    "2024-06-11",
    "2024-10-02",
    "2024-10-03",
    "2024-10-11",
    "2024-10-16",
    "2024-10-23",
  ],
  2025: [
    "2025-04-12",
    "2025-04-18",
    "2025-06-01",
    "2025-09-22",
    "2025-09-23",
    "2025-10-01",
    "2025-10-06",
    "2025-10-13",
  ],
  2026: [
    "2026-04-01",
    "2026-04-07",
    "2026-05-21",
    "2026-09-11",
    "2026-09-12",
    "2026-09-20",
    "2026-09-25",
    "2026-10-02",
  ],
  2027: [
    "2027-04-21",
    "2027-04-27",
    "2027-06-10",
    "2027-10-01",
    "2027-10-02",
    "2027-10-10",
    "2027-10-15",
    "2027-10-22",
  ],
};

function getRestEves(tripStart, tripEnd) {
  const eves = new Set();
  const cur = new Date(tripStart);
  cur.setHours(0, 0, 0, 0);
  const scanEnd = addDays(tripEnd, 1);
  while (cur <= scanEnd) {
    const key = fmtDateKey(cur);
    if (cur.getDay() === 5) eves.add(key);
    const y = cur.getFullYear();
    if ((YT_EVES[y] || []).includes(key)) eves.add(key);
    cur.setDate(cur.getDate() + 1);
  }
  return [...eves];
}

// Sinusoidal fallback for Jerusalem sunset
function sunsetMinutesFallback(date) {
  const doy = Math.round(
    (date - new Date(date.getFullYear(), 0, 0)) / 86400000,
  );
  return Math.round(
    18 * 60 + 15 - 95 * Math.cos((2 * Math.PI * (doy - 172)) / 365),
  );
}

const zmanimCache = {};
async function fetchZmanim(dateStr) {
  if (zmanimCache[dateStr]) return zmanimCache[dateStr];
  try {
    const r = await fetch(`/api/zmanim?date=${dateStr}`);
    if (!r.ok) throw new Error();
    const data = await r.json();
    zmanimCache[dateStr] = data;
    return data;
  } catch {
    return null;
  }
}

function buildWindowFromZmanim(eveZmanim, nextZmanim) {
  if (!eveZmanim || !nextZmanim) return null;
  const start = new Date(eveZmanim.bein_hashmashos);
  const end = new Date(nextZmanim.tzet);
  if (isNaN(start) || isNaN(end)) return null;
  return { start, end };
}

function buildWindowFallback(eveDateStr) {
  const eve = new Date(eveDateStr);
  const sm = sunsetMinutesFallback(eve) - 18;
  const nd = addDays(eve, 1);
  const em = sunsetMinutesFallback(nd) + 50;
  const s = new Date(eve);
  s.setHours(Math.floor(sm / 60), sm % 60, 0, 0);
  const e = new Date(nd);
  e.setHours(Math.floor(em / 60), em % 60, 0, 0);
  return { start: s, end: e };
}

async function computeRestWindows(tripStart, tripEnd) {
  const eves = getRestEves(tripStart, tripEnd);
  const datesToFetch = new Set();
  eves.forEach((eve) => {
    datesToFetch.add(eve);
    datesToFetch.add(fmtDateKey(addDays(new Date(eve), 1)));
  });
  const results = await Promise.all(
    [...datesToFetch].map((d) => fetchZmanim(d).then((z) => [d, z])),
  );
  const zmap = Object.fromEntries(results.filter(([, z]) => z));
  const usingFallback = results.some(([, z]) => !z);

  const windows = [];
  for (const eve of eves) {
    const nextDay = fmtDateKey(addDays(new Date(eve), 1));
    const w =
      zmap[eve] && zmap[nextDay]
        ? buildWindowFromZmanim(zmap[eve], zmap[nextDay])
        : buildWindowFallback(eve);
    if (w) windows.push(w);
  }

  // Merge overlapping
  windows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of windows) {
    if (merged.length && w.start <= merged[merged.length - 1].end)
      merged[merged.length - 1].end = new Date(
        Math.max(merged[merged.length - 1].end, w.end),
      );
    else merged.push({ start: new Date(w.start), end: new Date(w.end) });
  }
  return { windows: merged, usingFallback };
}

// CityCar/MyCar: flat 24h per overlapping rest window
function getCCExcludedHours(tripStart, tripEnd, windows) {
  let count = 0;
  for (const w of windows) {
    const overlap = Math.min(tripEnd, w.end) - Math.max(tripStart, w.start);
    if (overlap > 0) count++;
  }
  return count * 24;
}

// Check if a datetime falls inside any rest window
function isInRestWindow(dt, windows) {
  return windows.some((w) => dt >= w.start && dt <= w.end);
}

// ── Seasonal surcharge ────────────────────────────────────────────────────────
// Parsed from CityCar API seasonHeader/seasonDetails, with hardcoded fallback
const FALLBACK_SEASONS = [
  {
    start: new Date("2026-03-29T00:00:00"),
    end: new Date("2026-04-09T23:59:59"),
    hourRate: 3,
    dayRate: 50,
  },
];

function parseSeasonFromAPI(cat) {
  try {
    // seasonHeader: "בין התאריכים י\"א ניסן 29/03/2026 עד וכולל כ\"ב ניסן 09/04/2026\nתחול תוספת עונה:"
    // seasonDetails: "לשעה: ₪3 | יומי, שבועי, חודשי: ₪50 ליום"
    if (!cat.seasonHeader || !cat.seasonDetails) return null;
    const dateMatch = cat.seasonHeader.match(
      /(\d{2}\/\d{2}\/\d{4}).*?(\d{2}\/\d{2}\/\d{4})/,
    );
    if (!dateMatch) return null;
    const [d1, m1, y1] = dateMatch[1].split("/");
    const [d2, m2, y2] = dateMatch[2].split("/");
    const start = new Date(`${y1}-${m1}-${d1}T00:00:00`);
    const end = new Date(`${y2}-${m2}-${d2}T23:59:59`);
    const hourMatch = cat.seasonDetails.match(/₪(\d+(?:\.\d+)?)/);
    const dayMatch = cat.seasonDetails.match(/₪(\d+(?:\.\d+)?)\s*ליום/);
    if (!hourMatch || !dayMatch) return null;
    return {
      start,
      end,
      hourRate: parseFloat(hourMatch[1]),
      dayRate: parseFloat(dayMatch[1]),
    };
  } catch {
    return null;
  }
}

function getSeasonSurcharge(tripStart, tripEnd, netH, seasons, mode) {
  // mode: "hourly" | "daily" | "weekly" | "monthly"
  if (!seasons || !seasons.length) return 0;
  let total = 0;
  for (const s of seasons) {
    const overlapStart = new Date(Math.max(tripStart, s.start));
    const overlapEnd = new Date(Math.min(tripEnd, s.end));
    if (overlapEnd <= overlapStart) continue;
    const overlapH = (overlapEnd - overlapStart) / 3600000;
    if (mode === "hourly") {
      total += overlapH * s.hourRate;
    } else {
      // daily/weekly/monthly: surcharge per day overlapping
      // Count calendar days that overlap
      const days = Math.ceil(overlapH / 24);
      total += days * s.dayRate;
    }
  }
  return total;
}

// ── Pricing data ──────────────────────────────────────────────────────────────
const SZ = { s: "small", f: "family", l: "large" };

const CC_CATS_DEFAULT = [
  {
    name: "Small E",
    sz: SZ.s,
    electric: false,
    hourly: 12.2,
    daily: 110,
    weekly: 620,
    monthly: 2450,
    tiers: [
      { to: 29, p: 2.3, mx: 57 },
      { to: 59, p: 1.9, mx: 90 },
      { to: 119, p: 1.5, mx: 132 },
      { to: 1e9, p: 1.1, mx: null },
    ],
    kd: 1.0,
    kw: 0.95,
    km2: 0.9,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Small G",
    sz: SZ.s,
    electric: false,
    hourly: 15.2,
    daily: 140,
    weekly: 810,
    monthly: 3450,
    tiers: [
      { to: 29, p: 2.3, mx: 57 },
      { to: 59, p: 1.9, mx: 90 },
      { to: 119, p: 1.5, mx: 132 },
      { to: 1e9, p: 1.1, mx: null },
    ],
    kd: 1.0,
    kw: 0.95,
    km2: 0.9,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Spacious",
    sz: SZ.f,
    electric: false,
    hourly: 17.2,
    daily: 160,
    weekly: 920,
    monthly: 3750,
    tiers: [
      { to: 29, p: 2.3, mx: 57 },
      { to: 59, p: 1.9, mx: 90 },
      { to: 119, p: 1.5, mx: 132 },
      { to: 1e9, p: 1.1, mx: null },
    ],
    kd: 1.0,
    kw: 0.95,
    km2: 0.9,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Family",
    sz: SZ.f,
    electric: false,
    hourly: 15.2,
    daily: 160,
    weekly: 915,
    monthly: 3550,
    tiers: [
      { to: 29, p: 2.3, mx: 57 },
      { to: 59, p: 1.9, mx: 90 },
      { to: 119, p: 1.5, mx: 132 },
      { to: 1e9, p: 1.1, mx: null },
    ],
    kd: 1.0,
    kw: 0.95,
    km2: 0.9,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Family+",
    sz: SZ.f,
    electric: false,
    hourly: 21,
    daily: 210,
    weekly: 1225,
    monthly: 4350,
    tiers: [
      { to: 29, p: 2.3, mx: 57 },
      { to: 59, p: 1.9, mx: 90 },
      { to: 119, p: 1.5, mx: 132 },
      { to: 1e9, p: 1.1, mx: null },
    ],
    kd: 1.1,
    kw: 1.0,
    km2: 0.9,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Electric",
    sz: SZ.f,
    electric: true,
    hourly: 21,
    daily: 210,
    weekly: 1220,
    monthly: 3950,
    tiers: [
      { to: 119, p: 0.8, mx: 72 },
      { to: 1e9, p: 0.6, mx: null },
    ],
    kd: 0.65,
    kw: 0.55,
    km2: 0.45,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Minivan P",
    sz: SZ.l,
    electric: false,
    hourly: 25,
    daily: 250,
    weekly: 1460,
    monthly: 4850,
    tiers: [
      { to: 59, p: 2.5, mx: 126 },
      { to: 119, p: 2.1, mx: 192 },
      { to: 1e9, p: 1.6, mx: null },
    ],
    kd: 1.6,
    kw: 1.3,
    km2: 1.0,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "Minivan S",
    sz: SZ.l,
    electric: false,
    hourly: 30,
    daily: 300,
    weekly: 1760,
    monthly: 5600,
    tiers: [
      { to: 59, p: 2.5, mx: 126 },
      { to: 119, p: 2.1, mx: 192 },
      { to: 1e9, p: 1.6, mx: null },
    ],
    kd: 1.6,
    kw: 1.45,
    km2: 1.3,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "VIP Minivan",
    sz: SZ.l,
    electric: false,
    hourly: 45,
    daily: 450,
    weekly: 2660,
    monthly: 6500,
    tiers: [
      { to: 59, p: 2.5, mx: 126 },
      { to: 119, p: 2.1, mx: 192 },
      { to: 1e9, p: 1.6, mx: null },
    ],
    kd: 1.75,
    kw: 1.55,
    km2: 1.35,
    seasons: FALLBACK_SEASONS,
  },
  {
    name: "9 seater",
    sz: SZ.l,
    electric: false,
    hourly: 45,
    daily: 450,
    weekly: 2660,
    monthly: 6700,
    tiers: [
      { to: 59, p: 2.5, mx: 126 },
      { to: 119, p: 2.1, mx: 192 },
      { to: 1e9, p: 1.6, mx: null },
    ],
    kd: 1.75,
    kw: 1.55,
    km2: 1.35,
    seasons: FALLBACK_SEASONS,
  },
];

function parseCityCar(apiData) {
  try {
    const cats = apiData.carCategoriesDetails;
    if (!cats) return null;
    const NAME_MAP = {
      "קטן E": "Small E",
      "קטן G": "Small G",
      "מרווח / משפחתי": "Spacious",
      משפחתי: "Family",
      "משפחתי פלוס": "Family+",
      "משפחתי פלוס חשמלי": "Electric",
      "מיני וואן P": "Minivan P",
      "מיני וואן S": "Minivan S",
      "מיני וואן יוקרתי": "VIP Minivan",
      "וואן 9 מקומות": "9 seater",
    };
    const SZ_MAP = {
      "Small E": SZ.s,
      "Small G": SZ.s,
      Spacious: SZ.f,
      Family: SZ.f,
      "Family+": SZ.f,
      Electric: SZ.f,
      "Minivan P": SZ.l,
      "Minivan S": SZ.l,
      "VIP Minivan": SZ.l,
      "9 seater": SZ.l,
    };
    const ELEC = new Set(["Electric"]);
    const result = [];
    cats.forEach((cat) => {
      const engName = NAME_MAP[cat.categoryName];
      if (!engName) return;
      const model = cat.models[0];
      if (!model) return;
      const byRoute = {};
      model.prices.forEach((p) => {
        byRoute[p.routeID] = p;
      });
      const h = byRoute[1],
        d = byRoute[3],
        w = byRoute[6],
        mo = byRoute[7];
      if (!h) return;
      const tiers = (h.kmPrices || [])
        .sort((a, b) => a.fromKM - b.fromKM)
        .map((t) => ({
          to: t.toKM >= 999000 ? 1e9 : t.toKM,
          p: t.price,
          mx: t.maxPrice,
        }));
      const season = parseSeasonFromAPI(model);
      result.push({
        name: engName,
        sz: SZ_MAP[engName] || SZ.f,
        electric: ELEC.has(engName),
        hourly: h.price,
        daily: d?.price || 0,
        weekly: w?.price || 0,
        monthly: mo?.price || 0,
        tiers,
        kd: d?.kmPrices?.[0]?.price || 1.0,
        kw: w?.kmPrices?.[0]?.price || 0.95,
        km2: mo?.kmPrices?.[0]?.price || 0.9,
        seasons: season ? [season] : FALLBACK_SEASONS,
      });
    });
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

const MC_CATS = [
  {
    name: "Small",
    sz: SZ.s,
    electric: false,
    hourly: 14.9,
    daily: 139,
    kh: 1.5,
    kd: 1.0,
  },
  {
    name: "Family",
    sz: SZ.f,
    electric: false,
    hourly: 22.9,
    daily: 209,
    kh: 1.8,
    kd: 1.4,
  },
  {
    name: "7 seats",
    sz: SZ.l,
    electric: false,
    hourly: 31.9,
    daily: 300,
    kh: 2.0,
    kd: 1.8,
  },
  {
    name: "VIP",
    sz: SZ.l,
    electric: false,
    hourly: 41.9,
    daily: 400,
    kh: 2.2,
    kd: 2.0,
  },
  {
    name: "Electric",
    sz: SZ.f,
    electric: true,
    hourly: 17.9,
    daily: 255,
    kh: 0.9,
    kd: 0.6,
  },
  {
    name: "Commercial",
    sz: SZ.f,
    electric: false,
    hourly: 27,
    daily: 250,
    kh: 1.8,
    kd: 1.4,
  },
];
const SS_CATS = [
  {
    name: "Mini",
    sz: SZ.s,
    electric: false,
    h3: 90.9,
    hx: 8,
    daily: 259,
    kfree: 50,
    kr: 1.7,
  },
  {
    name: "Family",
    sz: SZ.f,
    electric: false,
    h3: 90.9,
    hx: 10,
    daily: 299,
    kfree: 50,
    kr: 1.7,
  },
];

// ── Cost calculators ──────────────────────────────────────────────────────────
function ccKmCost(tiers, km) {
  const t = tiers.find((t) => km <= t.to);
  const raw = km * t.p;
  return {
    cost: t.mx ? Math.min(raw, t.mx) : raw,
    rate: t.p,
    capped: t.mx !== null && raw > t.mx,
  };
}

function fmtBookingEnd(tripStart, addHours) {
  const d = new Date(tripStart.getTime() + addHours * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function calcCC(cat, netH, km, tripStart, tripEnd) {
  const fullDays = Math.floor(netH / 24);
  const remH = netH - fullDays * 24;
  const weeks = Math.ceil(netH / 168);
  const months = Math.ceil(netH / 720);
  const { cost: kh, rate: khr, capped } = ccKmCost(cat.tiers, km);
  const kmH = capped ? `${km}km @ ₪${khr} (capped)` : `${km}km @ ₪${khr}`;

  const surch_h = getSeasonSurcharge(
    tripStart,
    tripEnd,
    netH,
    cat.seasons,
    "hourly",
  );
  const surch_d = getSeasonSurcharge(
    tripStart,
    tripEnd,
    netH,
    cat.seasons,
    "daily",
  );
  const surch_w = getSeasonSurcharge(
    tripStart,
    tripEnd,
    netH,
    cat.seasons,
    "weekly",
  );
  const surch_mo = getSeasonSurcharge(
    tripStart,
    tripEnd,
    netH,
    cat.seasons,
    "monthly",
  );

  const hourlyTimeCost = netH * cat.hourly;
  const dailyTimeCost = fullDays * cat.daily + remH * cat.hourly;
  const weeklyTimeCost = weeks * cat.weekly + 0; // weekly has no partial hours charge
  const monthlyTimeCost = months * cat.monthly;

  // Booking end times
  const endDaily = fmtBookingEnd(tripStart, fullDays * 24 + remH);
  const endWeekly = fmtBookingEnd(tripStart, weeks * 168);
  const endMonthly = fmtBookingEnd(tripStart, months * 720);

  const surchDetailH = surch_h > 0 ? ` + ₪${surch_h.toFixed(0)} season` : "";
  const surchDetailD = surch_d > 0 ? ` + ₪${surch_d.toFixed(0)} season` : "";
  const surchDetailW = surch_w > 0 ? ` + ₪${surch_w.toFixed(0)} season` : "";
  const surchDetailMo = surch_mo > 0 ? ` + ₪${surch_mo.toFixed(0)} season` : "";

  const remDetail = remH > 0 ? ` + ${remH.toFixed(1)}h @ ₪${cat.hourly}` : "";

  return [
    {
      label: "Hourly",
      cost: hourlyTimeCost + kh + surch_h,
      kmRate: khr,
      detail: `₪${cat.hourly}/h × ${netH.toFixed(1)}h${surchDetailH} · ${kmH}`,
    },
    {
      label: "Daily",
      cost: dailyTimeCost + km * cat.kd + surch_d,
      kmRate: cat.kd,
      detail: `₪${cat.daily}/day × ${fullDays}d${remDetail}${surchDetailD} · ${km}km @ ₪${cat.kd} → book until ${endDaily}`,
    },
    {
      label: "Weekly",
      cost: weeklyTimeCost + km * cat.kw + surch_w,
      kmRate: cat.kw,
      detail: `₪${cat.weekly}/wk × ${weeks}wk${surchDetailW} · ${km}km @ ₪${cat.kw} → book until ${endWeekly}`,
    },
    {
      label: "Monthly",
      cost: monthlyTimeCost + km * cat.km2 + surch_mo,
      kmRate: cat.km2,
      detail: `₪${cat.monthly}/mo × ${months}mo${surchDetailMo} · ${km}km @ ₪${cat.km2} → book until ${endMonthly}`,
    },
  ];
}

function calcMC(cat, netH, km, tripStart) {
  const fullDays = Math.floor(netH / 24);
  const remH = netH - fullDays * 24;
  const endDaily = fmtBookingEnd(tripStart, fullDays * 24 + remH);
  const remDetail = remH > 0 ? ` + ${remH.toFixed(1)}h @ ₪${cat.hourly}` : "";
  return [
    {
      label: "Hourly",
      cost: netH * cat.hourly + km * cat.kh,
      kmRate: cat.kh,
      detail: `₪${cat.hourly}/h × ${netH.toFixed(1)}h · ${km}km @ ₪${cat.kh}`,
    },
    {
      label: "Daily",
      cost: fullDays * cat.daily + remH * cat.hourly + km * cat.kd,
      kmRate: cat.kd,
      detail: `₪${cat.daily}/day × ${fullDays}d${remDetail} · ${km}km @ ₪${cat.kd} → book until ${endDaily}`,
    },
  ];
}

function calcSS(cat, grossH, km, tripStart) {
  const base = grossH <= 3 ? cat.h3 : cat.h3 + (grossH - 3) * cat.hx;
  const fullDays = Math.floor(grossH / 24);
  const remH = grossH - fullDays * 24;
  const xkm = Math.max(0, km - cat.kfree * Math.ceil(grossH / 24));
  const freeNote =
    xkm === 0
      ? `${km}km (all incl.)`
      : `${km}km (${cat.kfree * Math.ceil(grossH / 24)} incl. + ${xkm} @ ₪${cat.kr})`;
  const endDaily = fmtBookingEnd(tripStart, fullDays * 24 + remH);
  const remDetail = remH > 0 ? ` + ${remH.toFixed(1)}h @ ₪${cat.hx}` : "";
  return [
    {
      label: "Hourly",
      cost: base + km * cat.kr,
      kmRate: cat.kr,
      detail: `₪${cat.h3} (3h)${grossH > 3 ? ` + ₪${cat.hx}/h × ${(grossH - 3).toFixed(1)}h` : ""} · ${km}km @ ₪${cat.kr}`,
    },
    {
      label: "Daily",
      cost: fullDays * cat.daily + remH * cat.hx + xkm * cat.kr,
      kmRate: cat.kr,
      detail: `₪${cat.daily}/day × ${fullDays}d${remDetail} · ${freeNote} → book until ${endDaily}`,
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n) => "₪" + Math.round(n).toLocaleString();
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (d) => `${pad(d.getHours())}:00`;
function fmtHours(h) {
  if (!h || h < 0.05) return null;
  const hrs = Math.floor(h),
    mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg: "#F0F2F5",
  surface: "#FFFFFF",
  surfaceAlt: "#F7F8FA",
  border: "#DDE1E9",
  accent: "#1A56DB",
  accentBg: "#EEF3FF",
  accentText: "#1A3A8F",
  success: "#0E7C3A",
  successBg: "#E8F7EE",
  successBorder: "#86EFAC",
  text: "#111827",
  textSub: "#4B5563",
  textMuted: "#9CA3AF",
  citycar: "#1A56DB",
  mycar: "#166534",
  shlomo: "#92400E",
  citycarBg: "#EEF3FF",
  mycarBg: "#ECFDF5",
  shlomoBg: "#FFFBEB",
  teal: "#0E7490",
  tealBg: "#ECFEFF",
  warn: "#92400E",
  warnBg: "#FFF7ED",
  warnBorder: "#FED7AA",
  danger: "#991B1B",
  dangerBg: "#FEF2F2",
  dangerBorder: "#FECACA",
};
const CO = {
  CityCar: { color: T.citycar, bg: T.citycarBg },
  MyCar: { color: T.mycar, bg: T.mycarBg },
  "Shlomo Share": { color: T.shlomo, bg: T.shlomoBg },
};
const COMPANIES = ["CityCar", "MyCar", "Shlomo Share"];

// ── UI Components ─────────────────────────────────────────────────────────────
function Label({ children }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: T.textMuted,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
function Badge({ color, bg, border, children }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 4,
        background: bg,
        color,
        border: `1px solid ${border || bg}`,
      }}
    >
      {children}
    </span>
  );
}
function InputField({ label, type, value, onChange, min, readOnly }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: readOnly ? T.textMuted : T.textSub,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        min={min}
        readOnly={readOnly}
        onChange={(e) => !readOnly && onChange(e.target.value)}
        style={{
          padding: "9px 12px",
          fontSize: 15,
          fontWeight: 500,
          border: `1.5px solid ${T.border}`,
          borderRadius: 8,
          background: readOnly ? T.surfaceAlt : T.surface,
          color: readOnly ? T.textSub : T.text,
          outline: "none",
          width: "100%",
          fontFamily: "inherit",
          cursor: readOnly ? "not-allowed" : "auto",
        }}
      />
    </div>
  );
}
function Toggle({ label, checked, onChange, color }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1.5px solid ${checked ? color : T.border}`,
        background: checked ? `${color}18` : T.surfaceAlt,
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 600,
        color: checked ? color : T.textSub,
      }}
    >
      <div
        style={{
          width: 32,
          height: 18,
          borderRadius: 9,
          background: checked ? color : T.border,
          position: "relative",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
          }}
        />
      </div>
      {label}
    </button>
  );
}
function StatusDot({ status }) {
  const colors = {
    loading: "#F59E0B",
    ok: "#10B981",
    error: "#EF4444",
    fallback: "#F59E0B",
  };
  const labels = {
    loading: "Loading…",
    ok: "Live prices from CityCar",
    error: "Snapshot prices",
    fallback: "Approx. prices",
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: T.textMuted,
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: colors[status],
        }}
      />
      {labels[status]}
    </div>
  );
}
function StatusDot2({ status }) {
  const colors = {
    loading: "#F59E0B",
    ok: "#10B981",
    error: "#EF4444",
    fallback: "#F59E0B",
  };
  const labels = {
    loading: "Loading zmanim…",
    ok: "Exact zmanim",
    error: "Approx. zmanim",
    fallback: "Approx. zmanim",
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: T.textMuted,
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: colors[status],
        }}
      />
      {labels[status]}
    </div>
  );
}
function CompanyCard({ company, best, isOverall, isCheapestKm, blocked }) {
  if (blocked)
    return (
      <div
        style={{
          padding: "16px 18px",
          background: T.dangerBg,
          border: `1.5px solid ${T.dangerBorder}`,
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: T.danger,
            marginBottom: 6,
          }}
        >
          {company}
        </div>
        <div style={{ fontSize: 12, color: T.danger }}>
          ⚠ Booking not possible — start or end falls during Shabbat/Yom Tov
        </div>
      </div>
    );
  if (!best)
    return (
      <div
        style={{
          padding: "16px 18px",
          background: T.surfaceAlt,
          border: `1.5px solid ${T.border}`,
          borderRadius: 12,
          opacity: 0.5,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: T.textMuted,
            marginBottom: 6,
          }}
        >
          {company}
        </div>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          No match for selected filters
        </div>
      </div>
    );
  const c = CO[company];
  return (
    <div
      style={{
        padding: "16px 18px",
        background: T.surface,
        border: isOverall
          ? `2px solid ${T.success}`
          : `1.5px solid ${T.border}`,
        borderRadius: 12,
        borderLeft: `4px solid ${c.color}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: c.color,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {company}
        </span>
        {isOverall && (
          <Badge color={T.success} bg={T.successBg} border={T.successBorder}>
            Best overall
          </Badge>
        )}
        {isCheapestKm && (
          <Badge color={T.teal} bg={T.tealBg}>
            Cheapest /km
          </Badge>
        )}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          color: isOverall ? T.success : T.text,
          lineHeight: 1,
          marginBottom: 6,
        }}
      >
        {fmt(best.cost)}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: T.textSub,
          marginBottom: 3,
        }}
      >
        {best.car} · {best.label}
      </div>
      <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
        {best.detail}
      </div>
    </div>
  );
}
function RankRow({ opt, rank, isCheapestKm }) {
  const c = CO[opt.company];
  const isBest = rank === 1;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: isBest ? T.successBg : T.surface,
        border: isBest
          ? `1.5px solid ${T.successBorder}`
          : `1.5px solid ${T.border}`,
        borderRadius: 10,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          flexShrink: 0,
          background: isBest ? T.success : T.surfaceAlt,
          color: isBest ? "#fff" : T.textMuted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 800,
        }}
      >
        {rank}
      </div>
      <div
        style={{
          width: 3,
          height: 32,
          borderRadius: 2,
          background: c.color,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
            {opt.company} — {opt.car}
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.textMuted,
              background: T.surfaceAlt,
              padding: "1px 7px",
              borderRadius: 4,
              border: `1px solid ${T.border}`,
            }}
          >
            {opt.label}
          </span>
          {isCheapestKm && (
            <Badge color={T.teal} bg={T.tealBg}>
              Cheapest /km
            </Badge>
          )}
        </div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>
          {opt.detail}
        </div>
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: isBest ? T.success : T.text,
          flexShrink: 0,
        }}
      >
        {fmt(opt.cost)}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const now = new Date();
  // Round to current hour
  now.setMinutes(0, 0, 0);
  const later = new Date(now.getTime() + 2 * 3600000);

  const [sD, setSd] = useState(fmtDate(now));
  const [sT, setSt] = useState(fmtTime(now));
  const [eD, setEd] = useState(fmtDate(later));
  const [eT, setEt] = useState(fmtTime(later));
  const [km, setKm] = useState(60);
  const [ccIdx, setCcIdx] = useState(null);
  const [activeCompanies, setActiveCompanies] = useState(new Set(COMPANIES));
  const [hideElectric, setHideElectric] = useState(false);

  const [ccCats, setCcCats] = useState(CC_CATS_DEFAULT);
  const [ccStatus, setCcStatus] = useState("loading");

  const [restWindows, setRestWindows] = useState([]);
  const [zmanimStatus, setZmanimStatus] = useState("loading");
  const [zmanimLoading, setZmanimLoading] = useState(false);

  // Round start time to hour on change
  function handleStartTime(val) {
    setSt(val);
    // Sync end minutes to match start minutes
    const startMins = val.slice(3, 5);
    const endHour = eT.slice(0, 3);
    setEt(endHour + startMins);
  }

  function handleEndTime(val) {
    // Lock minutes to match start minutes
    const startMins = sT.slice(3, 5);
    setEt(val.slice(0, 3) + startMins);
  }

  const tripStart = useMemo(() => new Date(`${sD}T${sT}`), [sD, sT]);
  const tripEnd = useMemo(() => new Date(`${eD}T${eT}`), [eD, eT]);
  const valid = useMemo(
    () => !isNaN(tripStart) && !isNaN(tripEnd) && tripEnd > tripStart,
    [tripStart, tripEnd],
  );
  const grossH = useMemo(
    () => (valid ? (tripEnd - tripStart) / 3600000 : 0),
    [tripStart, tripEnd, valid],
  );

  // Flat 24h per rest window for CC/MC
  const ccExclH = useMemo(
    () => getCCExcludedHours(tripStart, tripEnd, restWindows),
    [tripStart, tripEnd, restWindows],
  );
  const netH = useMemo(
    () => Math.max(0.1, grossH - ccExclH),
    [grossH, ccExclH],
  );

  // Warning: start or end in rest window
  const startBlocked = useMemo(
    () => valid && isInRestWindow(tripStart, restWindows),
    [tripStart, restWindows, valid],
  );
  const endBlocked = useMemo(
    () => valid && isInRestWindow(tripEnd, restWindows),
    [tripEnd, restWindows, valid],
  );
  const ccmcBlocked = startBlocked || endBlocked;

  useEffect(() => {
    fetch("/api/citycar")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        const parsed = parseCityCar(data);
        if (parsed) {
          setCcCats(parsed);
          setCcStatus("ok");
        } else setCcStatus("error");
      })
      .catch(() => setCcStatus("error"));
  }, []);

  useEffect(() => {
    if (!valid) return;
    setZmanimLoading(true);
    computeRestWindows(tripStart, tripEnd).then(
      ({ windows, usingFallback }) => {
        setRestWindows(windows);
        setZmanimStatus(usingFallback ? "fallback" : "ok");
        setZmanimLoading(false);
      },
    );
  }, [sD, sT, eD, eT]);

  const filterSz = ccIdx !== null ? ccCats[ccIdx]?.sz : null;

  function toggleCompany(co) {
    setActiveCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(co)) {
        if (next.size > 1) next.delete(co);
      } else next.add(co);
      return next;
    });
  }

  const allOpts = useMemo(() => {
    if (!valid) return [];
    const out = [];
    if (activeCompanies.has("CityCar") && !ccmcBlocked) {
      ccCats.forEach((c, i) => {
        if (ccIdx !== null && i !== ccIdx) return;
        if (hideElectric && c.electric) return;
        calcCC(c, netH, km, tripStart, tripEnd).forEach((o) =>
          out.push({ ...o, company: "CityCar", car: c.name, sz: c.sz }),
        );
      });
    }
    if (activeCompanies.has("MyCar") && !ccmcBlocked) {
      MC_CATS.forEach((c) => {
        if (filterSz && c.sz !== filterSz) return;
        if (hideElectric && c.electric) return;
        calcMC(c, netH, km, tripStart).forEach((o) =>
          out.push({ ...o, company: "MyCar", car: c.name, sz: c.sz }),
        );
      });
    }
    if (activeCompanies.has("Shlomo Share")) {
      SS_CATS.forEach((c) => {
        if (filterSz && c.sz !== filterSz) return;
        calcSS(c, grossH, km, tripStart).forEach((o) =>
          out.push({ ...o, company: "Shlomo Share", car: c.name, sz: c.sz }),
        );
      });
    }
    return out.sort((a, b) => a.cost - b.cost);
  }, [
    valid,
    netH,
    grossH,
    km,
    ccIdx,
    filterSz,
    activeCompanies,
    hideElectric,
    ccCats,
    ccmcBlocked,
    tripStart,
    tripEnd,
  ]);

  const top5 = allOpts.slice(0, 5);
  const overallBestCost = top5[0]?.cost;
  const bestCo = useMemo(() => {
    const m = {};
    allOpts.forEach((o) => {
      if (!m[o.company] || o.cost < m[o.company].cost) m[o.company] = o;
    });
    return m;
  }, [allOpts]);
  const cheapestKmRate = useMemo(() => {
    if (!allOpts.length || km === 0) return null;
    return Math.min(...allOpts.map((o) => o.kmRate).filter((r) => r != null));
  }, [allOpts, km]);

  const exclStr = fmtHours(ccExclH);

  const pillStyle = (active) => ({
    padding: "6px 13px",
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    borderRadius: 7,
    cursor: "pointer",
    border: `1.5px solid ${active ? T.accent : T.border}`,
    background: active ? T.accentBg : T.surfaceAlt,
    color: active ? T.accentText : T.textSub,
    fontFamily: "inherit",
  });

  const visibleCompanies = COMPANIES.filter((co) => activeCompanies.has(co));

  return (
    <div
      style={{
        background: T.bg,
        minHeight: "100vh",
        padding: "20px 16px",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        color: T.text,
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: T.text,
              margin: "0 0 6px",
              letterSpacing: "-0.02em",
            }}
          >
            Car Rental Calculator
          </h1>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {COMPANIES.map((co) => (
              <span
                key={co}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: CO[co].color,
                  background: CO[co].bg,
                  padding: "2px 8px",
                  borderRadius: 4,
                }}
              >
                {co}
              </span>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
              <StatusDot
                status={
                  ccStatus === "loading"
                    ? "loading"
                    : ccStatus === "ok"
                      ? "ok"
                      : "error"
                }
              />
              <StatusDot2 status={zmanimLoading ? "loading" : zmanimStatus} />
            </div>
          </div>
        </div>

        {/* Input card */}
        <div
          style={{
            background: T.surface,
            border: `1.5px solid ${T.border}`,
            borderRadius: 14,
            padding: "20px 20px 16px",
            marginBottom: 14,
          }}
        >
          <Label>Trip window</Label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <InputField
              label="Start date"
              type="date"
              value={sD}
              onChange={setSd}
            />
            <InputField
              label="Start time"
              type="time"
              value={sT}
              onChange={handleStartTime}
            />
            <InputField
              label="End date"
              type="date"
              value={eD}
              onChange={setEd}
            />
            <InputField
              label="End time"
              type="time"
              value={eT}
              onChange={handleEndTime}
            />
            <InputField
              label="Kilometers"
              type="number"
              value={km}
              onChange={(v) => setKm(Number(v))}
              min={0}
            />
          </div>

          {/* Shabbat/YT warning */}
          {valid && ccmcBlocked && (
            <div
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                background: T.dangerBg,
                border: `1px solid ${T.dangerBorder}`,
                color: T.danger,
                marginBottom: 10,
              }}
            >
              <strong>
                ⚠{" "}
                {startBlocked && endBlocked
                  ? "Start and end times fall"
                  : startBlocked
                    ? "Start time falls"
                    : "End time falls"}{" "}
                during Shabbat or Yom Tov
              </strong>{" "}
              — CityCar and MyCar bookings are not possible. Shlomo Share
              results still shown below.
            </div>
          )}

          {/* Window info */}
          {valid && (
            <div
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                background: exclStr ? T.warnBg : T.accentBg,
                border: `1px solid ${exclStr ? T.warnBorder : "#BFDBFE"}`,
                color: exclStr ? T.warn : T.accentText,
              }}
            >
              {exclStr ? (
                <>
                  <strong>{exclStr}</strong> Shabbat/Yom Tov excluded (flat 24h
                  each){zmanimLoading ? " — calculating…" : ""} — CityCar &amp;
                  MyCar: <strong>{fmtHours(netH) || "< 1h"} net</strong> ·
                  Shlomo Share: <strong>{fmtHours(grossH)} gross</strong>
                </>
              ) : (
                <>
                  Window: <strong>{fmtHours(grossH)}</strong>
                  {zmanimLoading ? " — checking zmanim…" : ""} — no Shabbat or
                  Yom Tov in this window
                </>
              )}
            </div>
          )}

          {/* Shabbat window debug */}
          {/* {valid && restWindows.length > 0 && (
            <details style={{ marginTop:8 }}>
              <summary style={{ fontSize:11, color:T.accentText, cursor:"pointer" }}>Show Shabbat/Yom Tov windows</summary>
              <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:4 }}>
                {restWindows.map((w,i) => (
                  <div key={i} style={{ fontSize:11, color:T.textSub, padding:"4px 8px", background:T.surfaceAlt, borderRadius:6 }}>
                    {w.start.toLocaleString("he-IL", { weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}
                    {" → "}
                    {w.end.toLocaleString("he-IL", { weekday:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}
                  </div>
                ))}
              </div>
            </details>
          )} */}
        </div>

        {/* Filters */}
        <div
          style={{
            background: T.surface,
            border: `1.5px solid ${T.border}`,
            borderRadius: 14,
            padding: "16px 20px",
            marginBottom: 20,
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <Label>
              Car size
              {ccIdx !== null && (
                <span
                  style={{
                    color: T.accent,
                    textTransform: "none",
                    fontWeight: 400,
                    fontSize: 10,
                  }}
                >
                  {" "}
                  — also filters MyCar &amp; Shlomo to comparable size
                </span>
              )}
            </Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[
                { name: "All sizes", idx: null },
                ...ccCats.map((c, i) => ({ name: c.name, idx: i })),
              ].map(({ name, idx }) => (
                <button
                  key={name}
                  style={pillStyle(ccIdx === idx)}
                  onClick={() => setCcIdx(idx === ccIdx ? null : idx)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1, minWidth: 200 }}>
              <Label>Companies</Label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {COMPANIES.map((co) => {
                  const active = activeCompanies.has(co);
                  const c = CO[co];
                  return (
                    <button
                      key={co}
                      onClick={() => toggleCompany(co)}
                      style={{
                        padding: "6px 13px",
                        fontSize: 12,
                        fontWeight: active ? 700 : 500,
                        borderRadius: 7,
                        cursor: "pointer",
                        border: `1.5px solid ${active ? c.color : T.border}`,
                        background: active ? c.bg : T.surfaceAlt,
                        color: active ? c.color : T.textSub,
                        fontFamily: "inherit",
                      }}
                    >
                      {co}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label>Options</Label>
              <Toggle
                label="Hide electric"
                checked={hideElectric}
                onChange={setHideElectric}
                color="#DC2626"
              />
            </div>
          </div>
        </div>

        {/* Results */}
        {valid && (top5.length > 0 || ccmcBlocked) && (
          <>
            <Label>Best per company</Label>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                gap: 12,
                marginBottom: 20,
              }}
            >
              {visibleCompanies.map((co) => (
                <CompanyCard
                  key={co}
                  company={co}
                  best={bestCo[co]}
                  blocked={ccmcBlocked && (co === "CityCar" || co === "MyCar")}
                  isOverall={
                    !ccmcBlocked &&
                    bestCo[co] &&
                    Math.round(bestCo[co].cost) === Math.round(overallBestCost)
                  }
                  isCheapestKm={
                    cheapestKmRate !== null &&
                    bestCo[co] &&
                    bestCo[co].kmRate === cheapestKmRate
                  }
                />
              ))}
            </div>

            {top5.length > 0 && (
              <>
                <Label>
                  Top 5{ccIdx !== null ? ` — ${ccCats[ccIdx]?.name} size` : ""}
                </Label>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginBottom: 20,
                  }}
                >
                  {top5.map((o, i) => (
                    <RankRow
                      key={i}
                      opt={o}
                      rank={i + 1}
                      isCheapestKm={
                        cheapestKmRate !== null && o.kmRate === cheapestKmRate
                      }
                    />
                  ))}
                </div>
              </>
            )}

            <div
              style={{
                fontSize: 11,
                color: T.textMuted,
                lineHeight: 1.8,
                padding: "10px 14px",
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: 10,
              }}
            >
              <strong>CityCar</strong>:{" "}
              {ccStatus === "ok" ? "live" : "snapshot 22 Mar 2026"} ·{" "}
              <strong>MyCar</strong>: mycar-israel.com 22 Mar 2026 ·{" "}
              <strong>Shlomo Share</strong>: app screenshot 22 Mar 2026
              <br />
              Zmanim:{" "}
              {zmanimStatus === "ok" ? "Hebcal API (exact)" : "approximated"} ·
              CityCar/MyCar deduct flat 24h per Shabbat/YT · Chol HaMoed =
              regular days
            </div>
          </>
        )}

        {valid && top5.length === 0 && !ccmcBlocked && (
          <div
            style={{
              padding: "20px",
              textAlign: "center",
              color: T.textMuted,
              background: T.surface,
              border: `1.5px solid ${T.border}`,
              borderRadius: 12,
            }}
          >
            No results match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}
