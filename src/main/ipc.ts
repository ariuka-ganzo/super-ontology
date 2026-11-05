import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createWriteStream, promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { OpenProjectResult } from '@shared/api';
import { modelSchema, projectSchema, queryRequestSchema, relationshipSchema, sourceSchema, tableSchema } from '@shared/schema';
import type { Project, SourceFormat, TableSource } from '@shared/types';
import { Engine, EngineError } from './engine/engine';
import { excelSheets } from './engine/excel';
import { loadProject, ProjectError, saveProject } from './project/project';
import { samplesDir } from './paths';

const EXT_FORMAT: Record<string, SourceFormat> = {
  '.csv': 'csv',
  '.txt': 'csv',
  '.tsv': 'tsv',
  '.tab': 'tsv',
  '.parquet': 'parquet',
  '.pq': 'parquet',
  '.json': 'json',
  '.jsonl': 'json',
  '.ndjson': 'json',
  '.xlsx': 'excel'
};

type Handler<S extends z.ZodType> = (args: z.infer<S>, event: IpcMainInvokeEvent) => Promise<unknown> | unknown;

export function formatForPath(path: string): SourceFormat | undefined {
  return EXT_FORMAT[extname(path).toLowerCase()];
}

/**
 * Registers an IPC handler. Every payload is validated against a schema, every call must come
 * from the app's own window, and errors come back as plain messages rather than exceptions.
 */
function handle<S extends z.ZodType>(channel: string, schema: S, fn: Handler<S>, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!isTrusted(event)) return { ok: false, error: 'Untrusted sender', code: 'invalid' };
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: `Invalid request to ${channel}: ${issue?.path.join('.')} ${issue?.message}`, code: 'invalid' };
    }
    try {
      return { ok: true, value: await fn(parsed.data, event) };
    } catch (e) {
      const code = e instanceof EngineError || e instanceof ProjectError ? e.code : 'failed';
      return { ok: false, error: e instanceof Error ? e.message : String(e), code };
    }
  });
}

const absPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => isAbsolute(p), 'must be an absolute path');

interface Settings {
  firstRunDone?: boolean;
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

async function writeSettings(s: Settings): Promise<void> {
  const file = join(app.getPath('userData'), 'settings.json');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(s, null, 2));
  await fs.rename(`${file}.tmp`, file);
}

