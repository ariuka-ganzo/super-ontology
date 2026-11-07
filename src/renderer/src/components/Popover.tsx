import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** A floating panel anchored to an element; closes on outside click or Escape. */
export function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 200;
    const w = ref.current?.offsetWidth ?? 200;
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    const left = Math.min(r.left, window.innerWidth - w - 8);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  return (
    <div className="popover" ref={ref} style={pos} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, checked }: { children: ReactNode; onClick: () => void; checked?: boolean }): React.JSX.Element {
  return (
    <button className={`menu-item${checked ? ' checked' : ''}`} role="menuitem" onClick={onClick}>
      {children}
    </button>
  );
}

export function MenuSep(): React.JSX.Element {
  return <div className="menu-sep" />;
}

export function MenuTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="menu-title">{children}</div>;
}
