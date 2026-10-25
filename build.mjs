// Psarema daily ocean file: the Copernicus Marine Mediterranean model's temperature at depth and mixed-layer depth around Cyprus, for
// the app's 10 timeline days (2 back, today, 7 ahead). Read from the public ARCO Zarr stores (no account), cut to the Cyprus box and
// packed into one small JSON. Runs once a day in the psarema-data repo (GitHub Actions, workflow.yml); js/sources.js loadOcean() reads it.
//   node build.mjs [outDir]          -> outDir/ocean.json (~0.5 MB; GitHub Pages serves it gzipped, ~0.2 MB)
// Data: E.U. Copernicus Marine Service, MEDSEA_ANALYSISFORECAST_PHY_006_013 (4.2 km, daily means); Copernicus Marine licence (attribution).
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://s3.waw3-1.cloudferro.com/mdl-arco-geo-033/arco/MEDSEA_ANALYSISFORECAST_PHY_006_013/';
// ponytail: dataset versions hard-coded like js/sources.js; on a 404 look the new ID up at https://stac.marine.copernicus.eu (scripts/ocean/README.md)
const TEM = BASE + 'cmems_mod_med_phy-tem_anfc_4.2km_P1D-m_202511/geoChunked.zarr', MLD = BASE + 'cmems_mod_med_phy-mld_anfc_4.2km_P1D-m_202511/geoChunked.zarr';
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
  const axis = async name => Array.from(dec(name, await get(`${name}/0`)), Number);
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
  return { meta, lat, lon, y0, x0, ny, nx, today, last, grid, date, get, dec };
}

const [tem, mld] = await Promise.all([open(TEM), open(MLD)]);
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
