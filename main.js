// Por +esm de jsDelivr: los addons importan la misma URL de three, y no hace falta importmap (la CSP del
// portfolio bloquea scripts en línea, y un importmap lo es).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js/+esm';
import { RoomEnvironment } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/environments/RoomEnvironment.js/+esm';

// ==== SIM ====
// Cuerpo blando XPBD sobre malla de tetraedros (técnica de Ten Minute Physics, M. Müller).
// Las formas son funciones de distancia con signo (SDF, negativo dentro): de ahí salen la malla
// de simulación (vóxeles partidos en 6 tetraedros) y la superficie visible (surface nets, más fina),
// que va incrustada en los tetraedros con coordenadas baricéntricas.

const GRAV = -9.81;
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const CUBE_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const TET_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

function sdBox(x, y, z, bx, by, bz, r = 0) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

function tetVolume(p, T, t) {
  const a = T[4 * t] * 3, b = T[4 * t + 1] * 3, c = T[4 * t + 2] * 3, d = T[4 * t + 3] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  const e3x = p[d] - p[a], e3y = p[d + 1] - p[a + 1], e3z = p[d + 2] - p[a + 2];
  return (e1x * (e2y * e3z - e2z * e3y) + e1y * (e2z * e3x - e2x * e3z) + e1z * (e2x * e3y - e2y * e3x)) / 6;
}

// Rejilla centrada en la caja: celdas cuyo centro cae dentro de la forma (con un margen para que la
// superficie visible quede envuelta), cada una en 6 tetraedros
// (partición de Kuhn, que encaja sin huecos entre celdas vecinas).
function tetMeshFromSDF(sdf, b, h) {
  const n = [0, 1, 2].map(a => Math.max(1, Math.ceil((b[a + 3] - b[a]) / h - 1e-6)));
  const o = [0, 1, 2].map(a => (b[a] + b[a + 3]) / 2 - n[a] * h / 2);
  const [nx, ny, nz] = n, NX = nx + 1, NY = ny + 1;
  const vid = new Int32Array(NX * NY * (nz + 1)).fill(-1);
  const cellStart = new Int32Array(nx * ny * nz).fill(-1);
  const verts = [], tets = [], c = new Array(8);
  const V = (i, j, k) => {
    const key = i + NX * (j + NY * k);
    if (vid[key] < 0) { vid[key] = verts.length / 3; verts.push(o[0] + i * h, o[1] + j * h, o[2] + k * h); }
    return vid[key];
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (sdf(o[0] + (i + .5) * h, o[1] + (j + .5) * h, o[2] + (k + .5) * h) >= 0.25 * h) continue;
    for (let q = 0; q < 8; q++) c[q] = V(i + (q & 1), j + (q >> 1 & 1), k + (q >> 2 & 1));
    cellStart[i + nx * (j + ny * k)] = tets.length / 4;
    for (const p of PERMS) { const a = 1 << p[0], ab = a | (1 << p[1]); tets.push(c[0], c[a], c[ab], c[7]); }
  }
  const pos = new Float32Array(verts), T = new Uint32Array(tets), nv = pos.length / 3;
  for (let t = 0; t < T.length / 4; t++) {
    if (tetVolume(pos, T, t) < 0) { const s = T[4 * t + 2]; T[4 * t + 2] = T[4 * t + 3]; T[4 * t + 3] = s; }
  }
  const seen = new Set(), edges = [];
  for (let t = 0; t < T.length / 4; t++) for (const [x, y] of TET_EDGES) {
    const a = T[4 * t + x], bb = T[4 * t + y], lo = Math.min(a, bb), hi = Math.max(a, bb), key = lo * nv + hi;
    if (!seen.has(key)) { seen.add(key); edges.push(lo, hi); }
  }
  return { pos, tets: T, edges: new Uint32Array(edges), grid: { o, h, nx, ny, nz, cellStart } };
}

// Surface nets: un vértice por cubo que cruza la superficie y un quad por arista que cambia de signo.
function surfaceNets(sdf, b, h) {
  const o = [b[0] - h, b[1] - h, b[2] - h];
  const nx = Math.ceil((b[3] + h - o[0]) / h), ny = Math.ceil((b[4] + h - o[1]) / h), nz = Math.ceil((b[5] + h - o[2]) / h);
  const PX = nx + 1, PY = ny + 1;
  const f = new Float32Array(PX * PY * (nz + 1));
  for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++)
    f[i + PX * (j + PY * k)] = sdf(o[0] + i * h, o[1] + j * h, o[2] + k * h);
  const cv = new Int32Array(nx * ny * nz).fill(-1);
  const P = [], v = new Float32Array(8);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let mask = 0;
    for (let q = 0; q < 8; q++) {
      v[q] = f[(i + (q & 1)) + PX * ((j + (q >> 1 & 1)) + PY * (k + (q >> 2 & 1)))];
      if (v[q] < 0) mask |= 1 << q;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, c] of CUBE_EDGES) {
      if ((v[a] < 0) === (v[c] < 0)) continue;
      const t = v[a] / (v[a] - v[c]);
      const ax = a & 1, ay = a >> 1 & 1, az = a >> 2 & 1;
      sx += ax + ((c & 1) - ax) * t; sy += ay + ((c >> 1 & 1) - ay) * t; sz += az + ((c >> 2 & 1) - az) * t; cnt++;
    }
    cv[i + nx * (j + ny * k)] = P.length / 3;
    P.push(o[0] + (i + sx / cnt) * h, o[1] + (j + sy / cnt) * h, o[2] + (k + sz / cnt) * h);
  }
  const C = (i, j, k) => cv[i + nx * (j + ny * k)];
  const idx = [];
  const quad = (a, b2, c, d, flip) => flip ? idx.push(a, c, b2, a, d, c) : idx.push(a, b2, c, a, c, d);
  for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const f0 = f[i + PX * (j + PY * k)], in0 = f0 < 0;
    if (i < nx && j > 0 && j < ny && k > 0 && k < nz && (f[i + 1 + PX * (j + PY * k)] < 0) !== in0)
      quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), !in0);
    if (j < ny && i > 0 && i < nx && k > 0 && k < nz && (f[i + PX * (j + 1 + PY * k)] < 0) !== in0)
      quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), !in0);
    if (k < nz && i > 0 && i < nx && j > 0 && j < ny && (f[i + PX * (j + PY * (k + 1))] < 0) !== in0)
      quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), !in0);
  }
  return { pos: new Float32Array(P), idx: new Uint32Array(idx) };
}

// Para cada vértice visible: el tetraedro que lo contiene (o el más cercano) y sus baricéntricas.
function embed(vp, mesh) {
  const { pos: p, tets: T, grid: { o, h, nx, ny, nz, cellStart } } = mesh;
  const nV = vp.length / 3, tid = new Int32Array(nV), bary = new Float32Array(nV * 3);
  const res = [0, 0, 0, 0];
  const baryOf = (t, x, y, z) => {
    const a = T[4 * t] * 3, b = T[4 * t + 1] * 3, c = T[4 * t + 2] * 3, d = T[4 * t + 3] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const e3x = p[d] - p[a], e3y = p[d + 1] - p[a + 1], e3z = p[d + 2] - p[a + 2];
    const dx = x - p[a], dy = y - p[a + 1], dz = z - p[a + 2];
    const det3 = (ax, ay, az, bx, by, bz, cx, cy, cz) => ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const det = det3(e1x, e1y, e1z, e2x, e2y, e2z, e3x, e3y, e3z);
    res[1] = det3(dx, dy, dz, e2x, e2y, e2z, e3x, e3y, e3z) / det;
    res[2] = det3(e1x, e1y, e1z, dx, dy, dz, e3x, e3y, e3z) / det;
    res[3] = det3(e1x, e1y, e1z, e2x, e2y, e2z, dx, dy, dz) / det;
    res[0] = 1 - res[1] - res[2] - res[3];
    return Math.min(res[0], res[1], res[2], res[3]);
  };
  for (let v = 0; v < nV; v++) {
    const x = vp[3 * v], y = vp[3 * v + 1], z = vp[3 * v + 2];
    const ci = Math.floor((x - o[0]) / h), cj = Math.floor((y - o[1]) / h), ck = Math.floor((z - o[2]) / h);
    let best = -Infinity, bt = 0, b1 = 0, b2 = 0, b3 = 0;
    for (let r = 0; r <= 4 && best < -1e-4; r++) {
      for (let k = ck - r; k <= ck + r; k++) for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
        const s = cellStart[i + nx * (j + ny * k)];
        if (s < 0) continue;
        for (let t = s; t < s + 6; t++) {
          const m = baryOf(t, x, y, z);
          if (m > best) { best = m; bt = t; b1 = res[1]; b2 = res[2]; b3 = res[3]; }
        }
      }
    }
    tid[v] = bt; bary[3 * v] = b1; bary[3 * v + 1] = b2; bary[3 * v + 2] = b3;
  }
  return { tid, bary };
}

