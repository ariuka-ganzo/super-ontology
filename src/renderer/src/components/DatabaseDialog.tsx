import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { DbTable, PasswordInput } from '@shared/api';
import type { ServerConnection, ServerFormat, TableSource } from '@shared/types';
import { newId } from '../ids';
import { useStore } from '../store';
import { Modal } from './Modal';

const SERVERS: Record<ServerFormat, { label: string; port: number; schemaHint: string }> = {
  postgres: { label: 'PostgreSQL', port: 5432, schemaHint: 'public' },
  mysql: { label: 'MySQL', port: 3306, schemaHint: '' }
};

export interface DbImport {
  source: TableSource;
  name: string;
}

export function serverPath(format: ServerFormat, k: Omit<ServerConnection, 'id'>): string {
  return `${format}://${k.user}@${k.host}:${k.port}/${k.database}`;
}

const tableLabel = (t: DbTable): string => (t.schema && t.schema !== 'main' && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name);

/** Connects to a PostgreSQL or MySQL server, then lets the user choose tables or write a query to import. */
export function DatabaseDialog({
  onClose,
  onImport
}: {
  onClose: () => void;
  onImport: (items: DbImport[], password: PasswordInput) => void;
}): React.JSX.Element {
  const tables = useStore((s) => s.project.model.tables);
  const [format, setFormat] = useState<ServerFormat>('postgres');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(String(SERVERS.postgres.port));
  const [portTouched, setPortTouched] = useState(false);
  const [database, setDatabase] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [canSave, setCanSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<DbTable[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [useQuery, setUseQuery] = useState(false);
  const [query, setQuery] = useState('');
  const [queryName, setQueryName] = useState('Query');

  useEffect(() => {
    void window.ontology.canSavePasswords().then((ok) => {
      setCanSave(ok);
      if (!ok) setRemember(false);
    });
  }, []);

  const settings = { host: host.trim(), port: Number(port), database: database.trim(), user: user.trim() };
  // Reuse the id of a connection already in the project, so its saved password is shared.
  const existing = tables.find(
    (t) =>
      t.source.format === format &&
      t.source.connection?.host === settings.host &&
      t.source.connection.port === settings.port &&
      t.source.connection.database === settings.database &&
      t.source.connection.user === settings.user
  )?.source.connection;
  const [freshId] = useState(() => newId('c'));
  const connection: ServerConnection = { id: existing?.id ?? freshId, ...settings };
  const base: TableSource = { path: serverPath(format, settings), format, connection };
  const ready = settings.host && Number.isInteger(settings.port) && settings.port > 0 && settings.database && settings.user;

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const list = await window.ontology.listDbTables(base, { password, remember });
      setFound(list);
      setChosen([]);
      setUseQuery(list.length === 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const items: DbImport[] = useQuery
    ? query.trim() && queryName.trim()
      ? [{ source: { ...base, query: query.trim() }, name: queryName.trim() }]
      : []
    : (found ?? [])
        .filter((t) => chosen.includes(tableLabel(t)))
        .map((t) => ({ source: { ...base, table: { schema: t.schema, name: t.name } }, name: t.name }));

  return (
    <Modal
      title="Connect to a database"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="grow faint">{found ? `Connected to ${settings.database} on ${settings.host}` : ''}</span>
          <button onClick={onClose}>Cancel</button>
          {!found ? (
            <button className="primary" disabled={!ready || busy} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          ) : (
            <button className="primary" disabled={!items.length} onClick={() => onImport(items, { password, remember })}>
              {items.length > 1 ? `Import ${items.length} tables` : 'Import'}
            </button>
          )}
        </>
      }
    >
      <div className="col" data-testid="database-dialog">
        {!found && (
          <>
            <div className="row">
              <label className="col grow" style={{ gap: 2 }}>
                <span className="muted">Database type</span>
                <select
                  aria-label="Database type"
                  value={format}
                  onChange={(e) => {
                    const f = e.target.value as ServerFormat;
                    setFormat(f);
                    if (!portTouched) setPort(String(SERVERS[f].port));
                  }}
                >
                  {(Object.keys(SERVERS) as ServerFormat[]).map((f) => (
                    <option key={f} value={f}>
                      {SERVERS[f].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label className="col grow" style={{ gap: 2 }}>
                <span className="muted">Server</span>
                <input aria-label="Server" value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost or db.example.com" />
              </label>
              <label className="col" style={{ gap: 2, width: 110 }}>
                <span className="muted">Port</span>
                <input
                  aria-label="Port"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) => {
                    setPort(e.target.value);
                    setPortTouched(true);
                  }}
                />
              </label>
            </div>
            <label className="col" style={{ gap: 2 }}>
              <span className="muted">Database</span>
              <input aria-label="Database" value={database} onChange={(e) => setDatabase(e.target.value)} />
            </label>
            <div className="row">
              <label className="col grow" style={{ gap: 2 }}>
                <span className="muted">User name</span>
                <input aria-label="User name" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
              </label>
              <label className="col grow" style={{ gap: 2 }}>
                <span className="muted">Password</span>
                <input aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              </label>
            </div>
            <label className="row" title={canSave ? '' : 'This computer has no secure password storage (a keyring), so passwords are asked for each time.'}>
              <input type="checkbox" checked={remember} disabled={!canSave} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember the password on this computer{canSave ? '' : ' (not available: no secure storage)'}</span>
            </label>
            <p className="faint">
              The password is kept encrypted by your operating system, never in the project file. The connection is read-only: Super Ontology copies data in and
              never changes the database. Use an account that can only read.
            </p>
          </>
        )}
        {found && (
          <>
            <div className="row">
              <label className="row">
                <input type="radio" name="what" checked={!useQuery} onChange={() => setUseQuery(false)} disabled={!found.length} />
                <span>Import tables</span>
              </label>
              <label className="row">
                <input type="radio" name="what" checked={useQuery} onChange={() => setUseQuery(true)} />
                <span>Import the result of a query</span>
              </label>
            </div>
            {!useQuery && (
              <div className="col checks" role="group" aria-label="Tables" style={{ maxHeight: 320 }}>
                {found.map((t) => {
                  const label = tableLabel(t);
                  return (
                    <label key={label} className="row">
                      <input
                        type="checkbox"
                        checked={chosen.includes(label)}
                        onChange={() => setChosen((c) => (c.includes(label) ? c.filter((x) => x !== label) : [...c, label]))}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {useQuery && (
              <>
                <label className="col" style={{ gap: 2 }}>
                  <span className="muted">Query (runs on the server)</span>
                  <textarea
                    aria-label="Query"
                    className="mono"
                    rows={7}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`SELECT region, SUM(amount) AS amount\nFROM ${SERVERS[format].schemaHint ? `${SERVERS[format].schemaHint}.` : ''}sales\nGROUP BY region`}
                  />
                </label>
                <label className="col" style={{ gap: 2 }}>
                  <span className="muted">Table name in Super Ontology</span>
                  <input aria-label="Table name for the query" value={queryName} onChange={(e) => setQueryName(e.target.value)} />
                </label>
              </>
            )}
            <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => setFound(null)}>
              ← Change connection
            </button>
          </>
        )}
        {error && (
          <div className="banner error" data-testid="database-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

interface PasswordRequest {
  title: string;
  message: string;
  canSave: boolean;
  resolve: (p: PasswordInput | null) => void;
}

const usePasswordPrompt = create<{ req: PasswordRequest | null }>(() => ({ req: null }));

/** Asks for a database password. Resolves to null when cancelled. */
export async function askPassword(title: string, message: string): Promise<PasswordInput | null> {
  const canSave = await window.ontology.canSavePasswords();
  return new Promise((resolve) => {
    usePasswordPrompt.getState().req?.resolve(null);
    usePasswordPrompt.setState({ req: { title, message, canSave, resolve } });
  });
}

export function PasswordPrompt(): React.JSX.Element | null {
  const req = usePasswordPrompt((s) => s.req);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  useEffect(() => {
    setPassword('');
    setRemember(!!req?.canSave);
  }, [req]);
  if (!req) return null;
  const finish = (p: PasswordInput | null): void => {
    usePasswordPrompt.setState({ req: null });
    req.resolve(p);
  };
  return (
    <Modal
      title={req.title}
      onClose={() => finish(null)}
      footer={
        <>
          <span className="grow" />
          <button onClick={() => finish(null)}>Cancel</button>
          <button className="primary" disabled={!password} onClick={() => finish({ password, remember })}>
            Connect
          </button>
        </>
      }
    >
      <form
        className="col"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) finish({ password, remember });
        }}
      >
        <p className="muted">{req.message}</p>
        <label className="col" style={{ gap: 2 }}>
          <span className="muted">Password</span>
          <input aria-label="Password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="row">
          <input type="checkbox" checked={remember} disabled={!req.canSave} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember the password on this computer</span>
        </label>
      </form>
    </Modal>
  );
}
