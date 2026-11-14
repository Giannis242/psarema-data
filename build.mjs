// Psarema daily ocean file: the Copernicus Marine Mediterranean model's temperature at depth and mixed-layer depth around Cyprus, for
// the app's 10 timeline days (2 back, today, 7 ahead). Read from the public ARCO Zarr stores (no account), cut to the Cyprus box and
// packed into one small JSON. Runs three times a day in the psarema-data repo (GitHub Actions, ocean.yml); js/sources.js loadOcean() reads it.
//   node build.mjs [outDir]          -> outDir/ocean.json (~0.5 MB; GitHub Pages serves it gzipped, ~0.2 MB)
//                                    -> outDir/surface.json (round 10, ~0.5 MB): the satellite sea surface cut to the same box, so the phone
//                                       loads one small file instead of ~5 MB of Zarr chunks: sea temperature (L4, 0.01°), its anomaly
//                                       against 1991-2020 (1/16°) and chlorophyll (L4 gap-free, 1 km).
//                                       js/sources.js loadSurface() reads it; without it (or older than 3 days) the app reads the stores itself.
//                                    -> outDir/currents.json (round 15, ~85 kB): the same model's daily-mean surface current at 1/24°, 10 days.
//                                    -> outDir/fronts.json (round 15, ~0.17 MB, mostly zeros: ~11 kB gzipped): front lines detected on the
//                                       satellite sea temperature (1 km) and chlorophyll (1 km). Neither is on the first map's path:
//                                       js/sources.js loadCurrents() / loadFronts() read them when something asks.
// Data: E.U. Copernicus Marine Service, MEDSEA_ANALYSISFORECAST_PHY_006_013 (4.2 km, daily means); Copernicus Marine licence (attribution).
import { mkdirSync, writeFileSync } from 'node:fs';

/* ---------- Which stores: the newest released dataset version in the Copernicus STAC catalogue ---------- */
// Copernicus re-versions its datasets about once a year (…_202511 → …_202611, and 'tem' became 'temp') and retires the old ones: every
// store this job read on 2026-11-14 retires on 2027-01-12. So each run asks the open STAC catalogue for the versions it lists, newest
// released first, falls back to the next one when a store fails, and to the store known to work when the catalogue is down.
const STAC = 'https://stac.marine.copernicus.eu/metadata/', CM = 'https://s3.waw3-1.cloudferro.com/';
async function stores(product, re, kind, known) { // -> [store URL], newest version first
  const urls = [];
  try {
    const p = await fetch(`${STAC}${product}/product.stac.json`).then(r => r.json());
    const ids = p.links.filter(l => l.rel === 'item').map(l => l.href.split('/')[0]).filter(id => re.test(id)).sort((a, b) => b.slice(-6).localeCompare(a.slice(-6)));
    for (const id of ids) {
      const d = await fetch(`${STAC}${product}/${id}/dataset.stac.json`).then(r => r.json()), pr = d.properties || {};
      if (!pr.admp_in_preparation && !(Date.parse(pr.admp_released_date) > Date.now()) && d.assets?.[kind]?.href) urls.push(d.assets[kind].href);
    }
  } catch (e) { console.warn(`${product}: STAC catalogue unavailable (${e.message}), using the known store`); }
  return [...new Set([...urls, CM + known])];
}
async function first(urls, f) { // f(url) on each store in turn until one works
  for (const [k, u] of urls.entries()) {
    try { return await f(u); } catch (e) { if (k === urls.length - 1) throw e; console.warn(`${u.split('/').at(-2)}: ${e.message}; trying the next version`); }
  }
}
const MED = 'MEDSEA_ANALYSISFORECAST_PHY_006_013', medStores = (v, known) => stores(MED, new RegExp(`^cmems_mod_med_phy-${v}_anfc_4\\.2km_P1D-m_\\d{6}$`), 'geoChunked', `mdl-arco-geo-033/arco/${MED}/${known}/geoChunked.zarr`);
const BOX = [34.15, 31.8, 35.95, 34.95]; // S, W, N, E: the app's grid (core.js GRID_BOUNDS) plus a margin
const DEPTHS = [1, 5, 10, 20, 30, 40, 50, 60, 75, 100, 125, 150, 200]; // m; the app interpolates between them, deeper seabeds take 200 m
const DAYS = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7], DAY = 864e5;

