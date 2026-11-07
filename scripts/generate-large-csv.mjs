// Writes a large fictional CSV for performance testing.
//   node scripts/generate-large-csv.mjs <path> [rows=1000000]
import { createWriteStream } from 'node:fs';

const [path, rowsArg] = process.argv.slice(2);
if (!path) {
  console.error('usage: node scripts/generate-large-csv.mjs <path> [rows]');
  process.exit(1);
}
const rows = Number(rowsArg ?? 1_000_000);
let seed = 1;
const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const regions = ['North', 'South', 'East', 'West', 'Central'];
const cats = ['Furniture', 'Office', 'Tech', 'Garden'];
const out = createWriteStream(path);
out.write('order_id,order_date,region,category,product,quantity,sales,profit\n');
let buf = '';
for (let i = 1; i <= rows; i++) {
  const d = new Date(Date.UTC(2022, 0, 1) + Math.floor(r() * 1095) * 864e5).toISOString().slice(0, 10);
  buf += `${i},${d},${regions[Math.floor(r() * 5)]},${cats[Math.floor(r() * 4)]},P-${Math.floor(r() * 500)},${1 + Math.floor(r() * 9)},${(r() * 1000).toFixed(2)},${(r() * 200 - 50).toFixed(2)}\n`;
  if (i % 10000 === 0) {
    if (!out.write(buf)) await new Promise((res) => out.once('drain', res));
    buf = '';
  }
}
out.end(buf);
await new Promise((res) => out.on('finish', res));
console.log(`wrote ${rows} rows to ${path}`);
