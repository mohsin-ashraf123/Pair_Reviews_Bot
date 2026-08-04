import { useEffect, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import './History.css';

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function noticeLabel(category) {
  if (category === 'bot_reminder') return 'Reminder';
  if (category === 'bot_missed') return 'Missed review';
  if (category === 'bot_wrong_pair') return 'Wrong pair';
  if (category === 'bot_duplicate') return 'Duplicate review';
  return 'Notice';
}

function History() {
  const [tab, setTab] = useState('pairs');
  const [pairs, setPairs] = useState([]);
  const [botNotices, setBotNotices] = useState([]);
  const [reviews, setReviews] = useState([]);
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
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load history');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="content-card">
        <p className="muted">Loading message history…</p>
      </div>
    );
  }

  return (
    <div className="history-page">
      <div className="history-header">
        <h2>Message History</h2>
        <p className="muted">Archived messages older than 24 hours</p>
      </div>

      <div className="history-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`history-tab ${tab === 'pairs' ? 'active' : ''}`}
          onClick={() => setTab('pairs')}
          aria-selected={tab === 'pairs'}
        >
          Pairs Messages
          <span className="history-tab-count">{pairs.length + botNotices.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={`history-tab reviews-tab ${tab === 'reviews' ? 'active' : ''}`}
          onClick={() => setTab('reviews')}
          aria-selected={tab === 'reviews'}
        >
          Review Messages
          <span className="history-tab-count">{reviews.length}</span>
        </button>
      </div>

      {error && <p className="feedback err">{error}</p>}

      {tab === 'pairs' && (
        <section className="history-section pairs-section">
          {!pairs.length && !botNotices.length && !error ? (
            <div className="content-card empty-state">
              <p className="muted">No pairs messages archived yet.</p>
            </div>
          ) : (
            <div className="history-list">
              {botNotices.map((item) => {
                const id = item._id || item.eventId;
                const isOpen = expandedId === id;
                return (
                  <article key={id} className="history-item notice-item">
                    <button
                      type="button"
                      className="history-item-head"
                      onClick={() => setExpandedId(isOpen ? null : id)}
                      aria-expanded={isOpen}
                    >
                      <div className="history-item-main">
                        <span className={`notice-badge ${item.category}`}>
                          {noticeLabel(item.category)}
                        </span>
                        <span className="history-date">{item.dateKey || '—'}</span>
                        {item.alertTriggeredBy && (
                          <span className="history-lead">By: {item.alertTriggeredBy}</span>
                        )}
                      </div>
                      <div className="history-item-meta">
                        <span className="history-time">{formatDateTime(item.sentAt)}</span>
                        <span className="history-chevron">{isOpen ? '▲' : '▼'}</span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="history-item-body">
                        <pre className="history-message">{item.body}</pre>
                      </div>
                    )}
                  </article>
                );
              })}

              {pairs.map((item) => {
                const id = item._id || item.dateKey;
                const isOpen = expandedId === id;
                const pairList = item.allPairs || item.pairs || [];
                const pairLabels = pairList.map((p) =>
                  Array.isArray(p) ? p.join(' + ') : p
                );

                return (
                  <article key={id} className="history-item pairs-item">
                    <button
                      type="button"
                      className="history-item-head"
                      onClick={() => setExpandedId(isOpen ? null : id)}
                      aria-expanded={isOpen}
                    >
                      <div className="history-item-main">
                        <span className="pairs-badge">Daily pairs</span>
                        <span className="history-date">{item.dateKey}</span>
                        <span className="history-lead">Lead: {item.lead || '—'}</span>
                      </div>
                      <div className="history-item-meta">
                        <span className={`history-tag ${item.triggeredBy}`}>
                          {item.triggeredBy === 'cron' ? 'Auto' : 'Manual'}
                        </span>
                        <span className="history-time">{formatDateTime(item.sentAt)}</span>
                        <span className="history-chevron">{isOpen ? '▲' : '▼'}</span>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="history-item-body">
                        <div className="history-pairs">
                          {pairLabels.map((p) => (
                            <span key={p} className="history-pair-chip">
                              {p}
                            </span>
                          ))}
                        </div>
                        <pre className="history-message">{item.message}</pre>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === 'reviews' && (
        <section className="history-section reviews-section">
          {!reviews.length && !error ? (
            <div className="content-card empty-state">
              <p className="muted">No review messages archived yet.</p>
            </div>
          ) : (
            <div className="review-history-list">
              {reviews.map((item) => (
                <article key={item._id || item.eventId} className="review-history-item">
                  <div className="review-history-head">
                    <span className="review-sender">{item.senderName}</span>
                    {item.reviewIssue && (
                      <span className={`review-issue ${item.reviewIssue}`}>
                        {item.reviewIssue === 'wrong_pair' ? 'Wrong pair' : 'Duplicate'}
                      </span>
                    )}
                    <span className="review-date-key">{item.dateKey}</span>
                    <span className="review-time">{formatDateTime(item.sentAt)}</span>
                  </div>
                  <p className="review-body">{item.body}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default History;
