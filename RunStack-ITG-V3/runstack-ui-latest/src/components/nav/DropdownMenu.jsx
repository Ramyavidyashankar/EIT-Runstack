// src/components/nav/DropdownMenu.jsx
//
// Accessible menu button (WAI-ARIA "menu button" pattern) used by the header
// for Administration ▾ and the user profile menu.
//
//   Button   Enter / Space / ↓ open and focus the first item, ↑ the last.
//   Menu     ↑ ↓ move, Home / End jump, Esc closes and returns focus to the
//            button, Tab closes and lets focus move on. Clicking outside
//            closes it.
//
// Items are rendered by the caller (children(close)) with role="menuitem";
// links stay real <a href> so Ctrl/Cmd-click still opens a new tab.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

const items = (menu) => Array.from(menu?.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])') || []);

export default function DropdownMenu({ buttonContent, buttonLabel, buttonClassName = '', buttonProps = {}, menuLabel, align = 'left', children, menuClassName = '' }) {
  const [open, setOpen] = useState(false);
  const [focusOn, setFocusOn] = useState(null); // 'first' | 'last' when opening by keyboard
  const wrap = useRef(null);
  const button = useRef(null);
  const menu = useRef(null);
  const id = useId();
  const menuId = `rs-menu-${id.replace(/:/g, '')}`;

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  useEffect(() => {
    if (!open || !focusOn) return;
    const list = items(menu.current);
    (focusOn === 'last' ? list[list.length - 1] : list[0])?.focus();
    setFocusOn(null);
  }, [open, focusOn]);

  const onButtonKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); setFocusOn('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setFocusOn('last'); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); close(true); }
  };

  const onMenuKey = (e) => {
    const list = items(menu.current);
    const i = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key === ' ' && document.activeElement?.tagName === 'A') { e.preventDefault(); document.activeElement.click(); }
  };

  return (
    <div ref={wrap} className="rs-menu-wrap">
      <button ref={button} type="button" className={buttonClassName} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} aria-label={buttonLabel}
        onClick={() => setOpen((o) => !o)} onKeyDown={onButtonKey} {...buttonProps}>
        {buttonContent}
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={menuLabel} className={`rs-menu rs-menu--${align} ${menuClassName}`} onKeyDown={onMenuKey}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
