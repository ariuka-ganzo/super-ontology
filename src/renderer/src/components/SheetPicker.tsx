import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Modal } from './Modal';

interface Request {
  file: string;
  sheets: string[];
  /** Several sheets can be chosen when importing; one when reloading or locating a table. */
  multiple: boolean;
  resolve: (chosen: string[]) => void;
}

const usePicker = create<{ req: Request | null }>(() => ({ req: null }));

/** Asks which sheets of a workbook to use. Resolves to the chosen names, or an empty list when cancelled. */
export function pickSheets(file: string, sheets: string[], multiple: boolean): Promise<string[]> {
  return new Promise((resolve) => {
    usePicker.getState().req?.resolve([]);
    usePicker.setState({ req: { file, sheets, multiple, resolve } });
  });
}

export function SheetPicker(): React.JSX.Element | null {
  const req = usePicker((s) => s.req);
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => setChosen(req ? [req.sheets[0]] : []), [req]);
  if (!req) return null;

  const finish = (names: string[]): void => {
    usePicker.setState({ req: null });
    req.resolve(req.sheets.filter((s) => names.includes(s)));
  };
  const toggle = (name: string): void => setChosen((c) => (req.multiple ? (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]) : [name]));
  const all = chosen.length === req.sheets.length;

  return (
    <Modal
      title={req.multiple ? 'Choose sheets to import' : 'Choose a sheet'}
      onClose={() => finish([])}
      footer={
        <>
          <span className="grow" />
          <button onClick={() => finish([])}>Cancel</button>
          <button className="primary" disabled={!chosen.length} onClick={() => finish(chosen)}>
            {req.multiple && chosen.length > 1 ? `Import ${chosen.length} sheets` : req.multiple ? 'Import' : 'Use sheet'}
          </button>
        </>
      }
    >
      <div className="col" data-testid="sheet-picker">
        <p className="muted">
          <b>{req.file}</b> has {req.sheets.length} sheets.{' '}
          {req.multiple ? 'Each sheet you choose becomes its own table. The first row of each sheet must be its header.' : 'Which one should this table use?'}
        </p>
        {req.multiple && (
          <label className="row">
            <input type="checkbox" checked={all} onChange={() => setChosen(all ? [] : [...req.sheets])} />
            <span>All sheets</span>
          </label>
        )}
        <div className="col" role={req.multiple ? 'group' : 'radiogroup'} aria-label="Sheets" style={{ maxHeight: 320, overflow: 'auto' }}>
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
