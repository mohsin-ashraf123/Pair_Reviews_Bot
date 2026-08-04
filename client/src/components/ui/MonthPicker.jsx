import { useEffect, useRef, useState } from 'react';
import './MonthPicker.css';

function MonthPicker({ options, value, onChange, disabled, placeholder = 'Select month' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const handleSelect = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div className={`month-picker${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="month-picker-trigger"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="month-picker-value">{selected?.label || placeholder}</span>
        <svg
          className="month-picker-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="month-picker-backdrop" aria-hidden onClick={() => setOpen(false)} />
      )}

      {open && (
        <ul className="month-picker-menu" role="listbox">
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={`month-picker-option${opt.value === value ? ' selected' : ''}`}
                onClick={() => handleSelect(opt.value)}
              >
                {opt.label}
                {opt.value === value && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default MonthPicker;