class SoftBody {
  constructor(mesh, { density = 1000, pinned = null } = {}) {
    const n = this.n = mesh.pos.length / 3;
    this.rest = mesh.pos;
    this.pos = Float64Array.from(mesh.pos);     // Float64: con subpasos cortos, (pos - prev) / dt amplifica el redondeo
    this.prev = Float64Array.from(mesh.pos);
    this.vel = new Float64Array(3 * n);
    this.tets = mesh.tets;
    this.edges = mesh.edges;
    const nT = this.tets.length / 4;
    this.restVol = new Float32Array(nT);
    this.mass = new Float32Array(n);
    this.restVolume = 0;
    for (let t = 0; t < nT; t++) {
      const v = tetVolume(this.rest, this.tets, t);
      this.restVol[t] = v; this.restVolume += v;
      for (let q = 0; q < 4; q++) this.mass[this.tets[4 * t + q]] += v * density / 4;
    }
    this.restVol6 = this.restVol.map(v => 6 * v);
    this.totalMass = this.restVolume * density;
    this.invMass = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fijo = pinned && pinned(this.rest[3 * i], this.rest[3 * i + 1], this.rest[3 * i + 2]);
      this.invMass[i] = fijo || this.mass[i] === 0 ? 0 : 1 / this.mass[i];
    }
    this.invMass0 = this.invMass.slice();
    this.contacto = new Uint8Array(n);
    this.tocaba = false;
    this.vImpacto = 0;
    const nE = this.edges.length / 2;
    this.restLen = new Float32Array(nE);
    for (let e = 0; e < nE; e++) {
      const a = 3 * this.edges[2 * e], b = 3 * this.edges[2 * e + 1], r = this.rest;
      this.restLen[e] = Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2]);
    }
    this.restLen0 = this.restLen.slice();
    this.grab = null;
    this.kin = null;   // parche guiado: pos = base + dir · x · w (lo usa la diana al atrapar el balín)
    this.h = mesh.grid.h;
    this.soldadas = new Set();
  }

  substep(dt, P, pellets, mazo = null) {
    const { pos, prev, vel, invMass: w, mass: m, n } = this;
    // Amortiguación interna: frena el movimiento relativo al centro de masas, no la caída ni el lanzamiento.
    let cx = 0, cy = 0, cz = 0, mt = 0;
    for (let i = 0; i < n; i++) if (w[i] > 0) { cx += m[i] * vel[3 * i]; cy += m[i] * vel[3 * i + 1]; cz += m[i] * vel[3 * i + 2]; mt += m[i]; }
    if (mt > 0) { cx /= mt; cy /= mt; cz /= mt; }
    const damp = Math.max(0, 1 - P.damping * dt);
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      const i3 = 3 * i;
      vel[i3] = cx + (vel[i3] - cx) * damp; vel[i3 + 1] = cy + (vel[i3 + 1] - cy) * damp; vel[i3 + 2] = cz + (vel[i3 + 2] - cz) * damp;
      vel[i3 + 1] += GRAV * dt;
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
    }
    const g = this.grab;
    if (g) for (let k = 0; k < g.ids.length; k++) {
      const i3 = 3 * g.ids[k];
      for (let c = 0; c < 3; c++) { prev[i3 + c] = pos[i3 + c]; pos[i3 + c] = g.target[c] + g.off[3 * k + c]; }
      if (pos[i3 + 1] < 0) pos[i3 + 1] = 0;   // si no, al soltar el suelo las saca de golpe y salen disparadas
    }
    const kn = this.kin;
    if (kn) for (let k = 0; k < kn.ids.length; k++) {
      const i3 = 3 * kn.ids[k], s = kn.x * kn.w[k];
      for (let c = 0; c < 3; c++) { prev[i3 + c] = pos[i3 + c]; pos[i3 + c] = kn.base[3 * k + c] + kn.dir[c] * s; }
    }
    this.solveEdges(P.edgeCompliance / (dt * dt));
    this.solveVolumes(P.volCompliance / (dt * dt));
    for (const b of pellets) this.collidePellet(b, dt);
    if (mazo) this.collideMallet(mazo);
    this.collideGround(0.6);
    const inv = 1 / dt;
    for (let i = 0; i < 3 * n; i++) vel[i] = (pos[i] - prev[i]) * inv;
    if (P.restitution > 0) this.restitute(P.restitution, cy, mt);
  }

  // Rebote a nivel de cuerpo: PBD pierde la energía del choque contra el suelo (por partícula no basta, el
  // resto del cuerpo se come el rebote). Se guarda la velocidad del centro de masas al tocar y, cuando
  // acaba la compresión, se devuelve una fracción a todo el cuerpo.
  restitute(e, vyAntes, mt) {
    if (this.grab || mt === 0) { this.vImpacto = 0; return; }
    const { vel, invMass: w, mass: m, contacto, n } = this;
    let toca = false;
    for (let i = 0; i < n; i++) if (contacto[i]) { toca = true; break; }
    if (toca && !this.tocaba && vyAntes < -0.5) this.vImpacto = -vyAntes;
    this.tocaba = toca;
    if (!toca) { this.vImpacto = 0; return; }
    if (this.vImpacto === 0) return;
    let vy = 0;
    for (let i = 0; i < n; i++) if (w[i] > 0) vy += m[i] * vel[3 * i + 1];
    vy /= mt;
    if (vy < -0.05) return;
    const dv = e * this.vImpacto - vy;
    for (let i = 0; i < n; i++) if (w[i] > 0) vel[3 * i + 1] += dv;
    this.vImpacto = 0;
  }

  // Cabeza de la maza: cilindro cinemático. a = sentido del golpe, c = centro de la cara, r = radio,
  // l = largo (la cabeza queda detrás de la cara). Lo que se mete en la cabeza se empuja hasta la cara.
  collideMallet({ c, a, r, l }) {
    const p = this.pos, w = this.invMass;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      const i3 = 3 * i, dx = p[i3] - c[0], dy = p[i3 + 1] - c[1], dz = p[i3 + 2] - c[2];
      const t = dx * a[0] + dy * a[1] + dz * a[2];
      if (t >= 0 || t <= -l) continue;
      if (Math.hypot(dx - t * a[0], dy - t * a[1], dz - t * a[2]) >= r) continue;
      p[i3] -= a[0] * t; p[i3 + 1] -= a[1] * t; p[i3 + 2] -= a[2] * t;
    }
  }

  solveEdges(alpha) {
    const p = this.pos, w = this.invMass, E = this.edges, L = this.restLen;
    for (let e = 0; e < L.length; e++) {
      const a = E[2 * e], b = E[2 * e + 1], wa = w[a], wb = w[b], ws = wa + wb;
      if (ws === 0) continue;
      const a3 = 3 * a, b3 = 3 * b;
      const dx = p[a3] - p[b3], dy = p[a3 + 1] - p[b3 + 1], dz = p[a3 + 2] - p[b3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len === 0) continue;
      const s = -(len - L[e]) / (ws + alpha) / len;
      p[a3] += dx * s * wa; p[a3 + 1] += dy * s * wa; p[a3 + 2] += dz * s * wa;
      p[b3] -= dx * s * wb; p[b3 + 1] -= dy * s * wb; p[b3 + 2] -= dz * s * wb;
    }
  }

  // Gradientes de 6V: g1 = e2×e3, g2 = e3×e1, g3 = e1×e2 y g0 = -(g1+g2+g3).
  solveVolumes(alpha) {
    const p = this.pos, w = this.invMass, T = this.tets, R6 = this.restVol6;
    for (let t = 0; t < R6.length; t++) {
      const a = T[4 * t], b = T[4 * t + 1], c = T[4 * t + 2], d = T[4 * t + 3];
      const wa = w[a], wb = w[b], wc = w[c], wd = w[d];
      if (wa + wb + wc + wd === 0) continue;
      const a3 = 3 * a, b3 = 3 * b, c3 = 3 * c, d3 = 3 * d;
      const x0 = p[a3], y0 = p[a3 + 1], z0 = p[a3 + 2];
      const e1x = p[b3] - x0, e1y = p[b3 + 1] - y0, e1z = p[b3 + 2] - z0;
      const e2x = p[c3] - x0, e2y = p[c3 + 1] - y0, e2z = p[c3 + 2] - z0;
      const e3x = p[d3] - x0, e3y = p[d3 + 1] - y0, e3z = p[d3 + 2] - z0;
      const g1x = e2y * e3z - e2z * e3y, g1y = e2z * e3x - e2x * e3z, g1z = e2x * e3y - e2y * e3x;
      const g2x = e3y * e1z - e3z * e1y, g2y = e3z * e1x - e3x * e1z, g2z = e3x * e1y - e3y * e1x;
      const g3x = e1y * e2z - e1z * e2y, g3y = e1z * e2x - e1x * e2z, g3z = e1x * e2y - e1y * e2x;
      const g0x = -g1x - g2x - g3x, g0y = -g1y - g2y - g3y, g0z = -g1z - g2z - g3z;
      const ws = wa * (g0x * g0x + g0y * g0y + g0z * g0z) + wb * (g1x * g1x + g1y * g1y + g1z * g1z)
        + wc * (g2x * g2x + g2y * g2y + g2z * g2z) + wd * (g3x * g3x + g3y * g3y + g3z * g3z);
      if (ws === 0) continue;
      const s = -(e1x * g1x + e1y * g1y + e1z * g1z - R6[t]) / (ws + alpha);
      let k = s * wa; p[a3] += g0x * k; p[a3 + 1] += g0y * k; p[a3 + 2] += g0z * k;
      k = s * wb; p[b3] += g1x * k; p[b3 + 1] += g1y * k; p[b3 + 2] += g1z * k;
      k = s * wc; p[c3] += g2x * k; p[c3 + 1] += g2y * k; p[c3 + 2] += g2z * k;
      k = s * wd; p[d3] += g3x * k; p[d3 + 1] += g3y * k; p[d3 + 2] += g3z * k;
    }
  }

  collideGround(friction) {
    const p = this.pos, q = this.prev, w = this.invMass;
    for (let i = 0; i < this.n; i++) {
      const i3 = 3 * i;
      this.contacto[i] = 0;
      if (w[i] === 0 || p[i3 + 1] >= 0) continue;
      this.contacto[i] = 1;
      p[i3 + 1] = 0;
      p[i3] = q[i3] + (p[i3] - q[i3]) * (1 - friction);
      p[i3 + 2] = q[i3 + 2] + (p[i3 + 2] - q[i3 + 2]) * (1 - friction);
    }
  }

  // El balín es una partícula más: cada contacto se corrige repartido por masas (se conserva el
  // momento) y su velocidad sale de cuánto se ha movido. Avanza en tramos de media r para no atravesar.
  collidePellet(b, dt) {
    const p = this.pos, w = this.invMass, r = b.r, r2 = r * r, x = b.x, v = b.v, wb = 1 / b.m;
    v[1] += GRAV * dt;
    const x0 = x[0], y0 = x[1], z0 = x[2];
    const steps = Math.max(1, Math.ceil(Math.hypot(v[0], v[1], v[2]) * dt / (r * 0.5)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      x[0] += v[0] * h; x[1] += v[1] * h; x[2] += v[2] * h;
      for (let i = 0; i < this.n; i++) {
        const i3 = 3 * i, dx = p[i3] - x[0], dy = p[i3 + 1] - x[1], dz = p[i3 + 2] - x[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), k = (r - d) / (w[i] + wb) / d, kp = k * w[i], kb = k * wb;
        p[i3] += dx * kp; p[i3 + 1] += dy * kp; p[i3 + 2] += dz * kp;
        x[0] -= dx * kb; x[1] -= dy * kb; x[2] -= dz * kb;
      }
    }
    if (x[1] < r) x[1] = r;
    v[0] = (x[0] - x0) / dt; v[1] = (x[1] - y0) / dt; v[2] = (x[2] - z0) / dt;
    if (x[1] <= r) { v[1] = Math.abs(v[1]) * 0.35; v[0] *= 0.8; v[2] *= 0.8; }
  }

  // Autocolisión y mezcla (plastilina). Pares de partículas que estaban lejos en la forma original pero ahora
  // se tocan: se separan hasta dMin (solo posición, sin meter velocidad) y, si se han apretado por debajo de
  // dSoldar, se unen con una arista nueva. No se quita ninguna partícula: la masa se conserva, y el volumen
  // lo siguen sujetando los tetraedros, así que no se puede aplastar hasta 0.
  selfCollide(dMin, dSoldar) {
    const n = this.n, p = this.pos, w = this.invMass, r = this.rest, lejos2 = (1.8 * this.h) ** 2;
    const T = 2 * n + 1, inv = 1 / dMin;
    const celda = (x, y, z) => ((Math.imul(x, 92837111) ^ Math.imul(y, 689287499) ^ Math.imul(z, 283923481)) >>> 0) % T;
    const inicio = new Int32Array(T + 1), cuenta = new Int32Array(T), orden = new Int32Array(n), cel = new Int32Array(n);
    for (let i = 0; i < n; i++) { cel[i] = celda(Math.floor(p[3 * i] * inv), Math.floor(p[3 * i + 1] * inv), Math.floor(p[3 * i + 2] * inv)); cuenta[cel[i]]++; }
    for (let k = 0; k < T; k++) inicio[k + 1] = inicio[k] + cuenta[k];
    cuenta.fill(0);
    for (let i = 0; i < n; i++) orden[inicio[cel[i]] + cuenta[cel[i]]++] = i;
    const nuevas = [], d2Min = dMin * dMin;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i, ix = Math.floor(p[i3] * inv), iy = Math.floor(p[i3 + 1] * inv), iz = Math.floor(p[i3 + 2] * inv);
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = celda(ix + dx, iy + dy, iz + dz);
        for (let q = inicio[k]; q < inicio[k + 1]; q++) {
          const j = orden[q];
          if (j <= i) continue;
          const j3 = 3 * j, ex = p[j3] - p[i3], ey = p[j3 + 1] - p[i3 + 1], ez = p[j3 + 2] - p[i3 + 2];
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= d2Min || d2 < 1e-12) continue;
          const rx = r[j3] - r[i3], ry = r[j3 + 1] - r[i3 + 1], rz = r[j3 + 2] - r[i3 + 2];
          if (rx * rx + ry * ry + rz * rz < lejos2 || this.soldadas.has(i * n + j)) continue;
          const ws = w[i] + w[j];
          if (ws === 0) continue;
          const d = Math.sqrt(d2), k2 = (dMin - d) / d / ws;
          p[i3] -= ex * k2 * w[i]; p[i3 + 1] -= ey * k2 * w[i]; p[i3 + 2] -= ez * k2 * w[i];
          p[j3] += ex * k2 * w[j]; p[j3 + 1] += ey * k2 * w[j]; p[j3 + 2] += ez * k2 * w[j];
          if (d < dSoldar) { nuevas.push(i, j); this.soldadas.add(i * n + j); }
        }
      }
    }
    if (nuevas.length) this.weld(nuevas, dMin);
    return nuevas.length / 2;
  }

  weld(pares, largo) {
    const nE = this.restLen.length, extra = pares.length / 2;
    const E = new Uint32Array(this.edges.length + pares.length);
    E.set(this.edges); E.set(pares, this.edges.length);
    const L = new Float32Array(nE + extra), L0 = new Float32Array(nE + extra);
    L.set(this.restLen); L0.set(this.restLen0);
    L.fill(largo, nE); L0.fill(largo, nE);
    this.edges = E; this.restLen = L; this.restLen0 = L0;
  }

  // Plastilina: si una arista se estira o encoge más que el límite, su longitud de reposo la sigue.
  plastify(yieldStrain) {
    const p = this.pos, E = this.edges, L = this.restLen, L0 = this.restLen0;
    for (let e = 0; e < L.length; e++) {
      const a = 3 * E[2 * e], b = 3 * E[2 * e + 1];
      const len = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
      let r = L[e];
      if (len > r * (1 + yieldStrain)) r = len / (1 + yieldStrain);
      else if (len < r * (1 - yieldStrain)) r = len / (1 - yieldStrain);
      L[e] = Math.min(Math.max(r, 0.2 * L0[e]), 5 * L0[e]);
    }
  }

  stats() {
    let ke = 0, vol = 0;
    for (let i = 0; i < this.n; i++) {
      const i3 = 3 * i;
      ke += 0.5 * this.mass[i] * (this.vel[i3] ** 2 + this.vel[i3 + 1] ** 2 + this.vel[i3 + 2] ** 2);
    }
    for (let t = 0; t < this.restVol.length; t++) vol += tetVolume(this.pos, this.tets, t);
    return { masa: this.totalMass, volumen: vol / this.restVolume, ke };
  }
}
// ==== FIN SIM ====

