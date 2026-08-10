import { useEffect, useState } from 'react';
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

function AiAnalyzed() {
  const [dates, setDates] = useState([]);
  const [todayKey, setTodayKey] = useState('');
  const [dateKey, setDateKey] = useState('');
  const [loadingDates, setLoadingDates] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingDates(true);
      try {
        const res = await axios.get(`${API}/ai/analyze/dates`);
        if (cancelled) return;
        const items = res.data?.items || [];
        setDates(items);
        setTodayKey(res.data?.todayKey || '');
        setDateKey(res.data?.todayKey || items[0]?.dateKey || '');
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

  const handleAnalyze = async () => {
    if (!dateKey) return;
    setAnalyzing(true);
    setError('');
    setCopied(false);
    try {
      const res = await axios.post(`${API}/ai/analyze`, { dateKey });
      setResult(res.data);
    } catch (err) {
      setResult(null);
      setError(
        err.response?.data?.message ||
          err.message ||
          'Analysis failed'
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

  return (
    <div className="ai-page">
      <div className="ai-page-header">
        <div>
          <h2>AI Analyzed</h2>
          <p>
            Lead report chat + meeting checks → short ready brief
          </p>
        </div>
      </div>

      <div className="ai-toolbar">
        <label className="ai-field">
          <span>Meeting day</span>
          <select
            value={dateKey}
            onChange={(e) => {
              setDateKey(e.target.value);
              setResult(null);
              setError('');
            }}
            disabled={loadingDates || analyzing}
          >
            {loadingDates && <option value="">Loading…</option>}
            {!loadingDates && !dates.length && (
              <option value={todayKey || ''}>Today</option>
            )}
            {dates.map((d) => (
              <option key={d.dateKey} value={d.dateKey}>
                {d.dateLabel}
                {d.isToday ? ' · today' : ''}
              </option>
            ))}
          </select>
        </label>

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

      {!result && !analyzing && !error && (
        <div className="ai-empty">
          <p>
            Pick a meeting day and hit Analyze. Uses your OpenRouter model from
            Settings.
          </p>
        </div>
      )}

      {analyzing && (
        <div className="ai-empty">
          <p className="ai-pulse">Reading lead chat & meeting replies…</p>
        </div>
      )}

      {result && !analyzing && (
        <div className="ai-result">
          <div className="ai-result-meta">
            <span>
              Review {result.reviewDateLabel}
              {result.sources?.lead ? ` · Lead ${result.sources.lead}` : ''}
            </span>
            <span className="ai-model-chip">
              {result.modelName || result.modelId}
            </span>
          </div>

          <div className="ai-brief-card">
            <div className="ai-brief-head">
              <h3>Ready message</h3>
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
