# Super Ontology architecture and v0.1 spec

Super Ontology is a free, open-source desktop app for exploring local data and building interactive dashboards. See [RESEARCH.md](RESEARCH.md) for the reasoning behind this scope.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron + electron-builder | Works on Windows, macOS and Linux with no Rust toolchain |
| UI | React + TypeScript + Vite | Standard, well supported |
| Engine | DuckDB via `@duckdb/node-api`, in the main process | Fast columnar analytics, reads files directly, no 4 GB WASM limit |
| Charts | Apache ECharts | Apache-2.0, handles large data, wide chart range |
| Drag and drop | dnd-kit | Shelves and fields pane |
| Dashboard layout | react-grid-layout | Resizable tiles |
| Tests | Vitest, Playwright for Electron | Unit tests and end-to-end |

Check before relying on them: current DuckDB platform support, how its native binary packages with electron-builder (it must be unpacked from the asar), and Excel reading. Excel must work offline, so do not depend on downloading a DuckDB extension at runtime. Bundle the extension or parse with a maintained npm library, and check that library for known vulnerabilities.

## Process layout

```
Renderer (React, sandboxed)
   |  typed IPC through a preload allowlist
Main process
   |-- engine/      DuckDB connection, import, query execution, cancellation
   |-- project/     load and save .ontology projects
Shared (pure TypeScript, no Electron imports, fully unit tested)
   |-- formula/     parser and type checker for the formula language
   |-- compiler/    VizSpec + Model -> SQL
   |-- recommend/   chart recommendation
```

## Query pipeline

The compiler is the heart of the app. It turns a `VizSpec` into one SQL statement, applying steps in this documented order:

1. Data source filters
2. Joins from model relationships, including only tables the query needs
3. Context filters
4. FIXED expressions
5. Dimension filters, slicers and cross-filters
6. Aggregation at the level of detail set by the shelves
7. Measure filters (HAVING)
8. Table calculations (window functions), then sort and row limit

Every identifier must be quoted and every value bound as a parameter. Never build SQL from user text by concatenation, and only let formula text reach SQL through the parser.

## Formula language

An original language with Tableau-like readability. It is not DAX compatible.

- Aggregates: `SUM AVG MIN MAX COUNT COUNTD MEDIAN`
- Logic: `IF/ELSEIF/ELSE/END`, `CASE`, `AND OR NOT`, `ISNULL`, `IFNULL`
- Text: `LEFT RIGHT UPPER LOWER TRIM CONTAINS REPLACE`
- Date: `YEAR QUARTER MONTH DAY DATETRUNC DATEADD DATEDIFF TODAY`
- Maths: `ABS ROUND FLOOR CEIL`, arithmetic, safe division that returns null on zero
- LOD: `{FIXED [Region] : SUM([Sales])}`, `{INCLUDE ...}`, `{EXCLUDE ...}`
- Table calculations: `RUNNING_SUM`, `PERCENT_OF_TOTAL`, `RANK`, `LAG`

Errors show the position and a plain-language message. Saved formulas are either calculated columns (row level) or measures (aggregate).

## v0.1 features

**Data**
- Import CSV, TSV, Parquet, JSON and Excel by file dialog or drag and drop
- Preview, inferred types with manual override, column profile (nulls, distinct count, min and max, histogram)
- Reload from the source file, with a clear message when the file is missing or its columns changed

**Model**
- Several tables per project
- Relationships with suggested matches by name and type, with cardinality detection
- Warn when a many-to-many join would multiply rows

**Worksheet**
- Fields pane split into dimensions and measures
- Shelves: columns, rows, color, size, label, tooltip, filter
- Charts: bar, stacked bar, line, area, scatter, pie and donut, heatmap, table, pivot table, KPI card
- Chart recommendation based on the fields selected
- Date drill levels, sort, top N, number formats, undo and redo
- Results over the limit are truncated with a visible notice, never silently

**Dashboard**
- Multi-page grid canvas with worksheet tiles, text, and slicers (list, date range, numeric range)
- Click a mark to cross-filter the page, and clear it with a visible control
- Light and dark themes

**Export**
- Chart to PNG, data to CSV, dashboard page to PDF

