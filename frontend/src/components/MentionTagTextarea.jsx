import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/axios';

/**
 * MentionTagTextarea
 *
 * A drop-in <textarea> replacement that shows an autocomplete popup
 * whenever the caret is right after `!` (employee mention) or `@`
 * (global tag).  The user picks with mouse or keyboard (↑ ↓ / Enter /
 * Esc) and the token is inserted inline as `!Name` or `@tag-slug`.
 *
 * Selection also appends the picked entity id to the `mentions` /
 * `tags` arrays via the `onMentionPicked` / `onTagPicked` callbacks so
 * the caller can persist the ObjectId refs alongside the free-text
 * body.
 *
 * Props:
 *   value            -- current textarea value
 *   onChange(text)   -- called on every keystroke
 *   tags             -- pre-loaded [{ _id, name, slug, color, category }]
 *   onMentionPicked(user)  -- fired when the user selects a !mention
 *   onTagPicked(tag)       -- fired when the user selects an @tag
 *   rows, placeholder, disabled -- forwarded to <textarea>
 */
const DEBOUNCE_MS = 200;

export default function MentionTagTextarea({
  value = '',
  onChange = () => {},
  tags = [],
  onMentionPicked = () => {},
  onTagPicked = () => {},
  rows = 3,
  placeholder = '',
  disabled = false,
  className = '',
}) {
  const ref = useRef(null);
  const popupRef = useRef(null);
  const [popup, setPopup] = useState(null); // { kind: 'mention'|'tag', query, anchorPos, tokenStart }
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(0);
  const [empCache, setEmpCache] = useState([]); // recent employee autocomplete results

  // Detect the token being typed under the caret.  A "!" or "@" token
  // is anything from the trigger character up to the caret with no
  // whitespace in between.
  const detectToken = () => {
    const el = ref.current;
    if (!el) return null;
    const pos = el.selectionStart || 0;
    const before = value.slice(0, pos);
    const m = before.match(/([!@])([\w\-.]*)$/);
    if (!m) return null;
    return {
      kind: m[1] === '!' ? 'mention' : 'tag',
      query: m[2],
      tokenStart: pos - m[0].length,
      anchorPos: pos,
    };
  };

  useEffect(() => {
    if (!popup) return;
    const { kind, query } = popup;
    let cancelled = false;
    if (kind === 'tag') {
      const q = (query || '').toLowerCase();
      const list = (tags || [])
        .filter((t) => !t.archived)
        .filter((t) => !q || (t.slug + ' ' + t.name).toLowerCase().includes(q))
        .slice(0, 8);
      setItems(list.map((t) => ({ ...t, __label: `@${t.name}`, __sub: t.category })));
      setActive(0);
      return () => { cancelled = true; };
    }
    // mention: server autocomplete (debounced)
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/interactions/mentions', { params: { q: query } });
        if (!cancelled) {
          const list = (data || []).slice(0, 8).map((e) => ({
            ...e, __label: e.name, __sub: `${e.employeeId || ''} · ${e.department || ''}`,
          }));
          setItems(list);
          setActive(0);
          setEmpCache(list);
        }
      } catch (_) { if (!cancelled) setItems([]); }
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [popup?.kind, popup?.query, tags]);

  const closePopup = () => { setPopup(null); setItems([]); setActive(0); };

  const insertToken = (item) => {
    if (!popup || !ref.current) return;
    const el = ref.current;
    const before = value.slice(0, popup.tokenStart);
    const after  = value.slice(popup.anchorPos);
    // Insert the display token; server search matches whole words.
    const token = popup.kind === 'mention' ? `!${item.name}` : `@${item.slug}`;
    const next = `${before}${token} ${after}`;
    onChange(next);
    // Emit the id-based callback so the caller keeps its mentions/tags
    // ObjectId arrays in sync with what's typed.
    if (popup.kind === 'mention') onMentionPicked(item);
    else onTagPicked(item);
    // Restore caret just after the inserted token + trailing space.
    const caret = (before + token + ' ').length;
    requestAnimationFrame(() => {
      if (el) { el.focus(); el.setSelectionRange(caret, caret); }
    });
    closePopup();
  };

  const handleKeyDown = (e) => {
    if (!popup || items.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertToken(items[active]); return; }
    if (e.key === 'Escape')    { e.preventDefault(); closePopup(); return; }
  };

  const handleInput = (e) => {
    onChange(e.target.value);
    // detectToken has to see the NEW value; setPopup after react commits.
    requestAnimationFrame(() => {
      const t = detectToken();
      if (t) setPopup(t);
      else closePopup();
    });
  };

  // Rough popup position: attach below the textarea; simple + reliable.
  const showPopup = !!popup && items.length > 0 && !disabled;

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        className={`input ${className}`}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(closePopup, 100)}
      />
      {showPopup && (
        <div
          ref={popupRef}
          className="absolute z-50 mt-1 w-[320px] max-h-[240px] overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg text-sm"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100 bg-slate-50">
            {popup.kind === 'mention' ? 'Mention employee' : 'Add tag'}
          </div>
          {items.map((item, i) => (
            <button
              type="button"
              key={item._id + ':' + i}
              className={`w-full text-left px-2 py-1.5 ${i === active ? 'bg-brand-50 text-brand-800' : 'hover:bg-slate-50'}`}
              onClick={() => insertToken(item)}
              onMouseEnter={() => setActive(i)}
            >
              <div className="font-medium text-slate-800">{item.__label}</div>
              {item.__sub && <div className="text-[11px] text-slate-500">{item.__sub}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
