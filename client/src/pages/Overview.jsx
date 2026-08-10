import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API, createSocket } from '../config/api.js';
import './Overview.css';

const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isWithinLiveWindow(sentAt) {
  if (!sentAt) return false;
  return Date.now() - new Date(sentAt).getTime() <= LIVE_WINDOW_MS;
}

function formatCountdown(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
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
  const [schedules, setSchedules] = useState([]);
  const [review, setReview] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedSchedule, setExpandedSchedule] = useState(null);
  const [chatExpanded, setChatExpanded] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await axios.get(`${API}/dashboard`);
        setPreview(res.data.preview);
        setCountdown(res.data.countdown);
        setSchedules(res.data.schedules || []);
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
    const socket = createSocket(io);

    socket.on('countdown:update', (data) => setCountdown(data));
    socket.on('schedules:update', (data) => {
      setSchedules((prev) => {
        if (!Array.isArray(data) || !data.length) return prev;
        // Keep message previews from the initial dashboard load; only refresh timers.
        const previewById = Object.fromEntries(prev.map((item) => [item.id, item]));
        return data.map((job) => ({
          ...previewById[job.id],
          ...job,
          example: previewById[job.id]?.example || job.example || '',
          description: previewById[job.id]?.description || job.description || '',
        }));
      });
    });
    socket.on('review:update', (data) => setReview(data));
    socket.on('room:message', (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.eventId === msg.eventId)) {
          return prev.map((m) => (m.eventId === msg.eventId ? { ...m, ...msg } : m));
        }
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

  const liveMessages = useMemo(
    () => messages.filter((m) => isWithinLiveWindow(m.sentAt)),
    [messages]
  );

  const nextJob = useMemo(() => {
    if (!schedules.length) return null;
    return [...schedules].sort(
      (a, b) => (a.remainingSeconds ?? 0) - (b.remainingSeconds ?? 0)
    )[0];
  }, [schedules]);

  if (loading) {
    return (
      <div className="overview-page">
        <div className="overview-card overview-loading">
          <p className="muted">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  const remainingSeconds =
    nextJob?.remainingSeconds ?? countdown?.remainingSeconds ?? 0;

  return (
    <div className={`overview-page${chatExpanded ? ' chat-expanded' : ''}`}>
      <section className="countdown-bar">
        <div>
          <span className="countdown-label">Next automated message</span>
          <p className="countdown-sub">
            {nextJob
              ? `${nextJob.title} · ${nextJob.destination} · ${nextJob.nextLabel}`
              : countdown?.label || '—'}
          </p>
        </div>
        <div className="countdown-timer">{formatCountdown(remainingSeconds)}</div>
      </section>

      <section className="overview-card schedule-board">
        <div className="overview-card-head">
          <h2>Message schedule</h2>
          <span className="overview-badge">Mon–Fri · Asia/Karachi</span>
        </div>
        <p className="overview-label">
          Where each automated message goes, and how long until the next send
        </p>

        <div className="schedule-grid">
          {schedules.map((job) => {
            const isOpen = expandedSchedule === job.id;
            return (
              <article
                key={job.id}
                className={`schedule-tile ${job.destinationKind}${isOpen ? ' open' : ''}`}
              >
                <button
                  type="button"
                  className="schedule-tile-head"
                  onClick={() => setExpandedSchedule(isOpen ? null : job.id)}
                  aria-expanded={isOpen}
                >
                  <div className="schedule-tile-main">
                    <span className="schedule-time">{job.timeLabel || job.time}</span>
                    <span className="schedule-title">{job.title}</span>
                    <span
                      className={`schedule-dest ${job.destinationKind || 'main'}`}
                    >
                      {job.destination}
                    </span>
                  </div>
                  <div className="schedule-tile-meta">
                    <span className="schedule-countdown">
                      {formatCountdown(job.remainingSeconds)}
                    </span>
                    <span className="schedule-chevron">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </button>

                {isOpen && (
                  <div className="schedule-tile-body">
                    <p className="schedule-desc">{job.description}</p>
                    {job.exampleNote && (
                      <p className="schedule-note">{job.exampleNote}</p>
                    )}
                    <pre className="schedule-example">
                      {job.example || 'No preview available yet.'}
                    </pre>
                  </div>
                )}
              </article>
            );
          })}
        </div>
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
          <h2>Pairs message preview</h2>
          <pre className="message-preview">{preview?.message || '—'}</pre>
        </section>
      </div>

      <div className="overview-bottom">
        <section className={`overview-card live-panel${chatExpanded ? ' expanded' : ''}`}>
          <div className="live-panel-head">
            <div>
              <h2>Live Room Messages</h2>
              <p className="overview-label">
                Last 24 hours — older messages move to History
              </p>
            </div>
            <button
              type="button"
              className="chat-expand-btn"
              onClick={() => setChatExpanded((value) => !value)}
            >
              {chatExpanded ? 'Collapse chat' : 'Expand chat'}
            </button>
          </div>

          <div className={`live-messages-scroll${chatExpanded ? ' tall' : ''}`}>
            <div className="live-messages">
              {liveMessages.length === 0 ? (
                <p className="muted live-empty">No messages in the last 24 hours…</p>
              ) : (
                liveMessages.map((msg) => (
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
          </div>
        </section>

        {!chatExpanded && (
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
        )}
      </div>
    </div>
  );
}

export default Overview;
