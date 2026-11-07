import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const iconDir = resolve(root, "apps/studio/public/icons");
await mkdir(iconDir, { recursive: true });

const colors = {
  background: [16, 24, 33], roof: [24, 69, 81], left: [20, 53, 65],
  right: [27, 80, 90], edge: [104, 180, 180],
  accent: [128, 225, 207], white: [224, 248, 244],
};
const shapes = {
  roof: [[256, 111], [405, 197], [256, 282], [107, 197]],
  left: [[107, 197], [256, 282], [256, 416], [107, 330]],
  right: [[405, 197], [256, 282], [256, 416], [405, 330]],
};
const edges = [
  [256, 111, 405, 197], [405, 197, 256, 282], [256, 282, 107, 197],
  [107, 197, 256, 111], [107, 197, 107, 330], [107, 330, 256, 416],
  [256, 282, 256, 416], [405, 197, 405, 330], [405, 330, 256, 416],
];
const accentLines = [
  [205, 177, 307, 177, 13], [256, 177, 256, 230, 13],
  [145, 281, 210, 320, 6], [302, 320, 367, 281, 6],
  [176, 326, 256, 371, 5], [256, 371, 336, 326, 5],
];

function svg(maskable) {
  const scale = maskable ? 0.76 : 1;
  const poly = points => points.map(point => point.join(",")).join(" ");
  const strokes = edges.map(([x1,y1,x2,y2]) =>
    '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>').join("");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
    '<rect width="512" height="512" rx="110" fill="#101821"/>',
    '<g transform="translate(256 256) scale(' + scale + ') translate(-256 -256)">',
    '<polygon points="' + poly(shapes.left) + '" fill="#143541"/>',
    '<polygon points="' + poly(shapes.right) + '" fill="#1b505a"/>',
    '<polygon points="' + poly(shapes.roof) + '" fill="#184551"/>',
    '<g stroke="#68b4b4" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">' + strokes + '</g>',
    '<path d="M205 177H307M256 177V230" stroke="#e0f8f4" stroke-width="14" fill="none" stroke-linecap="round"/>',
    '<path d="M145 281L210 320M302 320L367 281M176 326L256 371L336 326" fill="none" stroke="#80e1cf" stroke-width="6" stroke-linecap="round"/>',
    '<g fill="#80e1cf"><circle cx="256" cy="111" r="14"/><circle cx="176" cy="326" r="11"/><circle cx="256" cy="371" r="11"/><circle cx="336" cy="326" r="11"/></g>',
    '</g></svg>',
  ].join("");
}

function rasterize(size, maskable = false) {
  const supersample = 2, width = size * supersample;
  const pixels = Buffer.alloc(width * width * 4);
  const factor = width / 512;
  const shrink = maskable ? 0.76 : 1;
  const point = ([x, y]) => [
    (256 + (x - 256) * shrink) * factor,
    (256 + (y - 256) * shrink) * factor,
  ];
  const paint = (x, y, color) => {
    const i = (y * width + x) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1];
    pixels[i + 2] = color[2]; pixels[i + 3] = 255;
  };
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    paint(x, y, colors.background);
  }
  const inside = (x, y, pts) => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) &&
          x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  const polygon = (vertices, color) => {
    const pts = vertices.map(point);
    const minX = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0]))));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...pts.map(p => p[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1]))));
    const maxY = Math.min(width - 1, Math.ceil(Math.max(...pts.map(p => p[1]))));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (inside(x + .5, y + .5, pts)) paint(x, y, color);
    }
  };
  const line = (x1, y1, x2, y2, thickness, color) => {
    const [ax, ay] = point([x1, y1]), [bx, by] = point([x2, y2]);
    const r = thickness * shrink * factor / 2;
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y < Math.min(width, Math.ceil(Math.max(ay, by) + r)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x < Math.min(width, Math.ceil(Math.max(ax, bx) + r)); x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
        if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 <= r * r) paint(x, y, color);
      }
    }
  };
  const circle = (cx, cy, radius, color) => {
    const [x0, y0] = point([cx,cy]), r = radius * shrink * factor;
    for (let y = Math.max(0, Math.floor(y0 - r)); y < Math.min(width, Math.ceil(y0 + r)); y++) {
      for (let x = Math.max(0, Math.floor(x0 - r)); x < Math.min(width, Math.ceil(x0 + r)); x++) {
        if ((x - x0) ** 2 + (y - y0) ** 2 <= r * r) paint(x, y, color);
      }
    }
  };
  polygon(shapes.left, colors.left);
  polygon(shapes.right, colors.right);
  polygon(shapes.roof, colors.roof);
  edges.forEach(args => line(...args, 10, colors.edge));
  line(205, 177, 307, 177, 14, colors.white);
  line(256, 177, 256, 230, 14, colors.white);
  accentLines.slice(2).forEach(args => line(...args, colors.accent));
  [[256,111,14], [176,326,11], [256,371,11], [336,326,11]].forEach(args => circle(...args, colors.accent));
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let channel = 0; channel < 4; channel++) {
      const at = (px,py) => pixels[(py * width + px) * 4 + channel];
      out[(y * size + x) * 4 + channel] = Math.round(
        (at(x*2,y*2)+at(x*2+1,y*2)+at(x*2,y*2+1)+at(x*2+1,y*2+1))/4);
    }
  }
  return out;
}

const crcTable = Array.from({length:256}, (_,n) => {
  let c=n; for(let i=0;i<8;i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngChunk(name, data) {
  const type = Buffer.from(name);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length,0); type.copy(out,4); data.copy(out,8);
  let crc = 0xffffffff;
  for(const byte of Buffer.concat([type,data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}
function encodePng(size, maskable) {
  const pixel = rasterize(size, maskable), stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for(let y=0;y<size;y++) pixel.copy(scanlines, y*(stride+1)+1, y*stride, (y+1)*stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size,0); header.writeUInt32BE(size,4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a","hex"),
    pngChunk("IHDR",header), pngChunk("IDAT",deflateSync(scanlines,{level:9})),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
await Promise.all([
  writeFile(resolve(iconDir,"icon.svg"),svg(false)),
  writeFile(resolve(iconDir,"icon-maskable.svg"),svg(true)),
  writeFile(resolve(iconDir,"icon-192.png"),encodePng(192,false)),
  writeFile(resolve(iconDir,"icon-512.png"),encodePng(512,false)),
  writeFile(resolve(iconDir,"icon-maskable-512.png"),encodePng(512,true)),
  writeFile(resolve(iconDir,"apple-touch-icon.png"),encodePng(180,true)),
  writeFile(resolve(root,"apps/studio/public/favicon.svg"),svg(false)),
]);
console.log("Generated Teldra Studio icon family (vector, 192/512, maskable, Apple).");