/* ---------- Zarr blosc/lz4 chunks (the same decoder as js/sources.js) ---------- */
function lz4(src, dst, d, end) {
  let s = 0;
  while (s < src.length) {
    const tok = src[s++]; let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) dst[d++] = src[s++];
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = tok & 15; if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    for (ml += 4; ml > 0; ml--, d++) dst[d] = dst[d - off];
  }
  if (d !== end) throw new Error('lz4 size mismatch');
}
function blosc(buf) {
  const u = new Uint8Array(buf), dv = new DataView(buf), flags = u[2], ts = u[3], nbytes = dv.getUint32(4, true), bsize = dv.getUint32(8, true);
  const out = new Uint8Array(nbytes);
  if (flags & 2) { out.set(u.subarray(16, 16 + nbytes)); return out; }
  if ((flags >> 5) !== 1 || flags & 4) throw new Error('unsupported blosc codec');
  const tmp = new Uint8Array(bsize);
  for (let b = 0; b * bsize < nbytes; b++) {
    const bs = Math.min(bsize, nbytes - b * bsize);
    let p = dv.getInt32(16 + 4 * b, true);
    const ns = !(flags & 0x10) && ts <= 16 && bsize / ts >= 128 && bs === bsize ? ts : 1, neb = bs / ns;
    const target = flags & 1 && ts > 1 ? tmp : out, base = target === tmp ? 0 : b * bsize;
    for (let k = 0; k < ns; k++) {
      const cb = dv.getInt32(p, true); p += 4;
      if (cb === neb) target.set(u.subarray(p, p + cb), base + k * neb); else lz4(u.subarray(p, p + cb), target, base + k * neb, base + (k + 1) * neb);
      p += cb;
    }
    if (target === tmp) {
      const n = Math.floor(bs / ts), o = b * bsize;
      for (let i = 0; i < n; i++) for (let j = 0; j < ts; j++) out[o + i * ts + j] = tmp[j * n + i];
      for (let i = n * ts; i < bs; i++) out[o + i] = tmp[i];
    }
  }
  return out;
}
const DTYPE = { '<f4': Float32Array, '<f8': Float64Array, '<i2': Int16Array, '<i4': Int32Array, '<i8': BigInt64Array };

