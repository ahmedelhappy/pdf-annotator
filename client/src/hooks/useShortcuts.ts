import { useEffect, useMemo, useRef } from 'react';
import { buildBindingMap, comboOf, type Ctx } from '../lib/shortcuts';
import { useStore } from '../store';

const EDITABLE = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * One window listener for every shortcut. The ctx object changes on each
 * render, so it lives in a ref and the listener binds only once.
 */
export function useShortcuts(ctx: Ctx, onPanChange: (panning: boolean) => void) {
  const ref = useRef(ctx);
  ref.current = ctx;
  const spaceHeld = useRef(false);

  // Rebuilt whenever the user rebinds or switches something off. Kept in a ref
  // so the listener below still only binds once.
  const prefs = useStore((s) => s.shortcuts);
  const map = useMemo(() => buildBindingMap(prefs), [prefs]);
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (EDITABLE.includes(el.tagName) || el.isContentEditable);
    };

    function onKeyDown(e: KeyboardEvent) {
      // Space is a quasimode rather than a binding: held down it pans.
      if (e.code === 'Space' && !typing(e.target)) {
        e.preventDefault();
        if (!spaceHeld.current) {
          spaceHeld.current = true;
          onPanChange(true);
        }
        return;
      }
      if (e.repeat && e.key === ' ') return;

      const b = mapRef.current.get(comboOf(e));
      if (!b) return;
      if (typing(e.target) && !b.allowInInput) return;
      // Some shortcuts hand the key back to the browser when it has a native
      // meaning that should win, such as copying selected page text.
      if (b.standDown?.()) return;
      if (!b.keepDefault) e.preventDefault();
      b.run(ref.current);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space' && spaceHeld.current) {
        spaceHeld.current = false;
        onPanChange(false);
      }
    }

    // Releasing space while the tab is unfocused would otherwise stick.
    function onBlur() {
      if (spaceHeld.current) {
        spaceHeld.current = false;
        onPanChange(false);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onPanChange]);
}
