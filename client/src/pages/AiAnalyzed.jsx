import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import './AiAnalyzed.css';

function pairLabel(pair = []) {
  return Array.isArray(pair) ? pair.join(' + ') : '—';
}

function answerTone(answer, status) {
  if (status === 'answered' && answer === 'yes') return 'yes';
  if (status === 'answered' && answer === 'no') return 'no';
  if (status === 'pending') return 'pending';
  return 'muted';
}

function ReviewDayDropdown({
  dates,
  value,
  onChange,
  disabled,
  loading,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const selected = useMemo(
    () => dates.find((d) => d.dateKey === value) || null,
    [dates, value]
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = loading
    ? 'Loading days…'
    : selected
      ? selected.dateLabel
      : 'Select review day';

  return (
    <div
      className={`ai-day-dd${open ? ' open' : ''}${disabled ? ' disabled' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="ai-day-dd-trigger"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ai-day-dd-copy">
          <span className="ai-day-dd-label">{label}</span>
          {selected && (selected.isDefault || selected.isToday) && (
            <span className="ai-day-dd-tags">
              {selected.isDefault && (
                <span className="ai-day-tag latest">Latest</span>
              )}
              {selected.isToday && <span className="ai-day-tag today">Today</span>}
            </span>
          )}
        </span>
        <span className="ai-day-dd-chevron" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div className="ai-day-dd-menu" role="listbox">
          {!dates.length ? (
            <p className="ai-day-dd-empty">No review days yet</p>
          ) : (
            dates.map((d) => {
              const active = d.dateKey === value;
              return (
                <button
                  key={d.dateKey}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ai-day-dd-option${active ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(d.dateKey);
                    setOpen(false);
                  }}
                >
                  <span className="ai-day-dd-option-main">
                    <span className="ai-day-dd-option-date">{d.dateLabel}</span>
                    <span className="ai-day-dd-option-key">{d.dateKey}</span>
                  </span>
                  <span className="ai-day-dd-option-aside">
                    {d.isDefault && (
                      <span className="ai-day-tag latest">Latest</span>
                    )}
                    {d.isToday && (
                      <span className="ai-day-tag today">Today</span>
                    )}
                    {active && <span className="ai-day-check">✓</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function sirStatusLabel(sirReport) {
  // eventId means Matrix delivery already happened — never show Failed.
  if (sirReport?.eventId || sirReport?.status === 'sent') {
    return 'Sent to Ayaaz Sir';
  }
  if (sirReport?.status === 'ready') return 'Prepared (not sent yet)';
  if (sirReport?.status === 'preparing') return 'Preparing…';
  if (sirReport?.status === 'failed') return 'Send failed';
  return sirReport?.status || '—';
}

function AiAnalyzed() {
  const [dates, setDates] = useState([]);
  const [dateKey, setDateKey] = useState('');
  const [loadingDates, setLoadingDates] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [sirReport, setSirReport] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedSir, setCopiedSir] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingDates(true);
      try {
        const res = await axios.get(`${API}/ai/analyze/dates`);
        if (cancelled) return;
        const items = res.data?.items || [];
        const initial =
          res.data?.defaultReviewKey || items[0]?.dateKey || '';
        setDates(items);
        setDateKey(initial);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Could not load dates');
        }
      } finally {
        if (!cancelled) setLoadingDates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dateKey) {
      setSirReport(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API}/ai/sir-report`, {
          params: { dateKey },
        });
        if (!cancelled) setSirReport(res.data?.sirReport || null);
      } catch {
        if (!cancelled) setSirReport(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateKey]);

  const handleAnalyze = async () => {
    if (!dateKey) return;
    setAnalyzing(true);
    setError('');
    setCopied(false);
    try {
      const res = await axios.post(`${API}/ai/analyze`, { dateKey });
      setResult(res.data);
      if (res.data?.sirReport) setSirReport(res.data.sirReport);
    } catch (err) {
      setResult(null);
      setError(
        err.response?.data?.message || err.message || 'Analysis failed'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCopy = async () => {
    if (!result?.brief) return;
    try {
      await navigator.clipboard.writeText(result.brief);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy to clipboard');
    }
  };

  const handleCopySir = async () => {
    if (!sirReport?.brief) return;
    try {
      await navigator.clipboard.writeText(sirReport.brief);
      setCopiedSir(true);
      setTimeout(() => setCopiedSir(false), 1800);
    } catch {
      setError('Could not copy to clipboard');
    }
  };

  return (
    <div className="ai-page">
      <div className="ai-page-header">
        <div>
          <h2>AI Analyzed</h2>
          <p>
            Short Sir-ready report — **bold** for Element, best marked inline
          </p>
        </div>
      </div>

      <div className="ai-toolbar">
        <div className="ai-field">
          <span>Review day</span>
          <ReviewDayDropdown
            dates={dates}
            value={dateKey}
            loading={loadingDates}
            disabled={loadingDates || analyzing}
            onChange={(next) => {
              setDateKey(next);
              setResult(null);
              setError('');
            }}
          />
        </div>

        <button
          type="button"
          className="ai-analyze-btn"
          onClick={handleAnalyze}
          disabled={!dateKey || analyzing}
        >
          {analyzing ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>

      {error && <p className="ai-page-error">{error}</p>}

      {sirReport?.brief && (
        <div className="ai-result ai-sir-sent">
          <div className="ai-brief-card">
            <div className="ai-brief-head">
              <h3>{sirStatusLabel(sirReport)}</h3>
              <button
                type="button"
                className="ai-copy-btn"
                onClick={handleCopySir}
              >
                {copiedSir ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="ai-sir-meta">
              {sirReport.status === 'sent' && sirReport.sentAt
                ? `Delivered ${new Date(sirReport.sentAt).toLocaleString('en-PK')}`
                : sirReport.preparedAt
                  ? `Prepared ${new Date(sirReport.preparedAt).toLocaleString('en-PK')}`
                  : 'Saved for Ayaaz Sir'}
              {sirReport.modelName || sirReport.modelId
                ? ` · ${sirReport.modelName || sirReport.modelId}`
                : ''}
            </p>
            <pre className="ai-brief-text">{sirReport.brief}</pre>
          </div>
        </div>
      )}

      {!result && !analyzing && !error && !sirReport?.brief && (
        <div className="ai-empty">
          <p>
            Pick a review day and hit Analyze. Builds a clean report for Sir
            with summaries, best review, attendance, and meeting checks.
          </p>
        </div>
      )}

      {analyzing && (
        <div className="ai-empty">
          <p className="ai-pulse">
            Reading reviews, lead report & meeting checks…
          </p>
        </div>
      )}

      {result && !analyzing && (
        <div className="ai-result">
          <div className="ai-result-meta">
            <span>
              {result.reviewDateLabel}
              {result.sources?.lead ? ` · Lead ${result.sources.lead}` : ''}
              {typeof result.sources?.reviewCount === 'number'
                ? ` · ${result.sources.reviewCount} reviews`
                : ''}
            </span>
            <span className="ai-model-chip">
              {result.modelName || result.modelId}
            </span>
          </div>

          <div className="ai-brief-card">
            <div className="ai-brief-head">
              <h3>Fresh analysis</h3>
              <button type="button" className="ai-copy-btn" onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="ai-brief-text">{result.brief}</pre>
          </div>

          <div className="ai-sources">
            <h3>Sources</h3>
            <div className="ai-source-grid">
              <div className="ai-source-card">
                <span className="ai-source-label">Lead report</span>
                <strong>{result.sources?.lead || '—'}</strong>
                <p>
                  {result.sources?.leadStage || '—'}
                  {typeof result.sources?.leadMessageCount === 'number'
                    ? ` · ${result.sources.leadMessageCount} msgs`
                    : ''}
                </p>
              </div>
              <div className="ai-source-card">
                <span className="ai-source-label">Reviews used</span>
                <strong>
                  {result.sources?.reviewCount ?? 0} submitted
                </strong>
                <ul className="ai-disc-list">
                  {(result.sources?.reviews || []).length === 0 && (
                    <li className="muted">None found</li>
                  )}
                  {(result.sources?.reviews || []).map((r) => (
                    <li key={r.pairLabel || pairLabel(r.pair)}>
                      <span>{r.pairLabel || pairLabel(r.pair)}</span>
                      <span className="ai-disc-pair">
                        {r.senderName || ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="ai-source-card">
                <span className="ai-source-label">Meeting checks</span>
                <strong>
                  {(result.sources?.discussions || []).length} prompt
                  {(result.sources?.discussions || []).length === 1 ? '' : 's'}
                </strong>
                <ul className="ai-disc-list">
                  {(result.sources?.discussions || []).length === 0 && (
                    <li className="muted">None for this day</li>
                  )}
                  {(result.sources?.discussions || []).map((d) => (
                    <li key={`${d.member}-${pairLabel(d.pair)}`}>
                      <span>{d.member}</span>
                      <span className="ai-disc-pair">{pairLabel(d.pair)}</span>
                      <span
                        className={`ai-disc-ans ${answerTone(d.answer, d.status)}`}
                      >
                        {d.status === 'answered'
                          ? String(d.answer || '?').toUpperCase()
                          : d.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiAnalyzed;