/* ---------- Fronts on a map: thin lines where the field changes fast ---------- */
// 1. Belkin & O'Reilly (2009): a 3×3 median only on spikes (a pixel above or below the four others on a 5-pixel line through it), so noise
//    goes and steps stay. 2. Sobel gradient per km; a pixel with land in its 3×3 window gets none (a coast is not a front). 3. Canny (1986):
//    keep the ridge (not below either neighbour across the front), then hysteresis: lines that reach `hi` somewhere, followed down to hi/2;
//    lines under 5 pixels go. `clear`: pixels of sea needed all round (the chlorophyll's coastal band is a gradient, not a front).
// Thresholds, °C/km and log10(mg/m³)/km on the 1 km maps: the top ~6% and ~5% of gradients around Cyprus in November 2026.
const SST_FRONT = .08, CHL_FRONT = .025;
function fronts({ g, ny, nx, lat0, dLat, dLon }, hi, clear = 0) { // -> Float32Array: gradient on front pixels, 0 on other sea, NaN on land
  const f = Float32Array.from(g), N2 = ny * nx;
  for (let y = 2; y < ny - 2; y++) for (let x = 2; x < nx - 2; x++) {
    const j = y * nx + x, c = g[j]; if (Number.isNaN(c)) continue;
    const spike = [1, nx, nx + 1, nx - 1].some(s => { const w = [g[j - 2 * s], g[j - s], g[j + s], g[j + 2 * s]]; return !w.some(Number.isNaN) && (c > Math.max(...w) || c < Math.min(...w)); });
    if (!spike) continue;
    const w = []; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const v = g[j + a * nx + b]; if (!Number.isNaN(v)) w.push(v); }
    f[j] = w.sort((p, q) => p - q)[w.length >> 1];
  }
  const m = new Float32Array(N2), dir = new Uint8Array(N2), ky = Math.abs(dLat) * 110.57;
  for (let y = 1; y < ny - 1; y++) {
    const kx = Math.abs(dLon) * 111.32 * Math.cos((lat0 + y * dLat) * Math.PI / 180);
    for (let x = 1; x < nx - 1; x++) {
      const j = y * nx + x, a = (p, q) => f[j + p * nx + q];
      const gx = (a(-1, 1) + 2 * a(0, 1) + a(1, 1) - a(-1, -1) - 2 * a(0, -1) - a(1, -1)) / (8 * kx), gy = (a(1, -1) + 2 * a(1, 0) + a(1, 1) - a(-1, -1) - 2 * a(-1, 0) - a(-1, 1)) / (8 * ky);
      const v = Math.hypot(gx, gy); if (Number.isNaN(v)) continue;
      m[j] = v; dir[j] = Math.round(Math.atan2(gy * ky, gx * kx) * 4 / Math.PI + 8) % 4; // across the front, in pixels: 0 x, 1 x+y, 2 y, 3 y−x
    }
  }
  const STEP = [1, nx + 1, nx, nx - 1], near = [1, -1, nx, -nx, nx + 1, nx - 1, 1 - nx, -1 - nx], keep = new Uint8Array(N2);
  const roomy = j => { const y = j / nx | 0, x = j % nx; for (let a = -clear; a <= clear; a++) for (let b = -clear; b <= clear; b++) if (Number.isNaN(g[(y + a) * nx + x + b] ?? NaN)) return false; return true; };
  for (let j = 0; j < N2; j++) { const v = m[j], s = STEP[dir[j]]; if (v >= hi / 2 && v >= m[j + s] && v >= m[j - s] && (!clear || roomy(j))) keep[j] = v >= hi ? 2 : 1; }
  const out = Float32Array.from(g, v => Number.isNaN(v) ? NaN : 0);
  for (let j0 = 0; j0 < N2; j0++) {
    if (keep[j0] !== 2) continue;
    const line = [j0]; keep[j0] = 0;
    for (let k = 0; k < line.length; k++) for (const s of near) { const j = line[k] + s; if (keep[j]) { keep[j] = 0; line.push(j); } }
    if (line.length >= 5) for (const j of line) out[j] = m[j];
  }
  return out;
}
{ // self-check on made-up maps: a straight front is found where it is and nowhere else; a flat sea with a speck of noise has none
  const ny = 40, nx = 60, box = { ny, nx, lat0: 34, dLat: 1 / 120, dLon: 1 / 120 };
  const step = fronts({ ...box, g: Float32Array.from({ length: ny * nx }, (_, j) => j % nx < 3 ? NaN : 20 + Math.tanh((j % nx - 30) / 2)) }, SST_FRONT);
  const at = [...step.keys()].filter(j => step[j] > 0), flat = Float32Array.from({ length: ny * nx }, () => 20); flat[20 * nx + 20] = 21;
  if (!(at.length >= ny - 4 && at.every(j => j % nx === 30) && fronts({ ...box, g: flat }, SST_FRONT).every(v => v === 0))) throw new Error('front detector self-check failed');
}

