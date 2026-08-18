import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API, createSocket } from '../config/api.js';
import './Threads.css';

function statusTone(status) {
  if (status === 'sent') return 'good';
  if (status === 'ready') return 'good';
  if (status === 'drafting') return 'warn';
  if (status === 'skipped') return 'muted';
  if (status === 'failed') return 'danger';
  return 'warn';
}

function statusLabel(status) {
  if (status === 'drafting') return 'drafting';
  if (status === 'ready') return 'ready';
  return status || 'pending';
}

function listMeta(item) {
  const ready = item.readyCount ?? (item.replies || []).filter((r) => !r.skipped).length;
  if (item.status === 'sent') {
    return `${item.postedCount || 0} posted${
      item.skippedCount ? ` · ${item.skippedCount} skipped` : ''
    }`;
  }
  if (item.status === 'drafting' || item.status === 'ready') {
    return `${ready} ready for thread${
      item.skippedCount ? ` · ${item.skippedCount} skipped` : ''
    }`;
  }
  return `${item.postedCount || 0} posted${
    item.skippedCount ? ` · ${item.skippedCount} skipped` : ''
  }`;
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

  useEffect(() => {
    const socket = createSocket(io);
    socket.on('thread:update', (thread) => {
      if (!thread?.reviewDateKey) return;
      setData((prev) => {
        if (!prev) return prev;
        const items = [...(prev.items || [])];
        const idx = items.findIndex(
          (row) => row.reviewDateKey === thread.reviewDateKey
        );
        if (idx >= 0) items[idx] = thread;
        else items.unshift(thread);
        items.sort((a, b) =>
          String(b.reviewDateKey).localeCompare(String(a.reviewDateKey))
        );
        return { ...prev, items };
      });
      setSelectedKey((prev) => prev || thread.reviewDateKey);
    });
    return () => socket.disconnect();
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

  const readyReplies = (selected?.replies || []).filter((r) => !r.skipped);
  const skipped = (selected?.replies || []).filter((r) => r.skipped);
  const isLiveDraft =
    selected &&
    (selected.status === 'drafting' || selected.status === 'ready');
  const isToday = selected?.reviewDateKey === data?.todayKey;

  return (
    <div className="threads-page">
      <div className="threads-header">
        <div>
          <p className="threads-kicker">Element threads</p>
          <h2>Review threads</h2>
          <p className="threads-subtitle">
            After <strong>Pairs Today</strong> is sent, this page builds a live
            draft of pair reviews (random chat is ignored). Next morning at
            10:00 AM the bot posts that draft as a thread under yesterday&apos;s
            Pairs Today.
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
            <p className="muted threads-empty">
              No drafts yet — appears after today&apos;s Pairs Today is sent.
            </p>
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
                <span className="threads-list-date">
                  {item.reviewDateLabel}
                  {item.reviewDateKey === data?.todayKey ? ' · today' : ''}
                </span>
                <span className={`threads-pill tone-${statusTone(item.status)}`}>
                  {statusLabel(item.status)}
                </span>
                <span className="threads-list-meta">{listMeta(item)}</span>
              </button>
            ))
          )}
        </aside>

        <section className="threads-detail">
          {!selected ? (
            <div className="threads-empty-panel">
              <p>Select a day to see the thread draft / replies.</p>
            </div>
          ) : (
            <>
              <div className="threads-detail-head">
                <div>
                  <h3>
                    {selected.reviewDateLabel}
                    {isToday ? ' (today)' : ''}
                  </h3>
                  <p className="muted">
                    Root: Pairs Today
                    {selected.rootEventId
                      ? ` · ${selected.rootEventId.slice(0, 18)}…`
                      : ''}
                  </p>
                </div>
                <span
                  className={`threads-pill tone-${statusTone(selected.status)}`}
                >
                  {statusLabel(selected.status)}
                </span>
              </div>

              {isLiveDraft && (
                <p className="threads-note">
                  {selected.status === 'ready'
                    ? `Live draft — ${readyReplies.length} review(s) ready. Will post to Element at 10:00 AM next working morning.`
                    : 'Live draft — waiting for pair reviews with findings. No-issues / random chat stay out of this thread.'}
                </p>
              )}

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
                  {selected.status === 'sent'
                    ? `Thread replies (${readyReplies.length})`
                    : `Draft replies (${readyReplies.length})`}
                </p>
                {!readyReplies.length ? (
                  <p className="muted">
                    {isLiveDraft
                      ? 'No meaningful pair reviews yet for this day.'
                      : 'No review replies for this day.'}
                  </p>
                ) : (
                  readyReplies.map((reply) => (
                    <article
                      key={
                        reply.threadEventId ||
                        reply.reviewEventId ||
                        reply.pairKey ||
                        reply.pairLabel
                      }
                      className="threads-reply-card"
                    >
                      <header>
                        <strong>{reply.pairLabel}</strong>
                        {reply.senderName ? (
                          <span className="muted">— {reply.senderName}</span>
                        ) : null}
                        {isLiveDraft && !reply.threadEventId ? (
                          <span className="threads-pill tone-warn">queued</span>
                        ) : null}
                        {reply.threadEventId ? (
                          <span className="threads-pill tone-good">posted</span>
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
