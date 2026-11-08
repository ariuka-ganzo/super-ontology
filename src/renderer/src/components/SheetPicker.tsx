import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Modal } from './Modal';

type Noun = 'sheet' | 'table';

interface Request {
  file: string;
  sheets: string[];
  /** Several can be chosen when importing; one when reloading or locating a table. */
  multiple: boolean;
  /** What is being chosen: sheets of a workbook or tables of a database. */
  noun: Noun;
  resolve: (chosen: string[]) => void;
}

const usePicker = create<{ req: Request | null }>(() => ({ req: null }));

/** Asks which sheets of a workbook (or tables of a database) to use. Resolves to the chosen names, or an empty list when cancelled. */
export function pickSheets(file: string, sheets: string[], multiple: boolean, noun: Noun = 'sheet'): Promise<string[]> {
  return new Promise((resolve) => {
    usePicker.getState().req?.resolve([]);
    usePicker.setState({ req: { file, sheets, multiple, noun, resolve } });
  });
}

export function SheetPicker(): React.JSX.Element | null {
  const req = usePicker((s) => s.req);
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => setChosen(req ? [req.sheets[0]] : []), [req]);
  if (!req) return null;

  const { noun } = req;
  const finish = (names: string[]): void => {
    usePicker.setState({ req: null });
    req.resolve(req.sheets.filter((s) => names.includes(s)));
  };
  const toggle = (name: string): void => setChosen((c) => (req.multiple ? (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]) : [name]));
  const all = chosen.length === req.sheets.length;

  return (
    <Modal
      title={req.multiple ? `Choose ${noun}s to import` : `Choose a ${noun}`}
      onClose={() => finish([])}
      footer={
        <>
          <span className="grow" />
          <button onClick={() => finish([])}>Cancel</button>
          <button className="primary" disabled={!chosen.length} onClick={() => finish(chosen)}>
            {req.multiple && chosen.length > 1 ? `Import ${chosen.length} ${noun}s` : req.multiple ? 'Import' : `Use ${noun}`}
          </button>
        </>
      }
    >
      <div className="col" data-testid="sheet-picker">
        <p className="muted">
          <b>{req.file}</b> has {req.sheets.length} {noun}s.{' '}
          {!req.multiple
            ? 'Which one should this table use?'
            : noun === 'sheet'
              ? 'Each sheet you choose becomes its own table. The first row of each sheet must be its header.'
              : 'Each one you choose is copied in as its own table. Reload copies the latest data.'}
        </p>
        {req.multiple && (
          <label className="row">
            <input type="checkbox" checked={all} onChange={() => setChosen(all ? [] : [...req.sheets])} />
            <span>All {noun}s</span>
          </label>
        )}
        <div
          className="col"
          role={req.multiple ? 'group' : 'radiogroup'}
          aria-label={`${noun[0].toUpperCase()}${noun.slice(1)}s`}
          style={{ maxHeight: 320, overflow: 'auto' }}
        >
          {req.sheets.map((name) => (
            <label key={name} className="row">
              <input type={req.multiple ? 'checkbox' : 'radio'} name="sheet" checked={chosen.includes(name)} onChange={() => toggle(name)} />
              <span>{name}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
