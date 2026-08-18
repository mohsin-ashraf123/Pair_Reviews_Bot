import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import './History.css';

function formatClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatGroupHeading(dateKey) {
  if (!dateKey) return 'Unknown date';
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function noticeMeta(category) {
  if (category === 'bot_reminder') {
    return { label: 'Reminder', tone: 'warn' };
  }
  if (category === 'bot_missed') {
    return { label: 'Missed review', tone: 'danger' };
  }
  if (category === 'bot_wrong_pair') {
    return { label: 'Wrong pair', tone: 'danger' };
  }
  if (category === 'bot_duplicate') {
    return { label: 'Duplicate', tone: 'muted' };
  }
  if (category === 'bot_boss') {
    return { label: 'Ayaaz Sir report', tone: 'warn' };
  }
  if (category === 'bot_thread') {
    return { label: 'Review thread', tone: 'warn' };
  }
  return { label: 'Notice', tone: 'muted' };
}

function failureKindLabel(kind) {
  switch (kind) {
    case 'daily_pairs':
      return 'Daily pairs';
    case 'review_reminder':
      return 'Reminder';
    case 'missed_review':
      return 'Missed review';
    case 'wrong_pair_alert':
      return 'Wrong pair';
    case 'missing_review_dm':
      return 'Member DM';
    case 'discussion_prompt':
      return 'Discussion';
    case 'lead_report':
      return 'Lead report';
    case 'boss_daily_report':
      return 'Ayaaz Sir report';
    case 'pair_review_thread':
      return 'Review thread';
    case 'lead_report_ack':
    case 'discussion_ack':
    case 'missing_review_ack':
      return 'Ack';
    case 'dm_message':
      return 'DM';
    case 'room_message':
      return 'Room msg';
    default:
      return 'Send';
  }
}

function groupByDateKey(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.dateKey || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function HistorySkeleton() {
  return (
    <div className="history-page history-skeleton" aria-busy="true">
      <div className="history-shell">
        <div className="history-header">
          <span className="hist-skel-line hist-skel-title" />
          <span className="hist-skel-line hist-skel-sub" />
        </div>
        <div className="history-tabs">
          <span className="hist-skel-line" style={{ height: 42, width: '100%', borderRadius: 0 }} />
          <span className="hist-skel-line" style={{ height: 42, width: '100%', borderRadius: 0 }} />
        </div>
        <div className="history-panel">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="hist-skel-row">
              <span className="hist-skel-line hist-skel-time" />
              <span className="hist-skel-line hist-skel-badge" />
              <span className="hist-skel-line hist-skel-main" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function History() {
  const [tab, setTab] = useState('bot');
  const [pairs, setPairs] = useState([]);
  const [botNotices, setBotNotices] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await axios.get(`${API}/history`);
        setPairs(res.data.pairs || []);
        setBotNotices(res.data.botNotices || []);
        setReviews(res.data.reviews || []);
        setFailures(res.data.failures || []);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load history');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const botTimeline = useMemo(() => {
    const notices = botNotices.map((item) => ({
      kind: 'notice',
      id: item._id || item.eventId,
      dateKey: item.dateKey || '',
      sentAt: item.sentAt,
      item,
    }));
    const pairRows = pairs.map((item) => ({
      kind: 'pairs',
      id: item._id || item.dateKey || item.eventId,
      dateKey: item.dateKey || '',
      sentAt: item.sentAt,
      item,
    }));
    const failRows = failures.map((item) => ({
      kind: 'failure',
      id: item._id || `fail-${item.failedAt}-${item.kind}`,
      dateKey: item.dateKey || '',
      sentAt: item.failedAt,
      item,
    }));
    return [...notices, ...pairRows, ...failRows].sort(
      (a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0)
    );
  }, [botNotices, pairs, failures]);

  const botGroups = useMemo(() => groupByDateKey(botTimeline), [botTimeline]);

  const reviewGroups = useMemo(() => {
    const entries = reviews.map((item) => ({
      kind: 'review',
      id: item._id || item.eventId,
      dateKey: item.dateKey || '',
      sentAt: item.sentAt,
      item,
    }));
    entries.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
    return groupByDateKey(entries);
  }, [reviews]);

  if (loading) return <HistorySkeleton />;

  return (
    <div className="history-page">
      <div className="history-shell">
        <div className="history-header">
          <div>
            <p className="history-kicker">Archive</p>
            <h2>Message history</h2>
            <p className="history-subtitle">
              Bot notices, send failures &amp; room reviews older than 24 hours
            </p>
          </div>
        </div>

        <div className="history-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`history-tab${tab === 'bot' ? ' active' : ''}`}
            onClick={() => {
              setTab('bot');
              setExpandedId(null);
            }}
            aria-selected={tab === 'bot'}
          >
            Bot messages
            <span className="history-tab-count">{botTimeline.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            className={`history-tab${tab === 'reviews' ? ' active' : ''}`}
            onClick={() => {
              setTab('reviews');
              setExpandedId(null);
            }}
            aria-selected={tab === 'reviews'}
          >
            Team reviews
            <span className="history-tab-count">{reviews.length}</span>
          </button>
        </div>

        {error && <p className="feedback err">{error}</p>}

        {tab === 'bot' && (
          <section className="history-panel">
            {!botTimeline.length && !error ? (
              <div className="history-empty">
                <p>No archived bot messages yet</p>
              </div>
            ) : (
              <div className="history-groups">
                {botGroups.map(([dateKey, entries]) => (
                  <div key={dateKey} className="history-group">
                    <div className="history-group-head">
                      <h3>{formatGroupHeading(dateKey)}</h3>
                      <span>{entries.length} items</span>
                    </div>
                    <div className="history-list">
                      {entries.map((entry) => {
                        const isOpen = expandedId === entry.id;

                        if (entry.kind === 'failure') {
                          const item = entry.item;
                          return (
                            <article
                              key={entry.id}
                              className={`history-row history-row-fail${isOpen ? ' open' : ''}`}
                            >
                              <button
                                type="button"
                                className="history-row-btn"
                                onClick={() =>
                                  setExpandedId(isOpen ? null : entry.id)
                                }
                                aria-expanded={isOpen}
                              >
                                <time className="history-clock">
                                  {formatClock(item.failedAt)}
                                </time>
                                <span className="history-badge tone-danger">
                                  Failed
                                </span>
                                <div className="history-row-copy">
                                  <span className="history-row-title">
                                    {failureKindLabel(item.kind)}
                                    {item.member ? ` · ${item.member}` : ''}
                                  </span>
                                  <span className="history-row-sub history-row-sub-fail">
                                    {item.error || 'Message could not be sent'}
                                  </span>
                                </div>
                                <span className="history-chevron" aria-hidden>
                                  {isOpen ? '▾' : '▸'}
                                </span>
                              </button>
                              {isOpen && (
                                <div className="history-row-body">
                                  <p className="history-fail-reason">
                                    <strong>Error:</strong> {item.error || '—'}
                                  </p>
                                  {item.body ? (
                                    <pre className="history-message">
                                      {item.body}
                                    </pre>
                                  ) : null}
                                </div>
                              )}
                            </article>
                          );
                        }

                        if (entry.kind === 'notice') {
                          const item = entry.item;
                          const meta = noticeMeta(item.category);
                          return (
                            <article
                              key={entry.id}
                              className={`history-row${isOpen ? ' open' : ''}`}
                            >
                              <button
                                type="button"
                                className="history-row-btn"
                                onClick={() =>
                                  setExpandedId(isOpen ? null : entry.id)
                                }
                                aria-expanded={isOpen}
                              >
                                <time className="history-clock">
                                  {formatClock(item.sentAt)}
                                </time>
                                <span className={`history-badge tone-${meta.tone}`}>
                                  {meta.label}
                                </span>
                                <div className="history-row-copy">
                                  <span className="history-row-title">
                                    {item.alertTriggeredBy
                                      ? `Triggered by ${item.alertTriggeredBy}`
                                      : meta.label}
                                  </span>
                                  <span className="history-row-sub">
                                    Tap to view full message
                                  </span>
                                </div>
                                <span className="history-chevron" aria-hidden>
                                  {isOpen ? '▾' : '▸'}
                                </span>
                              </button>
                              {isOpen && (
                                <div className="history-row-body">
                                  <pre className="history-message">{item.body}</pre>
                                </div>
                              )}
                            </article>
                          );
                        }

                        const item = entry.item;
                        const pairList = item.allPairs || item.pairs || [];
                        const pairLabels = pairList.map((p) =>
                          Array.isArray(p) ? p.join(' + ') : p
                        );

                        return (
                          <article
                            key={entry.id}
                            className={`history-row${isOpen ? ' open' : ''}`}
                          >
                            <button
                              type="button"
                              className="history-row-btn"
                              onClick={() =>
                                setExpandedId(isOpen ? null : entry.id)
                              }
                              aria-expanded={isOpen}
                            >
                              <time className="history-clock">
                                {formatClock(item.sentAt)}
                              </time>
                              <span className="history-badge tone-primary">
                                Daily pairs
                              </span>
                              <div className="history-row-copy">
                                <span className="history-row-title">
                                  Lead {item.lead || '—'}
                                </span>
                                <span className="history-row-sub">
                                  {pairLabels.length} pairs
                                  {item.triggeredBy
                                    ? ` · ${item.triggeredBy === 'cron' ? 'Auto' : 'Manual'}`
                                    : ''}
                                </span>
                              </div>
                              <span className="history-chevron" aria-hidden>
                                {isOpen ? '▾' : '▸'}
                              </span>
                            </button>
                            {isOpen && (
                              <div className="history-row-body">
                                {pairLabels.length > 0 && (
                                  <div className="history-chips">
                                    {pairLabels.map((p) => (
                                      <span key={p} className="history-chip">
                                        {p}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <pre className="history-message">
                                  {item.message || item.body || '—'}
                                </pre>
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'reviews' && (
          <section className="history-panel">
            {!reviews.length && !error ? (
              <div className="history-empty">
                <p>No archived review messages yet</p>
              </div>
            ) : (
              <div className="history-groups">
                {reviewGroups.map(([dateKey, entries]) => (
                  <div key={dateKey} className="history-group">
                    <div className="history-group-head">
                      <h3>{formatGroupHeading(dateKey)}</h3>
                      <span>{entries.length} reviews</span>
                    </div>
                    <div className="history-list">
                      {entries.map((entry) => {
                        const item = entry.item;
                        const isOpen = expandedId === entry.id;
                        const issue =
                          item.reviewIssue === 'wrong_pair'
                            ? 'Wrong pair'
                            : item.reviewIssue === 'duplicate_pair'
                              ? 'Duplicate'
                              : null;

                        return (
                          <article
                            key={entry.id}
                            className={`history-row${isOpen ? ' open' : ''}`}
                          >
                            <button
                              type="button"
                              className="history-row-btn"
                              onClick={() =>
                                setExpandedId(isOpen ? null : entry.id)
                              }
                              aria-expanded={isOpen}
                            >
                              <time className="history-clock">
                                {formatClock(item.sentAt)}
                              </time>
                              <span className="history-avatar" aria-hidden>
                                {(item.senderName || '?').slice(0, 1).toUpperCase()}
                              </span>
                              <div className="history-row-copy">
                                <span className="history-row-title">
                                  {item.senderName || 'Unknown'}
                                  {issue && (
                                    <span className="history-inline-issue">
                                      {issue}
                                    </span>
                                  )}
                                </span>
                                <span className="history-row-sub">
                                  Tap to read review
                                </span>
                              </div>
                              <span className="history-chevron" aria-hidden>
                                {isOpen ? '▾' : '▸'}
                              </span>
                            </button>
                            {isOpen && (
                              <div className="history-row-body">
                                <pre className="history-message">{item.body}</pre>
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default History;
