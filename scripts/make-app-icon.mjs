// Generates the iOS app icon from the same mascot the app draws.
//
//   node scripts/make-app-icon.mjs
//
// The silhouette is read out of src/components/CursorAvatar.tsx rather than
// copied, so the icon cannot drift from the thing it depicts. If the artwork
// changes, re-run this and commit the PNG.
//
// Everything here is by hand — the bezier flattening, the scanline fill, the
// PNG encoder — because the alternative is a build-time image dependency in a
// project that has none, for one file that changes about never. zlib is in
// Node; a PNG is a header, a filtered scanline block, and a CRC.
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "ios", "App", "Assets.xcassets", "AppIcon.appiconset");

const SIZE = 1024;
/** Supersampling factor. 4 is plenty at this size and keeps it under a second. */
const SS = 4;
/** How much of the icon the mascot occupies. Apple rounds the corners hard, so
 *  art that reaches the edge loses its extremities. */
const INSET = 0.19;

// The app is dark, and a bot is green by default — so: the green mascot on
// near-black, which is what the roster looks like.
const BACKGROUND = [0x0e, 0x0e, 0x10];
const BASE = [0x00, 0x99, 0x57]; // MAUS_COLORS.green

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// matches gradientFor() in src/components/Avatar.tsx
const STOPS = [
  { at: 0, color: mix(BASE, [255, 255, 255], 0.55) },
  { at: 0.55, color: BASE },
  { at: 1, color: mix(BASE, [0, 0, 0], 0.42) },
];

/** The mascot path, straight out of the component the desktop renders. */
function silhouette() {
  const source = readFileSync(join(ROOT, "src", "components", "CursorAvatar.tsx"), "utf8");
  const shape = source.slice(source.indexOf("export const SHAPE"));
  const match = shape.match(/d=\\"([^"\\]+)/);
  if (!match) throw new Error("could not find the mascot path in CursorAvatar.tsx");
  return match[1];
}

/** Absolute M/C/Z into polygons of straight segments. */
function flatten(d, steps = 24) {
  const tokens = d.match(/[MCZmcz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const polygons = [];
  let current = [];
  let cursor = [0, 0];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i];
    if (command === "M") {
      if (current.length > 2) polygons.push(current);
      cursor = [Number(tokens[i + 1]), Number(tokens[i + 2])];
      current = [cursor];
      i += 3;
    } else if (command === "C") {
      i += 1;
      while (i + 5 < tokens.length && !Number.isNaN(Number(tokens[i]))) {
        const p = [cursor, [+tokens[i], +tokens[i + 1]], [+tokens[i + 2], +tokens[i + 3]], [+tokens[i + 4], +tokens[i + 5]]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          current.push([
            u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
            u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
          ]);
        }
        cursor = p[3];
        i += 6;
      }
    } else {
      if (command === "Z" || command === "z") {
        if (current.length > 2) polygons.push(current);
        current = [];
      }
      i += 1;
    }
  }
  if (current.length > 2) polygons.push(current);
  return polygons;
}

/** Nonzero winding, which is what SVG fills with by default. */
function makeCoverage(polygons, width) {
  const edges = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[1] !== b[1]) edges.push([a, b]);
    }
  }
  const inside = new Uint8Array(width * width);
  for (let y = 0; y < width; y++) {
    const sy = y + 0.5;
    const crossings = [];
    for (const [a, b] of edges) {
      const [x0, y0] = a;
      const [x1, y1] = b;
      if (sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
      const t = (sy - y0) / (y1 - y0);
      crossings.push({ x: x0 + t * (x1 - x0), dir: y1 > y0 ? 1 : -1 });
    }
    if (!crossings.length) continue;
    crossings.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let c = 0; c < crossings.length - 1; c++) {
      winding += crossings[c].dir;
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(crossings[c].x - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[c + 1].x - 0.5));
      for (let x = from; x <= to; x++) inside[y * width + x] = 1;
    }
  }
  return inside;
}

function gradientAt(t) {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (t <= b.at) return mix(a.color, b.color, (t - a.at) / (b.at - a.at));
  }
  return STOPS[STOPS.length - 1].color;
}

function encodePng(rgb, size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha — the App Store rejects an icon with one
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ── draw ───────────────────────────────────────────────────────────────
const big = SIZE * SS;
const polygons = flatten(silhouette());

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const poly of polygons) {
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}
const artWidth = maxX - minX;
const artHeight = maxY - minY;
const usable = big * (1 - 2 * INSET);
const scale = Math.min(usable / artWidth, usable / artHeight);
const offsetX = (big - artWidth * scale) / 2 - minX * scale;
const offsetY = (big - artHeight * scale) / 2 - minY * scale;
const placed = polygons.map((poly) => poly.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]));

const bodyMask = makeCoverage(placed, big);

// Eyes at the desktop's face anchor, as a fraction of the silhouette's box.
const shapeLeft = offsetX + minX * scale;
const shapeTop = offsetY + minY * scale;
const boxW = artWidth * scale;
const boxH = artHeight * scale;
const eyeW = boxW * 0.085;
const eyeH = eyeW * 1.7;
const gap = eyeW * 1.9;
const eyeCx = shapeLeft + boxW * 0.407;
const eyeCy = shapeTop + boxH * 0.442;
const eyes = [-gap / 2, gap / 2].map((dx) => {
  const cx = eyeCx + dx;
  const r = eyeW / 2;
  const pts = [];
  for (let a = 0; a < 64; a++) {
    const theta = (a / 64) * Math.PI * 2;
    pts.push([cx + Math.cos(theta) * r, eyeCy + Math.sin(theta) * (eyeH / 2)]);
  }
  return pts;
});
const eyeMask = makeCoverage(eyes, big);

// downsample the two masks into the final image
const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let body = 0;
    let eye = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const index = (y * SS + sy) * big + (x * SS + sx);
        body += bodyMask[index];
        eye += eyeMask[index];
      }
    }
    const samples = SS * SS;
    const t = ((1 - x / SIZE) + y / SIZE) / 2; // top-right → bottom-left
    const fill = gradientAt(t);
    let pixel = BACKGROUND.map((c, i) => c + (fill[i] - c) * (body / samples));
    pixel = pixel.map((c, i) => c + (255 - c) * (eye / samples));
    const at = (y * SIZE + x) * 3;
    rgb[at] = Math.round(pixel[0]);
    rgb[at + 1] = Math.round(pixel[1]);
    rgb[at + 2] = Math.round(pixel[2]);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "icon-1024.png"), encodePng(rgb, SIZE));
writeFileSync(
  join(OUT_DIR, "Contents.json"),
  JSON.stringify(
    {
      images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${SIZE}×${SIZE} icon to ios/App/Assets.xcassets/AppIcon.appiconset/`);