// ---------- Formas ----------

function formaGelatina() {
  return { sdf: (x, y, z) => sdBox(x, y - 0.42, z, 0.6, 0.4, 0.4, 0.06), bounds: [-0.6, 0.02, -0.4, 0.6, 0.82, 0.4], cell: 0.1 };
}

// Cartulina de 10 m pistola a escala 1 unidad = 100 mm, sujeta por el borde.
const DIANA_Y = 1.1, DIANA_L = 0.85;
function formaDiana() {
  return {
    sdf: (x, y, z) => sdBox(x, y - DIANA_Y, z, DIANA_L, DIANA_L, 0.1),
    bounds: [-DIANA_L, DIANA_Y - DIANA_L, -0.1, DIANA_L, DIANA_Y + DIANA_L, 0.1],
    cell: 0.1,
    pinned: (x, y) => Math.abs(x) > DIANA_L - 0.01 || Math.abs(y - DIANA_Y) > DIANA_L - 0.01,
    uv: (x, y) => [(x + DIANA_L) / (2 * DIANA_L), (y - DIANA_Y + DIANA_L) / (2 * DIANA_L)],
  };
}

// Rey de ajedrez: perfil de torno (altura, radio) más la cruz.
const PERFIL_REY = [[0, .46], [.1, .46], [.14, .40], [.2, .37], [.26, .32], [.34, .28], [.9, .21], [1.04, .22], [1.08, .29],
  [1.14, .29], [1.18, .22], [1.24, .22], [1.48, .31], [1.54, .31], [1.6, .18]];