/* ---------- One store: grids over BOX for a day offset (from today's step) and an elevation index ---------- */
async function open(url) {
  const get = async p => {
    for (let k = 0; ; k++) {
      const r = await fetch(`${url}/${p}`);
      if (r.ok) return r.arrayBuffer();
      if (r.status === 403 || r.status === 404 || k === 3) throw Object.assign(new Error(`${p} ${r.status}`), { status: r.status });
      await new Promise(f => setTimeout(f, 2000 * (k + 1)));
    }
  };
  const meta = JSON.parse(new TextDecoder().decode(await get('.zmetadata'))).metadata;
  const dec = (name, buf) => new DTYPE[meta[name + '/.zarray'].dtype](blosc(buf).buffer);
  const axis = async name => { const a = meta[name + '/.zarray'], out = []; for (let c = 0; c * a.chunks[0] < a.shape[0]; c++) out.push(...Array.from(dec(name, await get(`${name}/${c}`)), Number)); return out.slice(0, a.shape[0]); };
  const [lat, lon] = await Promise.all([axis('latitude'), axis('longitude')]);
  const span = (ax, a, b) => [ax.findIndex(x => x >= a), ax.findLastIndex(x => x <= b)];
  const [y0, y1] = span(lat, BOX[0], BOX[2]), [x0, x1] = span(lon, BOX[1], BOX[3]), ny = y1 - y0 + 1, nx = x1 - x0 + 1;
  const tc = meta['time/.zarray'].chunks[0], last = meta['time/.zarray'].shape[0] - 1, i0 = Math.floor(last / tc) * tc, tv = dec('time', await get(`time/${i0 / tc}`));
  const [, unit, since] = meta['time/.zattrs'].units.match(/^(\w+) since (.*)$/), s0 = since.trim().replace(' ', 'T');
  const epoch = Date.parse(/T/.test(s0) ? (/Z|[+-]\d\d:?\d\d$/.test(s0) ? s0 : s0 + 'Z') : s0 + 'T00:00:00Z');
  const mult = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: DAY }[unit], lastDate = epoch + Number(tv[last - i0]) * mult;
  const today = last - Math.ceil((lastDate - Date.now()) / DAY); // daily steps: today's step (the stores run ~9 days ahead)
  const memo = {};
  const grid = async (v, t, z) => { // Float32Array(ny*nx), NaN on land and below the seabed
    const A = meta[v + '/.zarray'], at = meta[v + '/.zattrs'], ch = A.chunks, four = A.shape.length === 4, [ct, cy, cx] = four ? [ch[0], ch[2], ch[3]] : ch;
    const fill = A.fill_value == null ? NaN : Math.fround(Number(A.fill_value)), sf = at.scale_factor ?? 1, off = at.add_offset ?? 0;
    const g = new Float32Array(ny * nx).fill(NaN);
    for (let gy = Math.floor(y0 / cy); gy <= Math.floor(y1 / cy); gy++)
      for (let gx = Math.floor(x0 / cx); gx <= Math.floor(x1 / cx); gx++) {
        const key = `${v}/${Math.floor(t / ct)}.${four ? Math.floor(z / ch[1]) + '.' : ''}${gy}.${gx}`;
        const raw = await (memo[key] ||= get(key).then(b => dec(v, b)));
        const tOff = ((t % ct) * (four ? ch[1] : 1) + (four ? z % ch[1] : 0)) * cy * cx;
        for (let y = Math.max(y0, gy * cy); y <= Math.min(y1, gy * cy + cy - 1); y++)
          for (let x = Math.max(x0, gx * cx); x <= Math.min(x1, gx * cx + cx - 1); x++) {
            const r = raw[tOff + (y - gy * cy) * cx + (x - gx * cx)];
            if (r !== fill && !Number.isNaN(r) && Math.abs(r) < 1e19) g[(y - y0) * nx + (x - x0)] = r * sf + off;
          }
      }
    return g;
  };
  const date = t => new Date(lastDate - (last - t) * DAY).toISOString().slice(0, 10);
  return { url, meta, lat, lon, y0, x0, ny, nx, today, last, grid, date, get, dec };
}

const forecast = async url => { const s = await open(url); if (s.today + DAYS.at(-1) > s.last) throw new Error(`forecast ends ${s.date(s.last)}`); return s; };
const [tem, mld] = await Promise.all([
  medStores('temp?', 'cmems_mod_med_phy-tem_anfc_4.2km_P1D-m_202511').then(u => first(u, forecast)),
  medStores('mld', 'cmems_mod_med_phy-mld_anfc_4.2km_P1D-m_202511').then(u => first(u, forecast))]);