**Sample data**
- A bundled, generated (fictional) sales dataset and starter dashboard, so the app shows something useful on first launch

## Project file

A `.ontology` file is pretty-printed JSON with a `formatVersion`, so projects diff well in Git. It stores data source paths relative to the project where possible, plus model, formulas, worksheets and dashboards. Data is not embedded in v0.1. Unknown future versions must be refused with a clear message and never overwritten. Saves are atomic (temp file, then rename).

## Security and privacy

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict Content Security Policy
- The preload exposes only named functions. The main process validates every IPC payload.
- Renderer never sends raw SQL in v0.1, except a clearly read-only SQL view if one is added later
- Lock DuckDB down where possible: disable external access beyond files the user chose, and no extension auto-install
- Treat data values and file names as untrusted when rendering (ECharts tooltips can render HTML, so escape them)
- No telemetry and no network calls. Everything stays on the user's computer.

## Quality targets

- 1 million row CSV: import and first chart in under 5 seconds on a typical laptop. Measure this and report the real number.
- Long queries can be cancelled and never freeze the window
- Compiler and formula unit tests assert generated SQL and run it against real DuckDB to compare results to hand-calculated values

## Repository layout

```
src/main/  src/preload/  src/renderer/  src/shared/
tests/unit/  tests/e2e/
samples/  docs/
.github/workflows/   ci.yml (lint, typecheck, test), release.yml (installers on tag)
```

## Releases

GitHub Actions builds a Windows NSIS installer, a macOS dmg and a Linux AppImage on version tags. Installers are unsigned at first, so document the Windows SmartScreen and macOS Gatekeeper warnings in the README.

## Implementation notes (v0.1)

Decisions made while building v0.1, where the spec above left room:

- **Two DuckDB instances.** DuckDB cannot widen `allowed_paths` once external access is disabled, so the engine uses two instances. The query instance holds the data and runs compiled queries with `enable_external_access = false` and `lock_configuration = true`. A reader instance runs only fixed import statements (`read_csv`, `read_parquet`, `read_json_auto`) with the user-chosen path bound as a parameter, and streams data chunks into the query instance through an appender. Neither instance installs or loads extensions; Parquet and JSON readers are built in.
- **Excel** is read with `read-excel-file` (MIT, no known advisories at the time of writing), written to a temporary CSV and imported like any CSV, so types are inferred the same way. Only the sheet being imported is parsed; sheet names come from `xl/workbook.xml` alone (unzipped with `fflate`, MIT). No DuckDB extension is downloaded.
- **Top N filters** follow Tableau's order: they rank rows that passed context filters, at the same step as the worksheet's other dimension filters, and the results are intersected. "Top 5 products in the East" therefore needs the region filter marked as a context filter. Dashboard slicers and cross-filters cannot be marked as context, so they apply before Top N ranking.
- **INCLUDE and EXCLUDE** are computed after dimension filters. An aggregate over them is computed at the expression's grain (`lg` CTE), joined to the view's distinct marks (`lk`), then aggregated to the view (`la`). One aggregate cannot mix expressions with different dimensions.
- **Table calculations** address the dimension named by the worksheet's `calcAlong` setting, or by default the first dimension on Columns, then Rows, then Color, and partition by every other dimension in the view.
- **Slicer value lists** are queried with the page's other slicers and the cross-filter applied, but not the slicer's own selection. Selected values that drop out stay listed as "no data" so they can be cleared.
- **Many-to-many and one-to-many joins** are reported as compiler warnings and shown above the chart. The join root is the largest table the view uses, which is usually the fact table.
- **Chart rendering** uses the ECharts SVG renderer up to 3,000 marks (crisp output and individually addressable marks for testing) and the canvas renderer above that. PNG export always renders an offscreen canvas copy.
- **Packaging** unpacks `node_modules/@duckdb/**` from the asar and leaves out the musl build. `--smoke-test` loads the packaged DuckDB binary, imports the bundled sample and exits, which CI runs on Windows, macOS and Linux.

## Out of scope for v0.1

Live database connectors, data preparation steps, maps, importing other vendors' files, DAX or M compatibility, sharing server, row-level security, AI features.
