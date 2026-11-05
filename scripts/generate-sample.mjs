// Generates the bundled sample dataset and starter project in samples/.
// The data is fictional and generated from a fixed seed, so the output is identical on every run.
//   node scripts/generate-sample.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
mkdirSync(out, { recursive: true });

// Mulberry32: small, deterministic PRNG.
let seed = 20261105;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};
const round2 = (x) => Math.round(x * 100) / 100;
const csv = (rows) =>
  rows
    .map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '')).join(','))
    .join('\n') + '\n';
const iso = (d) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ customers
const syllables = ['ar', 'bel', 'cor', 'dan', 'el', 'fen', 'gal', 'hol', 'is', 'jor', 'kel', 'lin', 'mor', 'nel', 'or', 'pra', 'quin', 'ros', 'sel', 'tor', 'ul', 'ven', 'wil', 'yar', 'zen'];
const word = (n) => {
  let w = '';
  for (let i = 0; i < n; i++) w += pick(syllables);
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const cities = [
  ['Northwick', 'North'],
  ['Brightmoor', 'North'],
  ['Halden Falls', 'North'],
  ['Southport Bay', 'South'],
  ['Marlow Springs', 'South'],
  ['Redcliff', 'South'],
  ['Eastvale', 'East'],
  ['Ashby Cross', 'East'],
  ['Kingsreach', 'East'],
  ['Westmere', 'West'],
  ['Copperton', 'West'],
  ['Lakeshire', 'West'],
  ['Midfield', 'Central'],
  ['Stonebridge', 'Central']
];
const customers = [['customer_id', 'customer_name', 'segment', 'city', 'region', 'signup_date']];
const customerList = [];
const usedNames = new Set();
for (let i = 1; i <= 800; i++) {
  const [city, region] = pick(cities);
  const segment = weighted([
    ['Consumer', 5],
    ['Small Business', 3],
    ['Enterprise', 1.2]
  ]);
  let name;
  do name = segment === 'Consumer' ? `${word(2)} ${word(2)}` : `${word(2)} ${pick(['Works', 'Supply', 'Studio', 'Labs', 'Partners', 'Trading', 'Group'])}`;
  while (usedNames.has(name));
  usedNames.add(name);
  const signup = new Date(Date.UTC(2021, 0, 1) + Math.floor(rand() * 1400) * 864e5);
  const id = `C${String(i).padStart(4, '0')}`;
  customers.push([id, name, segment, city, region, iso(signup)]);
  customerList.push({ id, segment, region, weight: segment === 'Enterprise' ? 4 : segment === 'Small Business' ? 2 : 1 });
}

// ------------------------------------------------------------------ products
const catalog = {
  Furniture: { Chairs: [120, 480], Desks: [180, 900], Shelving: [60, 300], Lighting: [25, 220] },
  'Office Supplies': { Paper: [4, 30], Binders: [3, 25], Pens: [2, 18], Storage: [12, 90] },
  Technology: { Monitors: [140, 650], Keyboards: [20, 160], Headsets: [30, 240], Printers: [90, 520] },
  Outdoor: { Planters: [15, 120], Grills: [140, 700], Tents: [70, 400] }
};
const products = [['product_id', 'product_name', 'category', 'subcategory', 'list_price', 'unit_cost']];
const productList = [];
let pid = 1;
for (const [category, subs] of Object.entries(catalog)) {
  for (const [sub, [lo, hi]] of Object.entries(subs)) {
    const n = 6 + Math.floor(rand() * 6);
    for (let k = 0; k < n; k++) {
      const price = round2(lo + rand() * (hi - lo));
      const margin = category === 'Technology' ? 0.18 + rand() * 0.15 : category === 'Furniture' ? 0.1 + rand() * 0.2 : 0.3 + rand() * 0.25;
      const id = `P${String(pid++).padStart(3, '0')}`;
      const name = `${word(2)} ${sub.replace(/s$/, '')} ${pick(['Pro', 'Lite', 'Max', 'One', 'Plus', 'Classic', 'Air', 'S', 'X'])}`;
      products.push([id, name, category, sub, price, round2(price * (1 - margin))]);
      productList.push({ id, category, price, cost: round2(price * (1 - margin)) });
    }
  }
}

// ------------------------------------------------------------------ orders
const orders = [['order_id', 'line', 'order_date', 'ship_date', 'customer_id', 'product_id', 'channel', 'quantity', 'unit_price', 'discount', 'sales', 'profit']];
const start = Date.UTC(2023, 0, 1);
const days = 365 * 3;
const totalWeight = customerList.reduce((s, c) => s + c.weight, 0);
const pickCustomer = () => {
  let r = rand() * totalWeight;
  for (const c of customerList) if ((r -= c.weight) <= 0) return c;
  return customerList[0];
};
let orderId = 100000;
let lines = 0;
while (lines < 24000) {
  // Growth over time plus a seasonal peak in November and December.
  const day = Math.floor(Math.pow(rand(), 0.7) * days);
  const date = new Date(start + day * 864e5);
  const month = date.getUTCMonth();
  const season = month >= 10 ? 1.6 : month === 0 ? 0.7 : 1;
  if (rand() > season / 1.6) continue;
  const customer = pickCustomer();
  const nLines = 1 + Math.floor(rand() * (customer.segment === 'Enterprise' ? 5 : 3));
  const channel = weighted([
    ['Online', 6],
    ['Store', 3],
    ['Phone', 1]
  ]);
  const ship = new Date(date.getTime() + (1 + Math.floor(rand() * (channel === 'Store' ? 1 : 7))) * 864e5);
  orderId++;
  for (let l = 1; l <= nLines; l++) {
    const p = pick(productList);
    const qty = 1 + Math.floor(rand() * (customer.segment === 'Enterprise' ? 12 : 4));
    const discount = weighted([
      [0, 6],
      [0.05, 2],
      [0.1, 1.5],
      [0.2, 0.8],
      [0.4, 0.2]
    ]);
    const sales = round2(qty * p.price * (1 - discount));
    const profit = round2(sales - qty * p.cost);
    orders.push([orderId, l, iso(date), iso(ship), customer.id, p.id, channel, qty, p.price, discount, sales, profit]);
    lines++;
  }
}

writeFileSync(join(out, 'orders.csv'), csv(orders));
writeFileSync(join(out, 'customers.csv'), csv(customers));
writeFileSync(join(out, 'products.csv'), csv(products));

// ------------------------------------------------------------------ starter project
const col = (name, type, sourceType) => ({ name, sourceType, type });
const T = { o: 'orders', c: 'customers', p: 'products' };
const tables = [
  {
    id: T.o,
    name: 'Orders',
    source: { path: 'orders.csv', format: 'csv' },
    rowCount: orders.length - 1,
    columns: [
      col('order_id', 'integer', 'BIGINT'),
      col('line', 'integer', 'BIGINT'),
      col('order_date', 'date', 'DATE'),
      col('ship_date', 'date', 'DATE'),
      col('customer_id', 'string', 'VARCHAR'),
      col('product_id', 'string', 'VARCHAR'),
      col('channel', 'string', 'VARCHAR'),
      col('quantity', 'integer', 'BIGINT'),
      col('unit_price', 'number', 'DOUBLE'),
      col('discount', 'number', 'DOUBLE'),
      col('sales', 'number', 'DOUBLE'),
      col('profit', 'number', 'DOUBLE')
    ]
  },
  {
    id: T.c,
    name: 'Customers',
    source: { path: 'customers.csv', format: 'csv' },
    rowCount: customers.length - 1,
    columns: [
      col('customer_id', 'string', 'VARCHAR'),
      col('customer_name', 'string', 'VARCHAR'),
      col('segment', 'string', 'VARCHAR'),
      col('city', 'string', 'VARCHAR'),
      col('region', 'string', 'VARCHAR'),
      col('signup_date', 'date', 'DATE')
    ]
  },
  {
    id: T.p,
    name: 'Products',
    source: { path: 'products.csv', format: 'csv' },
    rowCount: products.length - 1,
    columns: [
      col('product_id', 'string', 'VARCHAR'),
      col('product_name', 'string', 'VARCHAR'),
      col('category', 'string', 'VARCHAR'),
      col('subcategory', 'string', 'VARCHAR'),
      col('list_price', 'number', 'DOUBLE'),
      col('unit_cost', 'number', 'DOUBLE')
    ]
  }
];
const f = (table, column) => ({ kind: 'column', table, column });
const calc = (id) => ({ kind: 'calc', id });
let n = 0;
const dim = (field, extra = {}) => ({ id: `i${++n}`, field, role: 'dimension', ...extra });
const meas = (field, agg, extra = {}) => ({ id: `i${++n}`, field, role: 'measure', ...(agg ? { agg } : {}), ...extra });
const usd = { style: 'currency', currency: 'USD', decimals: 0 };
const spec = (s) => ({ chartType: 'auto', columns: [], rows: [], tooltip: [], filters: [], ...s });

const salesByMonthY = meas(f(T.o, 'sales'), 'SUM', { format: usd });
const salesByCat = meas(f(T.o, 'sales'), 'SUM', { format: usd });
const topCustSales = meas(f(T.o, 'sales'), 'SUM', { format: usd });
const worksheets = [
  {
    id: 'kpis',
    name: 'Headline numbers',
    spec: spec({
      chartType: 'kpi',
      rows: [meas(f(T.o, 'sales'), 'SUM', { format: { style: 'currency', currency: 'USD', decimals: 0 } }), meas(f(T.o, 'order_id'), 'COUNTD'), meas(calc('profit_ratio'), undefined, { format: { style: 'percent', decimals: 1 } })]
    })
  },
  {
    id: 'trend',
    name: 'Sales by month',
    spec: spec({ chartType: 'line', columns: [dim(f(T.o, 'order_date'), { dateLevel: 'month' })], rows: [salesByMonthY], tooltip: [meas(f(T.o, 'profit'), 'SUM', { format: usd })] })
  },
  {
    id: 'category',
    name: 'Sales by category',
    spec: spec({ chartType: 'bar', columns: [dim(f(T.p, 'category'))], rows: [salesByCat], color: dim(f(T.c, 'segment')), sort: undefined })
  },
  {
    id: 'segment',
    name: 'Sales by segment',
    spec: spec({ chartType: 'donut', color: dim(f(T.c, 'segment')), rows: [meas(f(T.o, 'sales'), 'SUM', { format: usd })] })
  },
  {
    id: 'ratio',
    name: 'Profit ratio by region',
    spec: (() => {
      const m = meas(calc('profit_ratio'), undefined, { format: { style: 'percent', decimals: 1 } });
      return spec({ chartType: 'bar', columns: [dim(f(T.c, 'region'))], rows: [m], sort: { itemId: m.id, dir: 'desc' } });
    })()
  },
  {
    id: 'heat',
    name: 'Subcategory by region',
    spec: spec({ chartType: 'heatmap', columns: [dim(f(T.c, 'region'))], rows: [dim(f(T.p, 'subcategory'))], color: meas(f(T.o, 'profit'), 'SUM', { format: { style: 'compact' } }) })
  },
  {
    id: 'top',
    name: 'Top 10 customers',
    spec: spec({
      chartType: 'table',
      rows: [dim(f(T.c, 'customer_name')), dim(f(T.c, 'segment')), topCustSales, meas(calc('customer_share'), undefined, { format: { style: 'percent', decimals: 2 } })],
      filters: [{ id: 'top10', kind: 'topN', field: f(T.c, 'customer_name'), n: 10, by: { field: f(T.o, 'sales'), agg: 'SUM' }, direction: 'top' }],
      sort: { itemId: topCustSales.id, dir: 'desc' }
    })
  },
  {
    id: 'custvalue',
    name: 'Average customer value',
    spec: spec({ chartType: 'bar', rows: [dim(f(T.c, 'segment'))], columns: [meas(calc('avg_customer_value'), undefined, { format: usd })] })
  },
  {
    id: 'running',
    name: 'Running total by quarter',
    spec: spec({ chartType: 'area', columns: [dim(f(T.o, 'order_date'), { dateLevel: 'quarter' })], rows: [meas(calc('running_sales'), undefined, { format: { style: 'compact' } })] })
  }
];

const calcs = [
  { id: 'profit_ratio', name: 'Profit Ratio', formula: 'SUM([profit]) / SUM([sales])' },
  { id: 'avg_customer_value', name: 'Average Customer Value', formula: '// Sales per customer, then averaged for each mark\nAVG({INCLUDE [Orders].[customer_id] : SUM([sales])})' },
  { id: 'customer_share', name: 'Share of All Sales', formula: 'SUM([sales]) / MIN({FIXED : SUM([sales])})' },
  { id: 'running_sales', name: 'Running Sales', formula: 'RUNNING_SUM(SUM([sales]))' },
  { id: 'order_size', name: 'Order Size', formula: 'IF [quantity] >= 10 THEN "Bulk" ELSEIF [quantity] >= 4 THEN "Medium" ELSE "Single" END' },
  { id: 'days_to_ship', name: 'Days to Ship', formula: "DATEDIFF('day', [order_date], [ship_date])" }
];

const tile = (id, kind, layout, extra) => ({ id, kind, layout, ...extra });
const project = {
  formatVersion: 1,
  name: 'Sample: Harbor & Pine sales',
  model: {
    tables,
    relationships: [
      { id: 'r_cust', fromTable: T.o, fromColumn: 'customer_id', toTable: T.c, toColumn: 'customer_id', cardinality: 'many-to-one' },
      { id: 'r_prod', fromTable: T.o, fromColumn: 'product_id', toTable: T.p, toColumn: 'product_id', cardinality: 'many-to-one' }
    ],
    calcs
  },
  worksheets,
  dashboards: [
    {
      id: 'overview',
      name: 'Sales overview',
      pages: [
        {
          id: 'p_overview',
          name: 'Overview',
          tiles: [
            tile('t_title', 'text', { x: 0, y: 0, w: 9, h: 2 }, {
              text: '# Harbor & Pine Supply Co.\nFictional sales data, 2023 to 2025. Click a bar, slice or point to cross-filter the page; clear it with the chip at the top.'
            }),
            tile('t_kpi', 'worksheet', { x: 0, y: 2, w: 9, h: 3 }, { worksheetId: 'kpis' }),
            tile('t_region', 'slicer', { x: 9, y: 0, w: 3, h: 5 }, { field: f(T.c, 'region'), slicerType: 'list', title: 'Region' }),
            tile('t_trend', 'worksheet', { x: 0, y: 5, w: 8, h: 6 }, { worksheetId: 'trend' }),
            tile('t_dates', 'slicer', { x: 8, y: 5, w: 4, h: 3 }, { field: f(T.o, 'order_date'), slicerType: 'dateRange', title: 'Order date' }),
            tile('t_segment', 'worksheet', { x: 8, y: 8, w: 4, h: 6 }, { worksheetId: 'segment' }),
            tile('t_cat', 'worksheet', { x: 0, y: 11, w: 8, h: 6 }, { worksheetId: 'category' })
          ]
        },
        {
          id: 'p_customers',
          name: 'Customers',
          tiles: [
            tile('t_top', 'worksheet', { x: 0, y: 0, w: 6, h: 8 }, { worksheetId: 'top' }),
            tile('t_value', 'worksheet', { x: 6, y: 0, w: 6, h: 4 }, { worksheetId: 'custvalue' }),
            tile('t_ratio', 'worksheet', { x: 6, y: 4, w: 6, h: 4 }, { worksheetId: 'ratio' }),
            tile('t_heat', 'worksheet', { x: 0, y: 8, w: 12, h: 10 }, { worksheetId: 'heat' })
          ]
        }
      ]
    }
  ]
};
writeFileSync(join(out, 'sample.facet'), JSON.stringify(project, null, 2) + '\n');
console.log(`orders: ${orders.length - 1} rows, customers: ${customers.length - 1}, products: ${products.length - 1}`);