function radioRey(y) {
  if (y <= 0) return PERFIL_REY[0][1];
  for (let i = 1; i < PERFIL_REY.length; i++) {
    const [y1, r1] = PERFIL_REY[i];
    if (y <= y1) { const [y0, r0] = PERFIL_REY[i - 1]; return r0 + (r1 - r0) * (y - y0) / (y1 - y0); }
  }
  return PERFIL_REY[PERFIL_REY.length - 1][1];
}
function formaRey() {
  const Y0 = 0.02;
  return {
    sdf: (x, y, z) => {
      y -= Y0;
      const cuerpo = Math.max((Math.hypot(x, z) - radioRey(y)) * 0.8, -y, y - 1.6);
      const palo = sdBox(x, y - 1.78, z, 0.09, 0.2, 0.09);
      const brazo = sdBox(x, y - 1.8, z, 0.22, 0.085, 0.09);
      return Math.min(cuerpo, palo, brazo);
    },
    bounds: [-0.48, 0, -0.48, 0.48, 2.02, 0.48],
    cell: 0.08,
  };
}

// Letras: el texto se pinta en un canvas, se saca su distancia con signo en 2D (chamfer) y se extruye.
function chamfer(objetivo, W, H) {
  const d = new Float32Array(W * H), D = Math.SQRT2;
  for (let i = 0; i < W * H; i++) d[i] = objetivo[i] ? 0 : 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, d[i - W] + 1);
      if (x > 0) v = Math.min(v, d[i - W - 1] + D);
      if (x < W - 1) v = Math.min(v, d[i - W + 1] + D);
    }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < H - 1) {
      v = Math.min(v, d[i + W] + 1);
      if (x < W - 1) v = Math.min(v, d[i + W + 1] + D);
      if (x > 0) v = Math.min(v, d[i + W - 1] + D);
    }
    d[i] = v;
  }
  return d;
}

const FUENTE_LETRAS = '"Archivo Black", "Arial Black", sans-serif';
function limpiarTexto(t) {
  const s = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 8);
  return s || 'BOING';
}

async function formaLetras(texto) {
  try { await document.fonts.load(`220px ${FUENTE_LETRAS}`); } catch {}
  const F = 220, pad = 24, Y0 = 0.02, D = 0.18;
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d');
  ctx.font = `${F}px ${FUENTE_LETRAS}`;
  const m = ctx.measureText(texto);
  const asc = Math.ceil(m.actualBoundingBoxAscent), des = Math.ceil(m.actualBoundingBoxDescent);
  const izq = Math.ceil(m.actualBoundingBoxLeft), der = Math.ceil(m.actualBoundingBoxRight);
  const W = izq + der + 2 * pad, H = asc + des + 2 * pad, base = pad + asc;
  cv.width = W; cv.height = H;
  ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.font = `${F}px ${FUENTE_LETRAS}`;
  ctx.fillStyle = '#fff';
  ctx.fillText(texto, pad + izq, base);
  const px = ctx.getImageData(0, 0, W, H).data;
  const dentro = new Uint8Array(W * H), fuera = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { dentro[i] = px[4 * i + 3] > 127 ? 1 : 0; fuera[i] = 1 - dentro[i]; }
  const dOut = chamfer(dentro, W, H), dIn = chamfer(fuera, W, H);
  const sd = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) sd[i] = dentro[i] ? -(dIn[i] - 0.5) : dOut[i] - 0.5;

  let ppu = asc / 0.9;                       // la letra más alta mide 0,9
  if ((W - 2 * pad) / ppu > 4) ppu = (W - 2 * pad) / 4;   // y la palabra, como mucho 4 de ancho
  const sd2 = (x, y) => {
    const fx = x * ppu + W / 2 - 0.5, fy = base - (y - Y0) * ppu - 0.5;
    if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return 1;
    const i0 = Math.min(Math.floor(fx), W - 2), j0 = Math.min(Math.floor(fy), H - 2), tx = fx - i0, ty = fy - j0, i = j0 * W + i0;
    const a = sd[i] + (sd[i + 1] - sd[i]) * tx, b = sd[i + W] + (sd[i + W + 1] - sd[i + W]) * tx;
    return (a + (b - a) * ty) / ppu;
  };
  return {
    sdf: (x, y, z) => {
      const a = sd2(x, y), b = Math.abs(z) - D;
      return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
    },
    bounds: [-W / 2 / ppu, Y0 - (des + pad) / ppu, -D - 0.05, W / 2 / ppu, Y0 + (asc + pad) / ppu, D + 0.05],
    cell: 0.09,
  };
}

function construir(forma) {
  const mesh = tetMeshFromSDF(forma.sdf, forma.bounds, forma.cell);
  const surf = surfaceNets(forma.sdf, forma.bounds, forma.cell * 0.4);
  const emb = embed(surf.pos, mesh);
  return { forma, mesh, surf, emb };
}

// ---------- Diana: textura de la cartulina ISSF de 10 m pistola ----------

const DIANA_TEX = 1024, DIANA_PX_MM = DIANA_TEX / 170;   // 170 mm de cartulina
const lienzoDiana = document.createElement('canvas');
lienzoDiana.width = lienzoDiana.height = DIANA_TEX;
const ctxDiana = lienzoDiana.getContext('2d', { willReadFrequently: true });
let texDiana = null;

