import { useEffect, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import './Overview.css';

const API = '/api/pairs';
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isWithinLiveWindow(sentAt) {
  if (!sentAt) return false;
  return Date.now() - new Date(sentAt).getTime() <= LIVE_WINDOW_MS;
}

function formatCountdown(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Overview() {
  const [preview, setPreview] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [review, setReview] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await axios.get(`${API}/dashboard`);
        setPreview(res.data.preview);
        setCountdown(res.data.countdown);
        setReview(res.data.review);
        setMessages(res.data.messages || []);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    const socket = io({ path: '/socket.io' });

    socket.on('countdown:update', (data) => setCountdown(data));
    socket.on('review:update', (data) => setReview(data));
    socket.on('room:message', (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.eventId === msg.eventId)) return prev;
        const next = [...prev, msg].filter((m) => isWithinLiveWindow(m.sentAt));
        return next.slice(-50);
      });
    });
    socket.on('room:message:deleted', ({ eventId }) => {
      setMessages((prev) => prev.filter((m) => m.eventId !== eventId));
    });

    const pruneTimer = setInterval(() => {
      setMessages((prev) => prev.filter((m) => isWithinLiveWindow(m.sentAt)));
    }, 60_000);

    return () => {
      clearInterval(pruneTimer);
      socket.disconnect();
    };
  }, []);

  if (loading) {
    return (
      <div className="overview-page">
        <div className="overview-card overview-loading">
          <p className="muted">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  const remainingSeconds = countdown?.remainingSeconds ?? 0;

  return (
    <div className="overview-page">
      <section className="countdown-bar">
        <div>
          <span className="countdown-label">Next daily message</span>
          <p className="countdown-sub">{countdown?.label || '—'}</p>
        </div>
        <div className="countdown-timer">{formatCountdown(remainingSeconds)}</div>
      </section>

      <div className="overview-top">
        <section className="overview-card">
          <div className="overview-card-head">
            <h2>Next Day Pairs</h2>
            <span className="overview-badge">{preview?.dateKey || '—'}</span>
          </div>
          <p className="overview-label">{preview?.previewLabel || '—'}</p>
          <p className="overview-meta">
            Lead: <strong>{preview?.lead || '—'}</strong>
          </p>
          {error && <p className="feedback err">{error}</p>}
          <div className="pair-chips">
            {preview?.allPairs?.map((pair) => (
              <span key={pair.join('-')} className="pair-chip">
                {pair.join(' + ')}
              </span>
            ))}
          </div>
        </section>

        <section className="overview-card overview-message">
          <h2>Message Preview</h2>
          <pre className="message-preview">{preview?.message || '—'}</pre>
        </section>
      </div>

      <div className="overview-bottom">
        <section className="overview-card live-panel">
          <h2>Live Room Messages</h2>
          <p className="overview-label">Last 24 hours — older messages move to History</p>
          <div className="live-messages">
            {messages.filter((m) => isWithinLiveWindow(m.sentAt)).length === 0 ? (
              <p className="muted live-empty">No messages in the last 24 hours…</p>
            ) : (
              messages
                .filter((m) => isWithinLiveWindow(m.sentAt))
                .map((msg) => (
                <div
                  key={msg.eventId || msg.id}
                  className={`live-msg ${msg.direction === 'out' ? 'out' : 'in'}`}
                >
                  <div className="live-msg-head">
                    <span className="live-sender">{msg.senderName}</span>
                    <span className="live-time">{formatTime(msg.sentAt)}</span>
                  </div>
                  <p className="live-body">{msg.body}</p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="overview-card review-panel">
          <h2>Review Status</h2>
          <p className="overview-label">
            {review?.active
              ? 'Pairs pending review before 6:50 PM reminder'
              : 'Reviews open after daily pairs are sent'}
          </p>

          {review?.reviewedMembers?.length > 0 && (
            <div className="review-section">
              <span className="review-section-title">Completed</span>
              <div className="pair-chips">
                {review.reviewedMembers.map((name) => (
                  <span key={name} className="pair-chip done">
                    {name} ✓
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="review-section">
            <span className="review-section-title">Pending pairs</span>
            {review?.pendingPairs?.length ? (
              <div className="pair-chips">
                {review.pendingPairs.map((pair) => (
                  <span key={pair.join('-')} className="pair-chip pending">
                    {pair.join(' + ')}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted review-all-done">
                {review?.active ? 'All reviews submitted 🎉' : '—'}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Overview;
