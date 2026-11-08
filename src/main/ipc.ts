import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { OpenProjectResult } from '@shared/api';
import { appendSources } from '@shared/prep/prep';
import { modelSchema, prepStepSchema, projectSchema, queryRequestSchema, relationshipSchema, sourceSchema, tableSchema } from '@shared/schema';
import { isServerFormat, type Project, type SourceFormat, type TableDef, type TableSource } from '@shared/types';
import { canSavePasswords, forgetPassword, loadPassword, savePassword } from './credentials';
import { Engine, EngineError } from './engine/engine';
import { excelSheets } from './engine/excel';
import { loadProject, ProjectError, saveProject } from './project/project';
import { samplesDir } from './paths';
import { writeChunks } from './write';

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
  '.xlsx': 'excel',
  '.db': 'sqlite',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db3': 'sqlite'
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

/**
 * Runs `fn` with the password for a server source: the one just typed, otherwise the saved one
 * (undefined for files, or when there is none; the engine then asks for it). A typed password is
 * saved, or the saved one forgotten, only once the server has accepted it.
 */
async function withPassword<T>(
  source: TableSource,
  typed: string | undefined,
  remember: boolean | undefined,
  fn: (password?: string) => Promise<T>
): Promise<T> {
  const id = isServerFormat(source.format) ? source.connection?.id : undefined;
  if (!id) return fn(undefined);
  const result = await fn(typed ?? (await loadPassword(id)));
  if (typed !== undefined) {
    if (remember) await savePassword(id, typed);
    else await forgetPassword(id);
  }
  return result;
}