export function registerIpc(engine: Engine, getWindow: () => BrowserWindow | null): void {
  const isTrusted = (e: IpcMainInvokeEvent): boolean => {
    const win = getWindow();
    return !!win && e.sender === win.webContents;
  };
  const h = <S extends z.ZodType>(channel: string, schema: S, fn: Handler<S>): void => handle(channel, schema, fn, isTrusted);
  const win = (): BrowserWindow => {
    const w = getWindow();
    if (!w) throw new Error('No window');
    return w;
  };

  h('data:choose', z.undefined(), async () => {
    const r = await dialog.showOpenDialog(win(), {
      title: 'Import data',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'tab', 'parquet', 'pq', 'json', 'jsonl', 'ndjson', 'xlsx'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return r.canceled ? [] : r.filePaths;
  });

  h('data:source', absPath, async (path) => {
    const format = formatForPath(path);
    if (!format) throw new EngineError(`${basename(path)} is not a supported file type. Use CSV, TSV, Parquet, JSON or Excel (.xlsx).`, 'invalid');
    const source: TableSource & { sheets?: string[] } = { path, format };
    if (format === 'excel') {
      try {
        source.sheets = await excelSheets(path);
      } catch (e) {
        throw new EngineError(`Could not read ${basename(path)}: ${(e as Error).message}`, 'invalid');
      }
      source.sheet = source.sheets[0];
    }
    return source;
  });

  h('data:import', z.object({ tableId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), source: sourceSchema.extend({ path: absPath }) }), ({ tableId, source }) =>
    engine.importTable(tableId, source)
  );
  h('data:drop', z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), (id) => engine.dropTable(id));
  h('data:preview', z.object({ table: tableSchema, limit: z.number().int().min(1).max(1000), offset: z.number().int().min(0) }), ({ table, limit, offset }) =>
    engine.preview(table, limit, offset)
  );
  h('data:profile', z.object({ table: tableSchema, column: z.string().max(512) }), ({ table, column }) => engine.profile(table, column));
  h('data:cardinality', z.object({ model: modelSchema, rel: relationshipSchema.omit({ id: true, cardinality: true }) }), ({ model, rel }) =>
    engine.cardinality(model, rel)
  );

  h('query:run', queryRequestSchema, (req) => engine.query(req));
  h('query:cancel', z.string().min(1).max(128), (id) => engine.cancel(id));

  const openFrom = async (path: string, asPath: string | null): Promise<OpenProjectResult> => {
    const project = await loadProject(path);
    const tableErrors: OpenProjectResult['tableErrors'] = [];
    const changed: OpenProjectResult['changed'] = [];
    for (const t of project.model.tables) {
      try {
        const r = await engine.importTable(t.id, t.source);
        const before = new Set(t.columns.map((c) => c.name));
        const after = new Set(r.columns.map((c) => c.name));
        const added = [...after].filter((c) => !before.has(c));
        const removed = [...before].filter((c) => !after.has(c));
        if (added.length || removed.length) changed.push({ tableId: t.id, added, removed });
        // Keep overrides for columns that still exist.
        t.columns = r.columns.map((c) => {
          const old = t.columns.find((o) => o.name === c.name);
          return old?.override ? { ...c, override: old.override } : c;
        });
        t.rowCount = r.rowCount;
      } catch (e) {
        tableErrors.push({ tableId: t.id, message: (e as Error).message });
      }
    }
    return { project, path: asPath, tableErrors, changed };
  };

  h('project:open', absPath.optional(), async (path) => {
    let file = path;
    if (!file) {
      const r = await dialog.showOpenDialog(win(), { title: 'Open project', properties: ['openFile'], filters: [{ name: 'Facet BI project', extensions: ['facet'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    return openFrom(file, file);
  });

  h('project:sample', z.undefined(), async () => {
    const s = await readSettings();
    if (!s.firstRunDone) await writeSettings({ ...s, firstRunDone: true });
    // The sample opens untitled, so saving asks for a new location instead of writing into the app folder.
    return openFrom(join(samplesDir(), 'sample.facet'), null);
  });

  h('project:save', z.object({ project: projectSchema, path: absPath.nullable(), saveAs: z.boolean() }), async ({ project, path, saveAs }) => {
    let file = path;
    if (!file || saveAs) {
      const r = await dialog.showSaveDialog(win(), {
        title: 'Save project',
        defaultPath: `${(project as Project).name || 'Untitled'}.facet`,
        filters: [{ name: 'Facet BI project', extensions: ['facet'] }]
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath.toLowerCase().endsWith('.facet') ? r.filePath : `${r.filePath}.facet`;
    }
    await saveProject(project as Project, file);
    return file;
  });

  // Characters that are not allowed in file names on Windows, plus control characters.
  const safeName = (n: string): string =>
    [...n].map((ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 120) || 'export';

  h('export:png', z.object({ dataUrl: z.string().max(60_000_000).startsWith('data:image/png;base64,'), name: z.string().max(200) }), async ({ dataUrl, name }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Export chart as PNG', defaultPath: `${safeName(name)}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    return r.filePath;
  });

  h('export:csv', z.object({ req: queryRequestSchema, name: z.string().max(200) }), async ({ req, name }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Export data as CSV', defaultPath: `${safeName(name)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const out = createWriteStream(r.filePath, { encoding: 'utf8' });
    try {
      out.write('﻿');
      for await (const chunk of engine.queryCsv(req)) if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
    } finally {
      await new Promise<void>((res) => out.end(() => res()));
    }
    return r.filePath;
  });

  h('export:pdf', z.object({ name: z.string().max(200) }), async ({ name }) => {
    const r = await dialog.showSaveDialog(win(), { title: 'Export page as PDF', defaultPath: `${safeName(name)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    const pdf = await win().webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4' });
    await fs.writeFile(r.filePath, pdf);
    return r.filePath;
  });

  h('app:startup', z.undefined(), async () => {
    const s = await readSettings();
    return { firstRun: !s.firstRunDone, platform: process.platform, version: app.getVersion() };
  });

  h('app:title', z.object({ title: z.string().max(300), dirty: z.boolean() }), ({ title, dirty }) => {
    const w = win();
    w.setTitle(`${dirty ? '• ' : ''}${title} - Facet BI`);
    if (process.platform === 'darwin') w.setDocumentEdited(dirty);
  });
}