const el = Array.from(tem.dec('elevation', await tem.get('elevation/0')), Number); // negative metres, deepest first
const lvl = DEPTHS.map(d => el.reduce((b, z, k) => Math.abs(-z - d) < Math.abs(-el[b] - d) ? k : b, 0));
const offs = DAYS.filter(o => tem.today + o <= tem.last && mld.today + o <= mld.last), days = offs.map(o => tem.today + o);
const { ny, nx } = tem, L = DEPTHS.length, D = days.length;

const surf = await tem.grid('thetao', days[0], lvl[0]);
const cells = []; for (let j = 0; j < ny * nx; j++) if (!Number.isNaN(surf[j])) cells.push(j); // sea cells of the model grid
const T = new Uint8Array(D * cells.length * L).fill(255), M = new Uint8Array(D * cells.length).fill(255);
for (let d = 0; d < D; d++) {
  for (let k = 0; k < L; k++) {
    const g = await tem.grid('thetao', days[d], lvl[k]);
    cells.forEach((j, c) => { const v = g[j]; if (!Number.isNaN(v)) T[(d * cells.length + c) * L + k] = Math.max(0, Math.min(254, Math.round((v - 10) * 10))); });
  }
  const m = await mld.grid('mlotst', mld.today + offs[d], 0);
  cells.forEach((j, c) => { if (!Number.isNaN(m[j])) M[d * cells.length + c] = Math.min(254, Math.round(m[j])); });
}
const b64 = u8 => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
const out = {
  made: new Date().toISOString(), source: 'E.U. Copernicus Marine Service Information, MEDSEA_ANALYSISFORECAST_PHY_006_013',
  dates: days.map(tem.date), lat0: tem.lat[tem.y0], dLat: tem.lat[tem.y0 + 1] - tem.lat[tem.y0], lon0: tem.lon[tem.x0], dLon: tem.lon[tem.x0 + 1] - tem.lon[tem.x0], ny, nx,
  depths: DEPTHS, levels: lvl.map(k => +(-el[k]).toFixed(1)),
  cells: b64(Uint16Array.from(cells)), // grid index y*nx + x of each sea cell
  t: b64(T),   // [day][cell][depth]: (°C − 10) × 10, 255 = below the seabed / none
  mld: b64(M), // [day][cell]: mixed-layer depth in m, 255 = none
};
// Self-check before publishing: a full file, and a shelf-and-deep-sea temperature range that makes sense for the Levantine Sea.
const n = cells.length, t0 = Array.from(T.subarray(0, n * L)).filter(v => v < 255).map(v => 10 + v / 10);
if (!(D === DAYS.length && n > 1500 && Math.min(...t0) > 12 && Math.max(...t0) < 33)) throw new Error(`ocean.json looks wrong: ${D} days, ${n} cells`);
const dir = process.argv[2] || '.';
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/ocean.json`, JSON.stringify(out));
console.log(`ocean.json: ${out.dates[0]}..${out.dates.at(-1)}, ${n} cells × ${L} depths, ${(JSON.stringify(out).length / 1024).toFixed(0)} kB`);

/* ---------- currents.json: the model's daily-mean current at its top level (1 m), 1/24°, the same days (a failure leaves the others published) ---------- */
// Daily means, so tides (~0.3 m range, a few cm/s off Cyprus) and inertial swings average out. js/sources.js loadCurrents() reads it.
const q = (g, T, f, none, lo, hi) => { const a = new T(g.length); for (let i = 0; i < g.length; i++) a[i] = Number.isNaN(g[i]) ? none : Math.max(lo, Math.min(hi, Math.round(f(g[i])))); return a; };
try {
  const cur = await medStores('cur', 'cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511').then(u => first(u, forecast));
  const ce = Array.from(cur.dec('elevation', await cur.get('elevation/0')), Number), top = ce.reduce((b, z, k) => Math.abs(z) < Math.abs(ce[b]) ? k : b, 0);
  const n2 = cur.ny * cur.nx, U = new Int8Array(D * n2), V = new Int8Array(D * n2), sp = [];
  for (let d = 0; d < D; d++) {
    const [u, v] = await Promise.all(['uo', 'vo'].map(k => cur.grid(k, cur.today + offs[d], top)));
    U.set(q(u, Int8Array, x => x * 100, -128, -127, 127), d * n2); V.set(q(v, Int8Array, x => x * 100, -128, -127, 127), d * n2);
    for (let j = 0; j < n2; j++) if (!Number.isNaN(u[j])) sp.push(Math.hypot(u[j], v[j]));
  }
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length, top99 = sp.sort((a, b) => a - b)[Math.floor(sp.length * .99)];
  if (!(sp.length > 1500 * D && mean > .02 && mean < .6 && top99 < 2)) throw new Error(`looks wrong: ${sp.length} cell-days, mean ${mean} m/s`);
  const cj = { made: new Date().toISOString(), source: 'E.U. Copernicus Marine Service Information, MEDSEA_ANALYSISFORECAST_PHY_006_013 (' + cur.url.split('/').at(-2) + ')',
    dates: offs.map(o => cur.date(cur.today + o)), level: +Math.abs(ce[top]).toFixed(2), lat0: cur.lat[cur.y0], dLat: cur.lat[cur.y0 + 1] - cur.lat[cur.y0], lon0: cur.lon[cur.x0], dLon: cur.lon[cur.x0 + 1] - cur.lon[cur.x0], ny: cur.ny, nx: cur.nx,
    u: b64(U), v: b64(V) }; // [day][y*nx + x]: toward east / north in cm/s (±127 = 1.27 m/s or more), −128 = land
  writeFileSync(`${dir}/currents.json`, JSON.stringify(cj));
  console.log(`currents.json: ${cj.dates[0]}..${cj.dates.at(-1)} at ${cj.level} m, ${cur.ny}×${cur.nx}, mean ${(mean * 100).toFixed(0)} cm/s, 99th percentile ${(top99 * 100).toFixed(0)} cm/s, ${(JSON.stringify(cj).length / 1024).toFixed(0)} kB`);
} catch (e) { console.warn('currents.json not built:', e.message); }

/* ---------- surface.json: the satellite surface maps (a failure here leaves ocean.json published and the app on its own downloads) ---------- */
try {
  const sat = (product, re, known) => stores(product, re, 'timeChunked', known + '/timeChunked.zarr');
  const SST = 'SST_MED_SST_L4_NRT_OBSERVATIONS_010_004', OC = 'OCEANCOLOUR_MED_BGC_L4_NRT_009_142';
  const SRC = { // the same stores as js/sources.js ARCO and js/ocean.js SRC (timeChunked: one day of the whole sea per chunk)
    sst: [() => sat(SST, /^SST_MED_SST_L4_NRT_OBSERVATIONS_010_004_c_V\d+_\d{6}$/, `mdl-arco-time-046/arco/${SST}/${SST}_c_V2_202311`), 'analysed_sst', -273.15],
    anom: [() => sat(SST, /^SST_MED_SSTA_L4_NRT_OBSERVATIONS_010_004_b_\d{6}$/, `mdl-arco-time-046/arco/${SST}/SST_MED_SSTA_L4_NRT_OBSERVATIONS_010_004_b_202607`), 'sst_anomaly', 0],
    chl: [() => sat(OC, /^cmems_obs-oc_med_bgc-plankton_nrt_l4-gapfree-multi-1km_P1D_\d{6}$/, `mdl-arco-time-045/arco/${OC}/cmems_obs-oc_med_bgc-plankton_nrt_l4-gapfree-multi-1km_P1D_202207`), 'CHL', 0],
  };
  const latest = async k => first(await SRC[k][0](), async url => { // the newest uploaded day (the last step can be listed a little before its chunks arrive)
    const [, v, add] = SRC[k], st = await open(url);
    for (let t = st.last; t >= st.last - 2; t--) {
      try { const g = await st.grid(v, t, 0); return { st, t, g: add ? g.map(x => x + add) : g }; }
      catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
    }
    throw new Error(k + ': no recent day');
  });
  const head = ({ st, t }) => ({ date: st.date(t), lat0: st.lat[st.y0], dLat: st.lat[st.y0 + 1] - st.lat[st.y0], lon0: st.lon[st.x0], dLon: st.lon[st.x0 + 1] - st.lon[st.x0], ny: st.ny, nx: st.nx });
  const qb = (...a) => b64(q(...a));
  const [s0, an, ch] = await Promise.all([latest('sst'), latest('anom').catch(e => (console.warn('surface anomaly:', e.message), null)), latest('chl').catch(e => (console.warn('surface chlorophyll:', e.message), null))]);
  const surf = { made: new Date().toISOString(), source: 'E.U. Copernicus Marine Service Information: SST_MED_SST_L4_NRT_OBSERVATIONS_010_004, OCEANCOLOUR_MED_BGC_L4_NRT_009_142',
    sst: { ...head(s0), res: '1 km', q: qb(s0.g, Int16Array, v => v * 100, -32768, -32767, 32767) }, // °C × 100, −32768 = land / none
    ...(an && { anom: { ...head(an), res: '7 km', q: qb(an.g, Int8Array, v => v * 10, -128, -127, 127) } }), // °C × 10 against the 1991-2020 day of the year
    ...(ch && { chl: { ...head(ch), res: '1 km', q: qb(ch.g, Uint16Array, v => (Math.log10(Math.max(v, 1e-3)) + 2.5) * 1e4, 65535, 0, 65534) } }) }; // log10(mg/m³): (x + 2.5) × 10000, 65535 = none (fine steps: the app takes fronts from its gradient)
  const ok = s0.g.filter(v => !Number.isNaN(v)), mn = ok.reduce((a, v) => Math.min(a, v), 99), mx = ok.reduce((a, v) => Math.max(a, v), -99);
  if (!(ok.length > 20000 && mn > 12 && mx < 33)) throw new Error(`surface.json looks wrong: ${ok.length} sea cells, ${mn}..${mx} °C`);
  writeFileSync(`${dir}/surface.json`, JSON.stringify(surf));
  console.log(`surface.json: sst ${surf.sst.date} (${surf.sst.ny}×${surf.sst.nx}, ${mn.toFixed(1)}..${mx.toFixed(1)} °C), anomaly ${surf.anom?.date || 'no'}, chlorophyll ${surf.chl?.date || 'no'}, ${(JSON.stringify(surf).length / 1024).toFixed(0)} kB`);

  /* ---------- fronts.json: the front lines on those two maps (js/sources.js loadFronts()) ---------- */
  // q: the front's gradient in `unit` steps on front pixels, 0 on sea without a front, 255 on land / no data.
  try {
    const lines = (s, hi, unit, clear, f = x => x) => {
      const fr = fronts({ ...head(s), g: s.g.map(f) }, hi, clear); let n = 0; for (const v of fr) if (v > 0) n++;
      return { ...head(s), res: '1 km', unit, px: n, q: qb(fr, Uint8Array, v => v / unit, 255, 0, 254) };
    };
    const fj = { made: new Date().toISOString(), source: surf.source, method: 'Belkin & O\'Reilly (2009) spike median, Sobel gradient, Canny (1986) thinning and hysteresis',
      sst: lines(s0, SST_FRONT, .002, 0), // °C/km
      ...(ch && { chl: lines(ch, CHL_FRONT, .0005, 3, v => Math.log10(Math.max(v, 1e-3))) }) }; // log10(mg/m³) per km; none within ~3 km of land (the coastal band)
    if (!(fj.sst.px > 100 && fj.sst.px < ok.length * .15)) throw new Error(`fronts.json looks wrong: ${fj.sst.px} SST front pixels`);
    writeFileSync(`${dir}/fronts.json`, JSON.stringify(fj));
    console.log(`fronts.json: sst ${fj.sst.date} ${fj.sst.px} front pixels, chlorophyll ${fj.chl ? fj.chl.date + ' ' + fj.chl.px : 'no'}, ${(JSON.stringify(fj).length / 1024).toFixed(0)} kB`);
  } catch (e) { console.warn('fronts.json not built:', e.message); }
} catch (e) { console.warn('surface.json not built:', e.message); }
