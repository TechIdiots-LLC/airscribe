/**
 * Mapbox Vector Tiles, read: just enough of the format (protobuf, spec 2.1) to take the line features and their
 * properties out of chosen layers, in longitude and latitude. Used for Findings' roads, from the same OpenMapTiles
 * tiles the Map draws (docs/findings.md#roads).
 */

/** A protobuf reader over a buffer: varints, and the length-delimited fields MVT nests. */
class Pbf {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  varint() {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('the tile ends in the middle of a number');
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  }

  /** @returns {[number, number]} The next field's number and wire type. */
  tag() {
    const t = this.varint();
    return [Math.floor(t / 8), t & 7];
  }

  /** @returns {Pbf} A reader over the next length-delimited field. */
  sub() {
    const len = this.varint();
    const s = new Pbf(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  string() {
    const len = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  /** @returns {number[]} A packed field of varints. */
  packed() {
    const s = this.sub();
    const out = [];
    while (s.pos < s.end) out.push(s.varint());
    return out;
  }

  skip(type) {
    if (type === 0) this.varint();
    else if (type === 1) this.pos += 8;
    else if (type === 2) this.pos += this.varint();
    else if (type === 5) this.pos += 4;
    else throw new Error(`the tile has a field of an unknown kind (${type})`);
  }
}

const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function value(p) {
  let v = null;
  while (p.pos < p.end) {
    const [f, t] = p.tag();
    if (f === 1) v = p.string();
    else if (f === 2) (v = p.buf.readFloatLE(p.pos), p.pos += 4);
    else if (f === 3) (v = p.buf.readDoubleLE(p.pos), p.pos += 8);
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) v = zigzag(p.varint());
    else if (f === 7) v = Boolean(p.varint());
    else p.skip(t);
  }
  return v;
}

/** A feature's geometry commands as lines of [x, y] in tile units. */
function lines(cmds) {
  const out = [];
  let x = 0;
  let y = 0;
  let cur = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) continue;   // ClosePath: a polygon's, not a line's
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]);
      y += zigzag(cmds[i++]);
      if (id === 1) out.push((cur = [[x, y]]));
      else cur?.push([x, y]);
    }
  }
  return out;
}

/**
 * The line features of some layers of a tile, in longitude and latitude.
 * @param {Buffer} buf - The tile, uncompressed.
 * @param {{z: number, x: number, y: number}} at - Which tile (xyz).
 * @param {string[]} want - The layers.
 * @returns {{layer: string, props: object, lines: number[][][]}[]} Each feature, [[lon, lat], ...] a line.
 */
export function lineFeatures(buf, { z, x, y }, want) {
  const out = [];
  const n = 2 ** z;
  const tile = new Pbf(buf);
  while (tile.pos < tile.end) {
    const [f, t] = tile.tag();
    if (f !== 3) {
      tile.skip(t);
      continue;
    }
    const l = tile.sub();
    let name = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const feats = [];
    while (l.pos < l.end) {
      const [lf, lt] = l.tag();
      if (lf === 1) name = l.string();
      else if (lf === 2) feats.push(l.sub());
      else if (lf === 3) keys.push(l.string());
      else if (lf === 4) values.push(value(l.sub()));
      else if (lf === 5) extent = l.varint();
      else l.skip(lt);
    }
    if (!want.includes(name)) continue;
    const lon = (px) => ((x + px / extent) / n) * 360 - 180;
    const lat = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
    for (const fp of feats) {
      let type = 0;
      let tags = [];
      let geom = [];
      while (fp.pos < fp.end) {
        const [ff, ft] = fp.tag();
        if (ff === 2) tags = fp.packed();
        else if (ff === 3) type = fp.varint();
        else if (ff === 4) geom = fp.packed();
        else fp.skip(ft);
      }
      if (type !== 2) continue;   // lines only
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      out.push({ layer: name, props, lines: lines(geom).map((l) => l.map(([px, py]) => [lon(px), lat(py)])) });
    }
  }
  return out;
}

/** @returns {{x: number, y: number}} The xyz tile a place falls in at zoom z. */
export function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return {
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    y: Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n))),
  };
}
