import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import './Threads.css';

function statusTone(status) {
  if (status === 'sent') return 'good';
  if (status === 'skipped') return 'muted';
  if (status === 'failed') return 'danger';
  return 'warn';
}

function Threads() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.get(`${API}/threads`);
      setData(res.data);
      const initial =
        res.data?.defaultReviewKey ||
        res.data?.items?.[0]?.reviewDateKey ||
        '';
      setSelectedKey((prev) => prev || initial);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load threads');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selected = useMemo(
    () => data?.items?.find((item) => item.reviewDateKey === selectedKey) || null,
    [data, selectedKey]
  );

  const handleRun = async () => {
    setRunning(true);
    setError('');
    try {
      await axios.post(`${API}/threads/run`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to post thread digest');
    } finally {
      setRunning(false);
    }
  };

  const posted = (selected?.replies || []).filter((r) => !r.skipped);
  const skipped = (selected?.replies || []).filter((r) => r.skipped);

  return (
    <div className="threads-page">
      <div className="threads-header">
        <div>
          <p className="threads-kicker">Element threads</p>
          <h2>Review threads</h2>
          <p className="threads-subtitle">
            Each morning at 10:00 AM, meaningful pair reviews are posted under
            yesterday&apos;s <strong>Pairs Today</strong> message as a thread.
          </p>
        </div>
        <button
          type="button"
          className="threads-run-btn"
          onClick={handleRun}
          disabled={running || loading}
        >
          {running ? 'Posting…' : 'Post yesterday now'}
        </button>
      </div>

      {error && <p className="feedback err">{error}</p>}

      <div className="threads-layout">
        <aside className="threads-list">
          <p className="threads-list-label">Digest days</p>
          {loading && !data ? (
            <p className="muted threads-empty">Loading…</p>
          ) : !data?.items?.length ? (
            <p className="muted threads-empty">No thread digests yet</p>
          ) : (
            data.items.map((item) => (
              <button
                key={item.reviewDateKey}
                type="button"
                className={`threads-list-item${
                  item.reviewDateKey === selectedKey ? ' active' : ''
                }`}
                onClick={() => setSelectedKey(item.reviewDateKey)}
              >
                <span className="threads-list-date">{item.reviewDateLabel}</span>
                <span className={`threads-pill tone-${statusTone(item.status)}`}>
                  {item.status}
                </span>
                <span className="threads-list-meta">
                  {item.postedCount} posted
                  {item.skippedCount ? ` · ${item.skippedCount} skipped` : ''}
                </span>
              </button>
            ))
          )}
        </aside>

        <section className="threads-detail">
          {!selected ? (
            <div className="threads-empty-panel">
              <p>Select a day to see the thread replies.</p>
            </div>
          ) : (
            <>
              <div className="threads-detail-head">
                <div>
                  <h3>{selected.reviewDateLabel}</h3>
                  <p className="muted">
                    Root: Pairs Today
                    {selected.rootEventId
                      ? ` · ${selected.rootEventId.slice(0, 18)}…`
                      : ''}
                  </p>
                </div>
                <span className={`threads-pill tone-${statusTone(selected.status)}`}>
                  {selected.status}
                </span>
              </div>

              {selected.skipReason && (
                <p className="threads-note">{selected.skipReason}</p>
              )}
              {selected.error && (
                <p className="feedback err">{selected.error}</p>
              )}

              {selected.rootBody && (
                <div className="threads-root-card">
                  <p className="threads-card-label">Pairs Today (root)</p>
                  <pre>{selected.rootBody}</pre>
                </div>
              )}

              <div className="threads-replies">
                <p className="threads-card-label">
                  Thread replies ({posted.length})
                </p>
                {!posted.length ? (
                  <p className="muted">No review replies posted for this day.</p>
                ) : (
                  posted.map((reply) => (
                    <article
                      key={reply.threadEventId || reply.pairLabel}
                      className="threads-reply-card"
                    >
                      <header>
                        <strong>{reply.pairLabel}</strong>
                        {reply.senderName ? (
                          <span className="muted">— {reply.senderName}</span>
                        ) : null}
                      </header>
                      <pre>{reply.body}</pre>
                    </article>
                  ))
                )}
              </div>

              {skipped.length > 0 && (
                <div className="threads-skipped">
                  <p className="threads-card-label">
                    Skipped ({skipped.length})
                  </p>
                  <ul>
                    {skipped.map((reply) => (
                      <li key={`${reply.pairLabel}-${reply.skipReason}`}>
                        <strong>{reply.pairLabel}</strong>
                        <span className="muted">
                          {' '}
                          — {reply.skipReason || 'skipped'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default Threads;
