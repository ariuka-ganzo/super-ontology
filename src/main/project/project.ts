import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectSchema } from '@shared/schema';
import { FORMAT_VERSION, type Project } from '@shared/types';

export class ProjectError extends Error {
  constructor(
    message: string,
    public readonly code: 'newer' | 'invalid' | 'io' = 'invalid'
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** Data source paths are stored relative to the project file when they share a drive or root. */
export function toStoredPath(projectFile: string, dataPath: string): string {
  const base = dirname(resolve(projectFile));
  const rel = relative(base, dataPath);
  if (rel === '' || isAbsolute(rel)) return dataPath;
  return rel.split(sep).join('/');
}

export function toAbsolutePath(projectFile: string, stored: string): string {
  if (isAbsolute(stored) || /^[A-Za-z]:[\\/]/.test(stored)) return stored;
  return resolve(dirname(resolve(projectFile)), ...stored.split('/'));
}

export function serializeProject(project: Project, projectFile: string): string {
  const copy: Project = structuredClone(project);
  copy.formatVersion = FORMAT_VERSION;
  for (const t of copy.model.tables) t.source.path = toStoredPath(projectFile, t.source.path);
  return JSON.stringify(copy, null, 2) + '\n';
}

/** Reads the format version of an existing file without trusting the rest of it. */
async function existingVersion(path: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path, 'utf8')) as { formatVersion?: unknown };
    return typeof raw.formatVersion === 'number' ? raw.formatVersion : null;
  } catch {
    return null;
  }
}

/** Saves atomically: write a temporary file next to the target, then rename it over the target. */
export async function saveProject(project: Project, path: string): Promise<void> {
  const parsed = projectSchema.safeParse(project);
  if (!parsed.success) throw new ProjectError(`The project is not valid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  const existing = await existingVersion(path);
  if (existing !== null && existing > FORMAT_VERSION)
    throw new ProjectError(
      `${path} was saved by a newer version of Facet BI (format ${existing}). It will not be overwritten. Save to a different file.`,
      'newer'
    );
  const text = serializeProject(parsed.data as Project, path);
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.facet-tmp`);
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw new ProjectError(`Could not save ${path}: ${(e as Error).message}`, 'io');
  }
}

/** Loads and validates a project. Data source paths come back absolute. */
export async function loadProject(path: string): Promise<Project> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (e) {
    throw new ProjectError(
      e instanceof SyntaxError ? `${path} is not a valid Facet BI project (it is not JSON).` : `Could not open ${path}: ${(e as Error).message}`,
      e instanceof SyntaxError ? 'invalid' : 'io'
    );
  }
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof version !== 'number') throw new ProjectError(`${path} is not a Facet BI project (no formatVersion).`);
  if (version > FORMAT_VERSION)
    throw new ProjectError(
      `This project was made with a newer version of Facet BI (format ${version}; this version reads format ${FORMAT_VERSION}). Update Facet BI to open it. The file has not been changed.`,
      'newer'
    );
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectError(`${path} is not a valid Facet BI project: ${issue?.path.join('.')} ${issue?.message}`);
  }
  const project = parsed.data as Project;
  for (const t of project.model.tables) t.source.path = toAbsolutePath(path, t.source.path);
  return project;
}