function pintarDiana() {
  const S = DIANA_TEX, k = DIANA_PX_MM, c = S / 2, ctx = ctxDiana;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#f3f3f0'; ctx.fillRect(0, 0, S, S);
  const radio = n => (11.5 + (10 - n) * 16) / 2;     // radio exterior del anillo n, en mm
  ctx.fillStyle = '#141414';
  ctx.beginPath(); ctx.arc(c, c, radio(7) * k, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 0.4 * k;
  for (let n = 1; n <= 10; n++) {
    ctx.strokeStyle = n >= 8 ? '#f3f3f0' : '#141414';
    ctx.beginPath(); ctx.arc(c, c, radio(n) * k, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = '#f3f3f0';
  ctx.beginPath(); ctx.arc(c, c, 2.5 * k, 0, Math.PI * 2); ctx.stroke();   // diez interior
  ctx.font = `500 ${4.6 * k}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let n = 1; n <= 8; n++) {
    const r = (radio(n) + radio(n + 1)) / 2 * k;
    ctx.fillStyle = n >= 7 ? '#f3f3f0' : '#141414';
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ctx.fillText(String(n), c + dx * r, c + dy * r);
  }
  if (!texDiana) {
    texDiana = new THREE.CanvasTexture(lienzoDiana);
    texDiana.colorSpace = THREE.SRGBColorSpace;
    texDiana.anisotropy = 8;
  }
  texDiana.needsUpdate = true;
  return texDiana;
}

const pixelDiana = (u, v) => [Math.round(u * DIANA_TEX), Math.round((1 - v) * DIANA_TEX)];
const hayAgujero = (u, v) => ctxDiana.getImageData(...pixelDiana(u, v), 1, 1).data[3] < 128;

// Agujero del calibre del balín (4,5 mm) con su cerco gris de plomo. El cerco se pinta con 'source-atop'
// para que solo manche papel: sobre un agujero ya hecho volvería a crear cartulina donde no la hay.
function perforarDiana(u, v) {
  const [x, y] = pixelDiana(u, v), radio = R_BALIN * 100 * DIANA_PX_MM;   // 1 unidad = 100 mm
  const ctx = ctxDiana;
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(70, 72, 76, 0.55)';
  ctx.beginPath(); ctx.arc(x, y, radio * 1.35, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(x, y, radio, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  texDiana.needsUpdate = true;
}

// Puntuación decimal a partir de la distancia al centro en mm (calibre del balín de 4,5 mm incluido).
function puntuacion(dmm) {
  const s = Math.min(10.9, Math.floor((10 + (8 - dmm) / 8) * 10) / 10);
  return s < 1 ? null : s;
}

// ---------- Escena ----------

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const css = getComputedStyle(document.documentElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(css.getPropertyValue('--aluminio').trim());
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.minDistance = 1.2;
controls.maxDistance = 10;
// El botón izquierdo es solo para el objeto; la cámara va con el central y el derecho (en táctil no cambia).
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // sin autoscroll

const sol = new THREE.DirectionalLight('#ffffff', 1.6);
sol.position.set(2.5, 5, 3);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
Object.assign(sol.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
sol.shadow.normalBias = 0.02;
scene.add(sol);
scene.add(new THREE.HemisphereLight('#ffffff', '#9a9d99', 0.4));

const suelo = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.22 }));
suelo.rotation.x = -Math.PI / 2;
suelo.receiveShadow = true;
scene.add(suelo);

// Cada material es aspecto + comportamiento: al elegirlo, los deslizadores se colocan en sus valores.
// firmeza: posición dentro del rango del objeto; amortiguacion: deslizador (×10 = 1/s); restitucion: rebote.
const MATERIALES = {
  gelatina: { nombre: 'Gelatina', fisica: { firmeza: 0.3, amortiguacion: 0.075, restitucion: 0 },
    p: { color: '#ffffff', transmission: 1, roughness: 0.12, thickness: 0.6, ior: 1.34, attenuationColor: '#d9a93a', attenuationDistance: 0.9 } },
  silicona: { nombre: 'Silicona', fisica: { firmeza: 0.35, amortiguacion: 0.6, restitucion: 0 },
    p: { color: '#eef1ef', transmission: 0.6, roughness: 0.45, thickness: 0.5, ior: 1.41, attenuationColor: '#c9d4ce', attenuationDistance: 0.5 } },
  goma: { nombre: 'Goma', fisica: { firmeza: 0.75, amortiguacion: 0.03, restitucion: 0.8 }, p: { color: '#2b63d9', roughness: 0.6 } },
  laca: { nombre: 'Laca negra', fisica: { firmeza: 1, amortiguacion: 0.2, restitucion: 0.2 },
    p: { color: '#141414', roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 } },
  plastilina: { nombre: 'Plastilina', fisica: { amortiguacion: 0, restitucion: 0 }, plastico: true,
    p: { color: '#6f9a5e', roughness: 0.85 } },   // verde de la plastilina Jovi
};

function ponerDeslizador(id, valor) {
  const input = document.getElementById(id);
  input.value = valor;
  input.dispatchEvent(new Event('input'));
}

const OBJETOS = {
  gelatina: { forma: formaGelatina, material: 'gelatina', rango: [2.5, 5], plastilina: 4.2, mira: [0, 0.4, 0], cam: [2.2, 1.5, 2.8] },
  diana: { forma: formaDiana, material: null, firmeza: 0.45, mira: [0, DIANA_Y, -0.2], cam: [1.9, 1.6, 3.1] },
  letras: { forma: formaLetras, material: 'goma', rango: [4.2, 6], plastilina: 5, mira: [0, 0.45, 0], cam: [0.8, 1.4, 4.6] },
  rey: { forma: formaRey, material: 'laca', rango: [4.1, 6], plastilina: 5, mira: [0, 0.95, 0], cam: [2.0, 1.7, 3.4] },
};

const PISTA_DIANA = 'Toca para disparar. Con poca firmeza el balín la atraviesa; con más, la estira y la rompe; al máximo, la estira y te lo devuelve.';
const PISTAS = {
  agarrar: 'Arrastra el objeto para estirarlo y suéltalo. Botón central para girar la cámara, derecho para desplazarla, rueda para el zoom.',
  disparar: 'Toca para disparar un balín hacia donde apuntas. Baja la velocidad para verlo entrar.',
  golpear: 'Pasa el cursor por el objeto y haz clic para dar un mazazo. En plastilina deja la marca.',
};

const estado = {
  objeto: null, material: null, herramienta: 'agarrar', plastilina: false, verMalla: false,
  firmeza: 0.5, amortiguacion: 0.075, velocidad: 1, restitucion: 0,
};
const SUBPASOS = 10;
const LIMITE_PLASTICO = 0.01;

let datos = null, body = null, malla = null, lineas = null, extra = null;
let materialDiana = null;
const cache = new Map();
const balas = [];

// Rango de compliance de aristas por objeto (exponentes de 10). La firmeza 0 queda justo por encima
// de donde cada forma deja de sostenerse: el rey y las letras pandean por debajo de 1e-4.
// Plastilina: rígida bajo su propio peso (rigidez medida por objeto: más blanda se escurre, más dura se
// levanta entera al tirar), límite elástico del 1 % para que no recupere y amortiguación alta para que no tiemble.
function parametros() {
  const obj = OBJETOS[estado.objeto];
  if (estado.objeto === 'diana') return { edgeCompliance: DIANA_COMPLIANCE, volCompliance: 1e-9, damping: 1, restitution: 0 };
  if (estado.plastilina) return { edgeCompliance: Math.pow(10, -obj.plastilina), volCompliance: 1e-9, damping: 20, restitution: 0 };
  const [blanda, dura] = obj.rango;
  return {
    edgeCompliance: Math.pow(10, -(blanda + (dura - blanda) * estado.firmeza)),
    volCompliance: 1e-9,   // con volumen rígido la malla queda sobrerrestringida y vibra en cámara lenta
    damping: estado.amortiguacion * 10,
    restitution: estado.restitucion,
  };
}

function crearCuerpo() {
  golpe = null;
  captura = null;
  maza.visible = false;
  body = new SoftBody(datos.mesh, { pinned: datos.forma.pinned });
  if (lineas) { scene.remove(lineas); lineas.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(body.pos), 3));
  g.setIndex(new THREE.BufferAttribute(body.edges, 1));
  lineas = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#1c1c1c', transparent: true, opacity: 0.35, depthTest: false }));
  lineas.frustumCulled = false;
  lineas.renderOrder = 2;
  lineas.visible = estado.verMalla;
  scene.add(lineas);
  if (estado.objeto === 'diana' && texDiana) pintarDiana();
  for (const b of balas) scene.remove(b.mesh);
  balas.length = 0;
}

function marcoDiana() {
  const grupo = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.5 });
  const L = DIANA_L, a = 0.08, f = 0.26;
  const pieza = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; grupo.add(m);
  };
  pieza(2 * L + 2 * a, a, f, 0, DIANA_Y + L + a / 2, 0);
  pieza(2 * L + 2 * a, a, f, 0, DIANA_Y - L - a / 2, 0);
  pieza(a, 2 * L, f, -L - a / 2, DIANA_Y, 0);
  pieza(a, 2 * L, f, L + a / 2, DIANA_Y, 0);
  const alto = DIANA_Y - L - a;
  pieza(0.06, alto, 0.06, -0.6, alto / 2, 0);
  pieza(0.06, alto, 0.06, 0.6, alto / 2, 0);
  pieza(1.6, 0.03, 0.5, 0, 0.015, 0);
  return grupo;
}

function aplicarMaterial(clave) {
  estado.material = clave;
  if (!malla) return;
  if (malla.material !== materialDiana) malla.material.dispose();
  if (estado.objeto === 'diana') {
    materialDiana ??= new THREE.MeshStandardMaterial({ map: pintarDiana(), roughness: 0.85, alphaTest: 0.5 });
    malla.material = materialDiana;
  } else {
    const p = { ...MATERIALES[clave].p };
    for (const k of ['color', 'attenuationColor']) if (p[k]) p[k] = new THREE.Color(p[k]);
    malla.material = new THREE.MeshPhysicalMaterial(p);
  }
  const diana = estado.objeto === 'diana', fisica = diana ? null : MATERIALES[clave].fisica;
  estado.plastilina = !diana && !!MATERIALES[clave].plastico;
  estado.restitucion = fisica ? fisica.restitucion : 0;
  ponerDeslizador('firmeza', diana ? OBJETOS.diana.firmeza : fisica.firmeza ?? estado.firmeza);
  if (fisica && !estado.plastilina) ponerDeslizador('amortiguacion', fisica.amortiguacion);
  document.getElementById('firmeza').disabled = estado.plastilina;
  document.getElementById('amortiguacion').disabled = estado.plastilina || diana;
  document.querySelectorAll('#materiales button').forEach(b => {
    b.classList.toggle('activo', b.dataset.mat === clave && estado.objeto !== 'diana');
    b.disabled = estado.objeto === 'diana';
  });
}

let construyendo = false;
async function ponerObjeto(clave, texto) {
  if (construyendo) return;
  construyendo = true;
  try {
    const def = OBJETOS[clave];
    let d = clave === 'letras' ? null : cache.get(clave);
    if (!d) {
      d = construir(await def.forma(texto));
      if (clave !== 'letras') cache.set(clave, d);
    }
    soltar();
    datos = d;
    estado.objeto = clave;
    if (malla) { scene.remove(malla); malla.geometry.dispose(); }
    if (extra) { scene.remove(extra); extra = null; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.surf.pos.slice(), 3));
    geo.setIndex(new THREE.BufferAttribute(d.surf.idx, 1));
    if (d.forma.uv) {
      const uv = new Float32Array(d.surf.pos.length / 3 * 2);
      for (let i = 0; i < uv.length / 2; i++) {
        const [u, v] = d.forma.uv(d.surf.pos[3 * i], d.surf.pos[3 * i + 1]);
        uv[2 * i] = u; uv[2 * i + 1] = v;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    geo.computeVertexNormals();
    malla = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial());
    malla.castShadow = true;
    malla.frustumCulled = false;
    scene.add(malla);
    if (clave === 'diana') { extra = marcoDiana(); scene.add(extra); }

    crearCuerpo();
    aplicarMaterial(def.material ?? estado.material ?? 'goma');
    camera.position.set(...def.cam);
    controls.target.set(...def.mira);
    controls.update();

    document.querySelectorAll('#objetos button').forEach(b => b.classList.toggle('activo', b.dataset.obj === clave));
    document.getElementById('form-texto').hidden = clave !== 'letras';
    document.querySelectorAll('[data-tool="agarrar"], [data-tool="golpear"]').forEach(x => x.disabled = clave === 'diana');
    elegirHerramienta(clave === 'diana' ? 'disparar' : estado.herramienta);
    document.getElementById('impacto').hidden = clave !== 'diana';
    document.querySelector('#impacto .valor').textContent = '-';
  } finally {
    construyendo = false;
  }
}

function actualizarVisual() {
  const P = body.pos, T = body.tets, { tid, bary } = datos.emb;
  const attr = malla.geometry.attributes.position, out = attr.array;
  for (let v = 0; v < tid.length; v++) {
    const t = 4 * tid[v], b1 = bary[3 * v], b2 = bary[3 * v + 1], b3 = bary[3 * v + 2], b0 = 1 - b1 - b2 - b3;
    const i0 = 3 * T[t], i1 = 3 * T[t + 1], i2 = 3 * T[t + 2], i3 = 3 * T[t + 3];
    for (let c = 0; c < 3; c++) out[3 * v + c] = b0 * P[i0 + c] + b1 * P[i1 + c] + b2 * P[i2 + c] + b3 * P[i3 + c];
  }
  attr.needsUpdate = true;
  malla.geometry.computeVertexNormals();
  if (lineas.visible) { lineas.geometry.attributes.position.array.set(P); lineas.geometry.attributes.position.needsUpdate = true; }
}

// ---------- Interacción ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmp = new THREE.Vector3();
let agarre = null, pulsacion = null;

function rayoDesde(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

function tocarObjeto(e) {
  rayoDesde(e);
  malla.geometry.computeBoundingSphere();
  malla.geometry.computeBoundingBox();
  return raycaster.intersectObject(malla, false)[0] ?? null;
}

function empezarAgarre(punto, pointerId) {
  const P = body.pos, R = datos.forma.cell * 1.6, ids = [];
  let cerca = -1, dmin = Infinity;
  for (let i = 0; i < body.n; i++) {
    if (body.invMass0[i] === 0) continue;
    const d = Math.hypot(P[3 * i] - punto.x, P[3 * i + 1] - punto.y, P[3 * i + 2] - punto.z);
    if (d < R) ids.push(i);
    if (d < dmin) { dmin = d; cerca = i; }
  }
  if (!ids.length && cerca >= 0) ids.push(cerca);
  if (!ids.length) return;
  const off = new Float32Array(ids.length * 3);
  ids.forEach((i, k) => {
    off[3 * k] = P[3 * i] - punto.x; off[3 * k + 1] = P[3 * i + 1] - punto.y; off[3 * k + 2] = P[3 * i + 2] - punto.z;
    body.invMass[i] = 0;
  });
  const plano = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmp).negate(), punto);
  body.grab = { ids: Int32Array.from(ids), off, target: [punto.x, punto.y, punto.z] };
  agarre = { plano, pointerId };
}

function soltar() {
  if (body?.grab) for (const i of body.grab.ids) body.invMass[i] = body.invMass0[i];
  if (body) body.grab = null;
  agarre = null;
  controls.enabled = true;
}

// Balín de 4,5 mm (en la escala de la diana, 1 unidad = 100 mm). Contra la gelatina, el rey y las letras
// empuja partículas con un radio mayor, la cavidad que abre, porque las partículas están a 10 cm.
// Contra la diana va por rayo sobre la superficie, a la velocidad real de un aire comprimido.
const R_BALIN = 0.0225, R_CAVIDAD = 0.085;
const geoBalin = new THREE.SphereGeometry(R_BALIN, 20, 14);

function disparar(e) {
  const rayo = rayoDesde(e), diana = estado.objeto === 'diana';
  const mesh = new THREE.Mesh(geoBalin, materialBalin);
  mesh.castShadow = true;
  const x = rayo.origin.clone().addScaledVector(rayo.direction, 0.3), v = rayo.direction.clone().multiplyScalar(diana ? 150 : 35);
  balas.push({ x: [x.x, x.y, x.z], v: [v.x, v.y, v.z], r: R_CAVIDAD, m: 6, edad: 0, mesh, porRayo: diana, fuera: false });
  mesh.position.copy(x);
  scene.add(mesh);
}

// Vuelo de los balines de la diana: tramo recto del frame y rayo contra la superficie deformada.
const segmento = new THREE.Vector3(), origen = new THREE.Vector3();
function volarContraDiana(b, t) {
  if (b.atrapado) return;
  b.v[1] += GRAV * t;
  origen.set(...b.x);
  segmento.set(b.v[0] * t, b.v[1] * t, b.v[2] * t);
  const largo = segmento.length();
  b.x[0] += segmento.x; b.x[1] += segmento.y; b.x[2] += segmento.z;
  if (b.x[1] < R_BALIN) { b.x[1] = R_BALIN; b.v[1] = Math.abs(b.v[1]) * 0.3; b.v[0] *= 0.7; b.v[2] *= 0.7; }
  if (b.fuera || largo === 0) return;
  malla.geometry.computeBoundingSphere();
  raycaster.set(origen, segmento.divideScalar(largo));
  raycaster.far = largo;
  const hit = raycaster.intersectObject(malla, false)[0];
  raycaster.far = Infinity;
  if (hit) impactoDiana(b, hit, segmento.clone());
}

// En la diana la firmeza no cambia la cartulina sino lo que hace con el balín:
//   < 0,1: lo atraviesa limpio.  0,1 a 0,85: lo atrapa, se estira y se rompe antes cuanto más blanda.
//   ≥ 0,85: lo atrapa, se estira y lo devuelve hacia atrás (cuanto más firme, menos se estira).
// Mientras lo tiene atrapado, el parche del impacto sigue un recorrido guiado con ritmo de dibujo animado:
// sale frenando mientras el balín empuja, se queda tenso un momento y vuelve de golpe. El resto de la
// cartulina se simula alrededor (el embudo). Al soltarlo, el parche conserva su velocidad y la cartulina vibra.
const DIANA_COMPLIANCE = 10 ** -3.5, DIANA_PARCHE = 0.45;
const ESTIRON_MAX = 1.2, ESTIRON_SALIDA = 0.35, ESTIRON_TENSO = 0.12, ESTIRON_VUELTA = 0.12;   // m y s de simulación
let captura = null;

function impactoDiana(b, hit, dir) {
  const pos = malla.geometry.attributes.position, rest = datos.surf.pos, f = hit.face;
  const tri = new THREE.Triangle(
    new THREE.Vector3().fromBufferAttribute(pos, f.a), new THREE.Vector3().fromBufferAttribute(pos, f.b), new THREE.Vector3().fromBufferAttribute(pos, f.c));
  const bc = tri.getBarycoord(hit.point, new THREE.Vector3());
  const rx = bc.x * rest[3 * f.a] + bc.y * rest[3 * f.b] + bc.z * rest[3 * f.c];
  const ry = bc.x * rest[3 * f.a + 1] + bc.y * rest[3 * f.b + 1] + bc.z * rest[3 * f.c + 1];
  const rz = bc.x * rest[3 * f.a + 2] + bc.y * rest[3 * f.b + 2] + bc.z * rest[3 * f.c + 2];
  const u = (rx + DIANA_L) / (2 * DIANA_L), v = (ry - DIANA_Y + DIANA_L) / (2 * DIANA_L);
  if (u <= 0 || u >= 1 || v <= 0 || v >= 1 || hayAgujero(u, v)) return;   // pasa por un agujero ya hecho
  b.fuera = true;
  const firmeza = estado.firmeza;

  if (firmeza < 0.1 || captura) {
    perforarDiana(u, v);
    empujarParche(hit.point, dir, 2);
    b.v = b.v.map(c => c * 0.9);
    b.x = [hit.point.x + dir.x * 0.3, hit.point.y + dir.y * 0.3, hit.point.z + dir.z * 0.3];
  } else {
    capturar(b, hit.point, dir, firmeza, u, v);
  }

  if (rz > 0) {
    const s = puntuacion(Math.hypot(rx, ry - DIANA_Y) * 100);
    document.querySelector('#impacto .valor').textContent = s === null ? 'fuera' : s.toFixed(1);
  }
}

function empujarParche(punto, dir, vel) {
  const P = body.pos;
  for (let i = 0; i < body.n; i++) {
    if (body.invMass[i] === 0) continue;
    const d = Math.hypot(P[3 * i] - punto.x, P[3 * i + 1] - punto.y, P[3 * i + 2] - punto.z);
    if (d >= DIANA_PARCHE) continue;
    const w = vel * (1 - d / DIANA_PARCHE) ** 2;
    body.vel[3 * i] += dir.x * w; body.vel[3 * i + 1] += dir.y * w; body.vel[3 * i + 2] += dir.z * w;
  }
}

function capturar(b, punto, dir, firmeza, u, v) {
  const P = body.pos, ids = [], w = [], base = [];
  for (let i = 0; i < body.n; i++) {
    if (body.invMass0[i] === 0) continue;
    const d = Math.hypot(P[3 * i] - punto.x, P[3 * i + 1] - punto.y, P[3 * i + 2] - punto.z);
    if (d >= DIANA_PARCHE) continue;
    ids.push(i); w.push(0.5 + 0.5 * Math.cos(Math.PI * d / DIANA_PARCHE)); base.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    body.invMass[i] = 0;
  }
  if (!ids.length) return;
  const devuelve = firmeza >= 0.85;
  // Cerca del marco no cabe tanto estirón: se limita por la distancia al borde sujeto.
  const alBorde = DIANA_L - Math.max(Math.abs(punto.x), Math.abs(punto.y - DIANA_Y));
  const tope = Math.min(ESTIRON_MAX, Math.max(0.15, 1.6 * alBorde));
  const A = devuelve ? tope * (1 - (firmeza - 0.85) / 0.15 * 0.25) : tope;
  body.kin = { ids: Int32Array.from(ids), w: Float64Array.from(w), base: Float64Array.from(base), dir: [dir.x, dir.y, dir.z], x: 0 };
  captura = {
    b, A, t: 0, u, v, dir: dir.clone(),
    inicio: punto.clone().addScaledVector(dir, -R_BALIN),
    rotura: devuelve ? Infinity : 0.05 + (firmeza - 0.1) / 0.75 * (A - 0.1),
  };
  b.atrapado = true;
}

function liberarParche(vel) {
  const k = body.kin;
  for (let j = 0; j < k.ids.length; j++) {
    const i = k.ids[j];
    body.invMass[i] = body.invMass0[i];
    for (let c = 0; c < 3; c++) body.vel[3 * i + c] = k.dir[c] * vel * k.w[j];
  }
  body.kin = null;
}

// Recorrido del estirón: [profundidad, velocidad] en el instante t.
function estiron(A, t) {
  const t1 = ESTIRON_SALIDA, t2 = t1 + ESTIRON_TENSO;
  if (t < t1) { const u = t / t1; return [A * (1 - (1 - u) ** 2), 2 * A * (1 - u) / t1]; }   // sale frenando
  if (t < t2) return [A, 0];                                                                 // tenso
  const u = Math.min(1, (t - t2) / ESTIRON_VUELTA);
  return [A * (1 - u * u), -2 * A * u / ESTIRON_VUELTA];                                     // vuelve de golpe
}

// Avanza el estirón un subpaso; tras el subpaso, decide si se rompe o si devuelve el balín.
function avanzarCaptura(dt) {
  captura.t += dt;
  body.kin.x = estiron(captura.A, captura.t)[0];
}
function resolverCaptura() {
  const c = captura, [x, vel] = estiron(c.A, c.t), b = c.b;
  b.x = [c.inicio.x + c.dir.x * x, c.inicio.y + c.dir.y * x, c.inicio.z + c.dir.z * x];
  if (x >= c.rotura && vel > 0) {
    perforarDiana(c.u, c.v);
    liberarParche(vel);
    const sigue = Math.max(3, vel);
    b.v = [c.dir.x * sigue, c.dir.y * sigue, c.dir.z * sigue];
  } else if (c.t >= ESTIRON_SALIDA + ESTIRON_TENSO + ESTIRON_VUELTA) {
    liberarParche(vel);
    b.v = [c.dir.x * vel, c.dir.y * vel, c.dir.z * vel];   // vel < 0: sale hacia atrás
  } else return;
  b.atrapado = false;
  captura = null;
}

const materialBalin = new THREE.MeshStandardMaterial({ color: '#8d9096', metalness: 1, roughness: 0.35 });

// ---------- Maza ----------
// Mazo de goma: la cabeza es un colisionador cinemático (masa infinita) que baja acelerando, se hunde
// un poco más allá de la superficie y vuelve. Su recorrido va en tiempo de simulación (la cámara lenta lo frena).
const MAZA_R = 0.13, MAZA_L = 0.32, MAZA_ALTURA = 0.45, MAZA_HUNDE = 0.12;
const MAZA_BAJADA = 0.09, MAZA_PAUSA = 0.04, MAZA_SUBIDA = 0.25;
const maza = new THREE.Group();
{
  const cabeza = new THREE.Mesh(new THREE.CylinderGeometry(MAZA_R, MAZA_R, MAZA_L, 32), new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.55 }));
  cabeza.position.y = -MAZA_L / 2;
  const mango = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.75, 16), new THREE.MeshStandardMaterial({ color: '#b39064', roughness: 0.7 }));
  mango.rotation.z = Math.PI / 2;
  mango.position.set(0.375 + MAZA_R * 0.5, -MAZA_L / 2, 0);
  for (const m of [cabeza, mango]) { m.castShadow = true; maza.add(m); }
  maza.visible = false;
  scene.add(maza);
}
let golpe = null;   // { p: punto de impacto, a: sentido del golpe, t: tiempo de simulación }
const ejeX = new THREE.Vector3(), ejeZ = new THREE.Vector3(), base = new THREE.Matrix4();

function sentidoGolpe(hit, rayo) {
  const n = hit.face.normal;
  const a = rayo.direction.clone();
  if (n.dot(a) < 0) a.sub(n);
  return a.normalize();
}

// Orienta la maza: su +Y es el sentido del golpe y el mango sale hacia la derecha de la cámara.
function colocarMaza(cara, a) {
  ejeX.setFromMatrixColumn(camera.matrixWorld, 0).addScaledVector(a, -ejeX.dot(a));
  if (ejeX.lengthSq() < 1e-6) ejeX.set(1, 0, 0).addScaledVector(a, -a.x);
  ejeX.normalize();
  ejeZ.crossVectors(ejeX, a);
  base.makeBasis(ejeX, a, ejeZ);
  maza.quaternion.setFromRotationMatrix(base);
  maza.position.copy(cara);
  maza.visible = true;
}

// Distancia de la cara al punto de impacto a lo largo del golpe (negativa = todavía delante).
function recorridoMaza(t) {
  const total = MAZA_ALTURA + MAZA_HUNDE, t1 = MAZA_BAJADA, t2 = t1 + MAZA_PAUSA, t3 = t2 + MAZA_SUBIDA;
  if (t < t1) return -MAZA_ALTURA + total * (t / t1) ** 2;
  if (t < t2) return MAZA_HUNDE;
  if (t < t3) { const u = (t - t2) / MAZA_SUBIDA; return MAZA_HUNDE - total * u * (2 - u); }
  return null;
}

function empezarGolpe(e) {
  const hit = tocarObjeto(e);
  if (!hit || golpe) return false;
  golpe = { p: hit.point.clone(), a: sentidoGolpe(hit, raycaster.ray), t: 0 };
  colocarMaza(golpe.p.clone().addScaledVector(golpe.a, -MAZA_ALTURA), golpe.a);
  return true;
}

function mazaSobre(e) {
  if (golpe) return;
  const hit = tocarObjeto(e);
  if (!hit) { maza.visible = false; return; }
  const a = sentidoGolpe(hit, raycaster.ray);
  colocarMaza(hit.point.clone().addScaledVector(a, -MAZA_ALTURA), a);
}

// Captura en window: decide antes que OrbitControls si el gesto es agarrar o girar la cámara.
window.addEventListener('pointerdown', e => {
  if (e.target !== canvas || !malla || e.button !== 0) return;
  pulsacion = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  if (estado.herramienta === 'golpear') { if (empezarGolpe(e)) controls.enabled = false; return; }
  if (estado.herramienta !== 'agarrar' || agarre) return;
  const hit = tocarObjeto(e);
  if (!hit) return;
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  empezarAgarre(hit.point, e.pointerId);
}, true);

window.addEventListener('pointermove', e => {
  if (estado.herramienta === 'golpear' && e.target === canvas && malla) mazaSobre(e);
  if (!agarre || e.pointerId !== agarre.pointerId) return;
  if (rayoDesde(e).intersectPlane(agarre.plano, tmp)) body.grab.target = [tmp.x, tmp.y, tmp.z];
});

function finPulsacion(e) {
  if (agarre && e.pointerId === agarre.pointerId) soltar();
  else if (e.type === 'pointerup' && estado.herramienta === 'disparar' && pulsacion?.id === e.pointerId &&
    Math.hypot(e.clientX - pulsacion.x, e.clientY - pulsacion.y) < 8 && performance.now() - pulsacion.t < 400) disparar(e);
  if (pulsacion?.id === e.pointerId) pulsacion = null;
  if (!agarre) controls.enabled = true;
}
window.addEventListener('pointerup', finPulsacion);
window.addEventListener('pointercancel', finPulsacion);

function empujon() {
  const ang = Math.random() * Math.PI * 2, vx = Math.cos(ang) * 1.5, vz = Math.sin(ang) * 1.5, w = (Math.random() - 0.5) * 4;
  let cx = 0, cz = 0;
  for (let i = 0; i < body.n; i++) { cx += body.pos[3 * i]; cz += body.pos[3 * i + 2]; }
  cx /= body.n; cz /= body.n;
  for (let i = 0; i < body.n; i++) {
    if (body.invMass[i] === 0) continue;
    const i3 = 3 * i;
    body.vel[i3] += vx - w * (body.pos[i3 + 2] - cz);
    body.vel[i3 + 1] += 3.5;
    body.vel[i3 + 2] += vz + w * (body.pos[i3] - cx);
  }
}

// ---------- Panel ----------

const materialesEl = document.getElementById('materiales');
for (const [clave, m] of Object.entries(MATERIALES)) {
  const b = document.createElement('button');
  b.textContent = m.nombre; b.dataset.mat = clave;
  b.addEventListener('click', () => aplicarMaterial(clave));
  materialesEl.append(b);
}
document.querySelectorAll('#objetos button').forEach(b => b.addEventListener('click', () =>
  ponerObjeto(b.dataset.obj, limpiarTexto(document.getElementById('texto').value))));
document.getElementById('form-texto').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('texto');
  input.value = limpiarTexto(input.value);
  ponerObjeto('letras', input.value);
});
function elegirHerramienta(tool) {
  estado.herramienta = tool;
  if (tool !== 'golpear') maza.visible = false;
  document.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('activo', x.dataset.tool === tool));
  document.getElementById('pista').textContent = estado.objeto === 'diana' ? PISTA_DIANA : PISTAS[tool];
}
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => elegirHerramienta(b.dataset.tool)));
const formatos = {
  firmeza: v => Math.round(v * 100) + '%',
  amortiguacion: v => Math.round(v * 100) + '%',
  velocidad: v => '×' + v.toFixed(2),
};
for (const id of Object.keys(formatos)) {
  const input = document.getElementById(id), out = input.nextElementSibling;
  const leer = () => { estado[id] = parseFloat(input.value); out.textContent = formatos[id](estado[id]); };
  input.addEventListener('input', leer); leer();
}
function interruptor(id, clave, alCambiar) {
  const b = document.getElementById(id);
  b.addEventListener('click', () => {
    estado[clave] = !estado[clave];
    b.setAttribute('aria-pressed', String(estado[clave]));
    alCambiar?.();
  });
}
interruptor('malla', 'verMalla', () => { if (lineas) lineas.visible = estado.verMalla; });
document.getElementById('empujon').addEventListener('click', () => body && empujon());
document.getElementById('reiniciar').addEventListener('click', () => { if (body) { soltar(); crearCuerpo(); } });
document.getElementById('plegar').addEventListener('click', e => {
  const p = document.getElementById('panel');
  p.classList.toggle('plegado');
  e.currentTarget.textContent = p.classList.contains('plegado') ? '▴' : '▾';
});
document.getElementById('pista').textContent = PISTAS.agarrar;

// ---------- Bucle ----------

function redimensionar() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', redimensionar);
redimensionar();

const reloj = new THREE.Clock();
let ultimaLectura = 0;
const lectura = {
  masa: document.getElementById('l-masa'), vol: document.getElementById('l-vol'), ec: document.getElementById('l-ec'),
};

renderer.setAnimationLoop(() => {
  const fdt = Math.min(reloj.getDelta(), 1 / 30);
  if (body) {
    const t = fdt * estado.velocidad, P = parametros();
    const enCuerpo = balas.filter(b => !b.porRayo);
    const sub = Math.min(40, enCuerpo.reduce((n, b) => Math.max(n, Math.ceil(Math.hypot(...b.v) * t / (0.25 * b.r))), SUBPASOS));  // más subpasos con un balín en vuelo, si no atraviesa
    for (let s = 0; s < sub; s++) {
      let mazo = null;
      if (golpe) {
        golpe.t += t / sub;
        const d = recorridoMaza(golpe.t);
        if (d === null) golpe = null;
        else {
          const c = golpe.p.clone().addScaledVector(golpe.a, d);
          mazo = { c: [c.x, c.y, c.z], a: [golpe.a.x, golpe.a.y, golpe.a.z], r: MAZA_R, l: MAZA_L };
          maza.position.copy(c);
        }
      }
      if (captura) avanzarCaptura(t / sub);
      body.substep(t / sub, P, enCuerpo, mazo);
      if (captura) resolverCaptura();
    }
    for (const b of balas) if (b.porRayo) volarContraDiana(b, t);
    if (estado.plastilina) {
      body.plastify(LIMITE_PLASTICO);
      body.selfCollide(0.9 * datos.forma.cell, 0.75 * datos.forma.cell);
    }
    for (let i = balas.length - 1; i >= 0; i--) {
      const b = balas[i];
      b.edad += fdt;
      b.mesh.position.set(...b.x);
      if (b.edad > 6 || Math.hypot(...b.x) > 30) { scene.remove(b.mesh); balas.splice(i, 1); }
    }
    actualizarVisual();
    const ahora = performance.now();
    if (ahora - ultimaLectura > 250) {
      ultimaLectura = ahora;
      const s = body.stats();
      lectura.masa.textContent = s.masa.toFixed(0) + ' kg';
      lectura.vol.textContent = (s.volumen * 100).toFixed(1) + ' %';
      lectura.ec.textContent = s.ke.toFixed(1) + ' J';
    }
  }
  controls.update();
  renderer.render(scene, camera);
});

ponerObjeto('gelatina');
