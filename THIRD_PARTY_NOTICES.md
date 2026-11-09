# Third-party notices

Super Ontology is MIT licensed. Its installers include the open-source components below. Each keeps its own licence, and each licence permits redistribution in an MIT-licensed application. Full licence texts are in each package's folder under `node_modules` in the source tree. The DuckDB database extensions are separate files loaded at run time, built and published by the DuckDB project; their licences and those of the libraries inside them are listed in the DuckDB extension repositories (duckdb/duckdb-sqlite, duckdb/duckdb-postgres, duckdb/duckdb-mysql on GitHub).

| Component | Version | Licence | Used for |
|---|---|---|---|
| Electron (includes Chromium and Node.js) | 44.10.2 | MIT (Chromium and Node.js components under their own licences, listed in `LICENSES.chromium.html` next to the app) | Desktop shell |
| DuckDB (`@duckdb/node-api`, `@duckdb/node-bindings`) | 1.5.6 | MIT | Query engine |
| detect-libc | 2.1.2 | Apache-2.0 | Loading the right DuckDB binary on Linux |
| read-excel-file | 9.3.14 | MIT | Reading .xlsx files |
| fflate, saxen, unzipper-esm, worker-f, node-int64 | see lock file | MIT | Dependencies of read-excel-file |
| graceful-fs | 4.2.11 | ISC | Dependency of read-excel-file |
| zod | 4.6.7 | MIT | Validating IPC messages and project files |
| React, React DOM, scheduler | 19.2.0 | MIT | User interface |
| Apache ECharts | 6.1.0 | Apache-2.0 | Charts |
| ZRender | 6.1.0 | BSD-3-Clause | Rendering for ECharts |
| tslib | 2.9.1 | 0BSD | Dependency of ECharts |
| dnd-kit (core, utilities, accessibility) | 6.3.1 | MIT | Drag and drop |
| react-grid-layout, react-draggable, react-resizable | 1.5.2 | MIT | Dashboard layout |
| clsx, fast-equals, prop-types, resize-observer-polyfill | see lock file | MIT | Dependencies of react-grid-layout |
| zustand | 5.0.8 | MIT | Application state |
| sigma | 3.0.3 | MIT | Drawing the Explore graph with WebGL |
| graphology, graphology-utils | 0.26.0, see lock file | MIT | Graph data structure for Explore |
| graphology-layout-forceatlas2 | 0.10.1 | MIT | Explore graph layout |
| events | see lock file | MIT | Dependency of sigma and graphology |
| DuckDB extensions `sqlite_scanner`, `postgres_scanner`, `mysql_scanner` | 1.5.6 | MIT | Database connections. Official, signed builds from extensions.duckdb.org, shipped in `resources/duckdb-extensions` |
| SQLite (inside `sqlite_scanner`) | | Public domain | Reading SQLite files |
| libpq (inside `postgres_scanner`) | | PostgreSQL License | Connecting to PostgreSQL |
| MariaDB Connector/C (inside `mysql_scanner`) | | LGPL-2.1-or-later | Connecting to MySQL. Its source is available from mariadb.com and github.com/mariadb-corporation/mariadb-connector-c |
| OpenSSL (inside `postgres_scanner` and `mysql_scanner`) | | Apache-2.0 | Encrypted database connections |

## Apache ECharts NOTICE

```
Apache ECharts
Copyright 2017-2026 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## Development-only tools

Build and test tools (Vite, TypeScript, ESLint, Vitest, Playwright, electron-builder and their dependencies) are not shipped in the installers. Their licences are MIT, ISC, Apache-2.0, BSD, BlueOak-1.0.0, 0BSD, CC0, CC-BY-4.0 (browser data), Python-2.0 and WTFPL, all permissive.
