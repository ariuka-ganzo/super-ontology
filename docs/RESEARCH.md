# Research: what Power BI and Tableau do, and what an open-source desktop version can do

Researched 2026-11-05. Prices come from third-party sites, not vendor price lists, so treat them as approximate.

## Summary

Both products are the same four layers: connect to data, model it, build visuals by dragging fields, and arrange them into an interactive dashboard. Those layers can be built well with open-source parts today, mainly DuckDB for the engine and Apache ECharts for charts.

What cannot be matched in a first version is the ecosystem: hundreds of connectors, the DAX and Power Query languages, cloud sharing and governance. Super Ontology therefore targets one person analysing local files on their own computer, on any OS, for free.

## Side by side

| | Power BI Desktop | Tableau Desktop |
|---|---|---|
| Authoring cost | Desktop is free; Pro is about $14/user/month for sharing | Needs a Creator licence, about $75/user/month billed annually |
| Platforms | Windows only for authoring | Windows and macOS |
| Engine | In-memory tabular engine (VertiPaq) | Hyper extracts or live queries |
| Query model | Semantic model, measures evaluated in filter context | VizQL turns drag-and-drop into database queries |
| Formula language | DAX | Calculated fields and LOD expressions |
| Data preparation | Power Query (M) | Tableau Prep (separate tool) |
| Authoring style | Canvas of visuals, each with its own field wells | Worksheets with shelves, then composed into dashboards |
| Open file formats | PBIP is plain text with publicly documented parts | `.twb` workbook; `.twbx`, `.tdsx` are zip packages |
| Common complaints | Steep DAX learning curve, confusing licensing, Windows-only | Cost, steep calculated-field and LOD learning curve |

## What to take from each

**From Tableau**
- Shelves (columns, rows, color, size, label, filter) as the core interaction, because they map directly to a query.
- A "Show Me" style chart recommendation.
- A fixed, explainable query pipeline. Tableau documents this order: data source filters, context filters, FIXED LOD expressions, dimension filters, then table calculations.
- LOD syntax: `{ FIXED | INCLUDE | EXCLUDE <dims> : <aggregate> }`. This covers most cases that make DAX hard, and each form translates to SQL.

**From Power BI**
- Multi-page report canvas with slicers and click-to-cross-filter.
- Star-schema relationships, so users pick fields rather than writing joins.
- Reusable named measures.
- A project format of plain text files that works with Git. Microsoft's PBIP documentation lists text-editor support, folder transparency and source control as its benefits.

## Possibilities and limits

| Capability | Feasible in open source? | Decision |
|---|---|---|
| Fast analytics on millions of rows locally | Yes, DuckDB | v0.1 |
| CSV, Parquet, JSON, Excel files | Yes | v0.1 |
| Drag-and-drop chart building | Yes | v0.1 |
| Formula language with LOD-style expressions | Yes, compile to SQL | v0.1 |
| Dashboards, slicers, cross-filtering | Yes | v0.1 |
| Live Postgres, MySQL, SQLite | Yes, DuckDB extensions | v0.2 |
| Data preparation steps (Power Query-like) | Yes, as an ordered list compiled to SQL views | v0.2 |
| Maps | Yes, ECharts plus bundled open boundary data | v0.3 |
| Importing PBIP or `.twb` layouts | Partly. PBIP is documented but some files are not (`report.json`, `mobileState.json`, `semanticModelDiagramLayout.json`, `diagramLayout.json`) | Later, best effort |
| Importing `.pbix` or `.hyper` data | Not reliably. Microsoft states PBIX to PBIP conversion can only be done through Power BI Desktop | Not planned |
| Full DAX or M compatibility | Very large effort, and it would chase a moving target | Not planned |
| Cloud sharing, row-level security, governance | Different product (server) | Not planned for desktop |

## Open-source tools already in this space

Metabase and Apache Superset are server-hosted web apps. Rill and Evidence are BI-as-code tools that work with DuckDB, but the sources reviewed do not describe them as packaged desktop apps. No source reviewed showed a drag-and-drop desktop-first tool, which is the gap Super Ontology aims at. This was a light survey rather than an exhaustive one, so check again before making public claims about being the only one.

## Legal guardrails

- Clean-room only: copy ideas and workflows, not code, icons, artwork or documentation text.
- Do not use "Power BI" or "Tableau" in the product name or logo. Mentioning them to describe compatibility or comparison is fine.
- Do not reverse-engineer proprietary formats or binaries. Only implement formats with public documentation, and check each vendor's licence terms before starting any importer.

## Sources

- [Power BI October 2026 update](https://learn.microsoft.com/en-us/power-bi/fundamentals/desktop-latest-update)
- [Power BI Desktop projects (PBIP)](https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-overview)
- [Tableau LOD expressions](https://help.tableau.com/current/pro/desktop/en-us/calculations_calculatedfields_lod.htm)
- [Tableau order of operations](https://help.tableau.com/current/pro/desktop/en-us/order_of_operations.htm)
- [Tableau file types](https://help.tableau.com/current/pro/desktop/en-us/environ_filesandfolders.htm)
- [Power BI review 2026 (third party)](https://datatoolindex.pages.dev/tools/power-bi/)
- [Power BI review (third party)](https://www.knowi.com/blog/the-ultimate-power-bi-review/)
- [Tableau Desktop pricing guide (third party)](https://querio.ai/blogs/tableau-desktop-pricing)
- [Tableau pricing 2026 (third party)](https://www.knowi.com/blog/tableau-pricing-2026/)
- [DuckDB-based BI-as-code tools (MotherDuck)](https://motherduck.com/videos/the-future-of-bi-exploring-the-impact-of-bi-as-code-tools-with-duckdb/)
- [Open-source alternatives to Power BI (directory)](https://openapps.pro/alternative/open-source-alternatives-to-power-bi)
- [Open-source alternatives to Tableau (directory)](https://openapps.pro/alternative/open-source-alternatives-to-tableau)
- [DuckDB Node "neo" client docs](https://scriptagc.wasmer.app/https_duckdb_org/docs/1_1/api/node_neo/overview_html)