export function registerIpc(engine: Engine, getWindow: () => BrowserWindow | null, takeOpenPath: () => string | null = () => null): void {
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
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'tab', 'parquet', 'pq', 'json', 'jsonl', 'ndjson', 'xlsx', 'db', 'sqlite', 'sqlite3', 'db3'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return r.canceled ? [] : r.filePaths;
  });

  h('data:source', absPath, async (path) => {
    const format = formatForPath(path);
    if (!format)
      throw new EngineError(`${basename(path)} is not a supported file type. Use CSV, TSV, Parquet, JSON, Excel (.xlsx) or a SQLite database.`, 'invalid');
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

  const tableId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  const steps = z.array(prepStepSchema).max(500);
  // Files need an absolute path; servers need their connection settings.
  const source = sourceSchema.superRefine((s, ctx) => {
    if (isServerFormat(s.format)) {
      if (!s.connection) ctx.addIssue({ code: 'custom', path: ['connection'], message: 'is missing' });
    } else if (!isAbsolute(s.path)) ctx.addIssue({ code: 'custom', path: ['path'], message: 'must be an absolute path' });
  });
  const password = { password: z.string().max(1000).optional(), remember: z.boolean().optional() };
  h('data:import', z.object({ tableId, source, steps: steps.optional(), ...password }), ({ tableId, source, steps, password, remember }) =>
    withPassword(source, password, remember, (pw) => engine.importTable(tableId, source, steps, pw))
  );
  h('db:tables', z.object({ source, ...password }), ({ source, password, remember }) =>
    withPassword(source, password, remember, (pw) => engine.listDbTables(source, pw))
  );
  h('db:canSavePasswords', z.undefined(), () => canSavePasswords());
  h('data:steps', z.object({ tableId, steps }), ({ tableId, steps }) => engine.applySteps(tableId, steps));
  h('data:drop', tableId, (id) => engine.dropTable(id));
  h(
    'data:preview',
    z.object({ table: tableSchema, limit: z.number().int().min(1).max(1000), offset: z.number().int().min(0), uptoStep: z.string().max(64).optional() }),
    ({ table, limit, offset, uptoStep }) => engine.preview(table, limit, offset, uptoStep)
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
    const stepErrors: OpenProjectResult['stepErrors'] = [];
    // Tables whose steps append other tables are loaded last, so the tables they read from are ready.
    const appends = (t: TableDef): boolean => appendSources(t.steps).length > 0;
    const ordered = [...project.model.tables.filter((t) => !appends(t)), ...project.model.tables.filter(appends)];
    for (const t of ordered) {
      try {
        const r = await withPassword(t.source, undefined, undefined, (pw) => engine.importTable(t.id, t.source, t.steps, pw));
        if (r.stepError) {
          const i = (t.steps ?? []).findIndex((s) => s.id === r.stepError?.stepId);
          stepErrors.push({ tableId: t.id, stepId: r.stepError.stepId, message: `${t.name}, step ${i + 1}: ${r.stepError.message}` });
        }
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
    return { project, path: asPath, tableErrors, changed, stepErrors };
  };

  h('project:open', absPath.optional(), async (path) => {
    let file = path;
    if (!file) {
      const r = await dialog.showOpenDialog(win(), {
        title: 'Open project',
        properties: ['openFile'],
        filters: [{ name: 'Super Ontology project', extensions: ['ontology'] }]
      });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    return openFrom(file, file);
  });

  h('project:sample', z.undefined(), async () => {
    const s = await readSettings();
    if (!s.firstRunDone) await writeSettings({ ...s, firstRunDone: true });
    // The sample opens untitled, so saving asks for a new location instead of writing into the app folder.
    return openFrom(join(samplesDir(), 'sample.ontology'), null);
  });

  h('project:save', z.object({ project: projectSchema, path: absPath.nullable(), saveAs: z.boolean() }), async ({ project, path, saveAs }) => {
    let file = path;
    if (!file || saveAs) {
      const r = await dialog.showSaveDialog(win(), {
        title: 'Save project',
        defaultPath: `${(project as Project).name || 'Untitled'}.ontology`,
        filters: [{ name: 'Super Ontology project', extensions: ['ontology'] }]
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath.toLowerCase().endsWith('.ontology') ? r.filePath : `${r.filePath}.ontology`;
    }
    await saveProject(project as Project, file);
    return file;
  });

  // Characters that are not allowed in file names on Windows, plus control characters.
  const safeName = (n: string): string =>
    [...n]
      .map((ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? '_' : ch))
      .join('')
      .slice(0, 120) || 'export';

  h(
    'export:png',
    z.object({ dataUrl: z.string().max(60_000_000).startsWith('data:image/png;base64,'), name: z.string().max(200) }),
    async ({ dataUrl, name }) => {
      const r = await dialog.showSaveDialog(win(), {
        title: 'Export chart as PNG',
        defaultPath: `${safeName(name)}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
      return r.filePath;
    }
  );

  h('export:csv', z.object({ req: queryRequestSchema, name: z.string().max(200) }), async ({ req, name }) => {
    const r = await dialog.showSaveDialog(win(), {
      title: 'Export data as CSV',
      defaultPath: `${safeName(name)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (r.canceled || !r.filePath) return null;
    const file = r.filePath;
    async function* csv(): AsyncGenerator<string> {
      yield '﻿';
      yield* engine.queryCsv(req);
    }
    try {
      await writeChunks(file, csv());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
        throw new Error(`Could not write ${basename(file)}. If it is open in another program, such as Excel, close it and try again.`);
      throw e;
    }
    return file;
  });

  h('export:pdf', z.object({ name: z.string().max(200) }), async ({ name }) => {
    const r = await dialog.showSaveDialog(win(), {
      title: 'Export page as PDF',
      defaultPath: `${safeName(name)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return null;
    const pdf = await win().webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4' });
    await fs.writeFile(r.filePath, pdf);
    return r.filePath;
  });

  h('app:startup', z.undefined(), async () => {
    const s = await readSettings();
    const openPath = takeOpenPath();
    // Opening a project file counts as the first run, so the sample does not replace it next time.
    if (openPath && !s.firstRunDone) await writeSettings({ ...s, firstRunDone: true });
    return { firstRun: !s.firstRunDone && !openPath, openPath, platform: process.platform, version: app.getVersion() };
  });

  h('app:title', z.object({ title: z.string().max(300), dirty: z.boolean() }), ({ title, dirty }) => {
    const w = win();
    w.setTitle(`${dirty ? '• ' : ''}${title} - Super Ontology`);
    if (process.platform === 'darwin') w.setDocumentEdited(dirty);
  });
}
