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
        <div className="ov-card ov-loading">
          <p className="muted">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  const remainingSeconds =
    nextJob?.remainingSeconds ?? countdown?.remainingSeconds ?? 0;

  return (
    <div className="overview-page">
      <section className="ov-hero">
        <div className="ov-hero-copy">
          <p className="ov-kicker">Next send</p>
          <h1 className="ov-hero-title">
            {nextJob?.title || 'Daily pairs message'}
          </h1>
          <p className="ov-hero-sub">
            {nextJob
              ? `${nextJob.destination} · ${nextJob.nextLabel}`
              : countdown?.label || '—'}
          </p>
        </div>
        <div className="ov-hero-timer" aria-label="Countdown">
          {formatCountdown(remainingSeconds)}
        </div>
      </section>

      <section className="ov-card">
        <div className="ov-section-head">
          <div>
            <h2>Today’s schedule</h2>
            <p className="ov-hint">Mon–Fri · Asia/Karachi · tap a row for message preview</p>
          </div>
        </div>

        <div className="ov-schedule-list">
          {schedules.map((job) => {
            const isOpen = expandedSchedule === job.id;
            const isNext = nextJob?.id === job.id;
            return (
              <div
                key={job.id}
                className={`ov-schedule-row${isOpen ? ' open' : ''}${isNext ? ' next' : ''}`}
              >
                <button
                  type="button"
                  className="ov-schedule-btn"
                  onClick={() => setExpandedSchedule(isOpen ? null : job.id)}
                  aria-expanded={isOpen}
                >
                  <span className="ov-schedule-time">{job.timeLabel || job.time}</span>
                  <span className="ov-schedule-info">
                    <span className="ov-schedule-title">
                      {job.title}
                      {isNext && <span className="ov-next-tag">Next</span>}
                    </span>
                    <span className="ov-schedule-dest">{job.destination}</span>
                  </span>
                  <span className="ov-schedule-right">
                    <span className="ov-schedule-count">
                      {formatCountdown(job.remainingSeconds)}
                    </span>
                    <span className="ov-chevron">{isOpen ? '−' : '+'}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="ov-schedule-preview">
                    {job.description && (
                      <p className="ov-preview-desc">{job.description}</p>
                    )}
                    <pre className="ov-preview-msg">
                      {job.example || 'No preview available yet.'}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="ov-split">
        <section className="ov-card">
          <div className="ov-section-head">
            <div>
              <h2>Next pairs</h2>
              <p className="ov-hint">{preview?.previewLabel || '—'}</p>
            </div>
            <span className="ov-pill">{preview?.dateKey || '—'}</span>
          </div>

          <p className="ov-lead">
            Lead <strong>{preview?.lead || '—'}</strong>
          </p>
          {error && <p className="feedback err">{error}</p>}

          <div className="ov-chips">
            {preview?.allPairs?.map((pair) => (
              <span key={pair.join('-')} className="ov-chip">
                {pair.join(' + ')}
              </span>
            ))}
          </div>

          <pre className="ov-pairs-msg">{preview?.message || '—'}</pre>
        </section>

        <section className="ov-card">
          <div className="ov-section-head">
            <div>
              <h2>Review status</h2>
              <p className="ov-hint">
                {review?.active
                  ? 'Pending before 6:50 PM reminder'
                  : 'Opens after today’s pairs are sent'}
              </p>
            </div>
          </div>

          {review?.reviewedMembers?.length > 0 && (
            <div className="ov-review-block">
              <p className="ov-review-label">Done</p>
              <div className="ov-chips">
                {review.reviewedMembers.map((name) => (
                  <span key={name} className="ov-chip done">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="ov-review-block">
            <p className="ov-review-label">Pending</p>
            {review?.pendingPairs?.length ? (
              <div className="ov-chips">
                {review.pendingPairs.map((pair) => (
                  <span key={pair.join('-')} className="ov-chip pending">
                    {pair.join(' + ')}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">
                {review?.active ? 'All reviews submitted' : 'Nothing pending yet'}
              </p>
            )}
          </div>
        </section>
      </div>

      <section className={`ov-card ov-chat${chatExpanded ? ' expanded' : ''}`}>
        <div className="ov-section-head">
          <div>
            <h2>Live room chat</h2>
            <p className="ov-hint">Last 24 hours · older messages move to History</p>
          </div>
          <button
            type="button"
            className="ov-text-btn"
            onClick={() => setChatExpanded((value) => !value)}
          >
            {chatExpanded ? 'Collapse' : 'Expand'}
          </button>
        </div>

        <div className={`ov-chat-scroll${chatExpanded ? ' tall' : ''}`}>
          {liveMessages.length === 0 ? (
            <p className="muted ov-chat-empty">No messages in the last 24 hours</p>
          ) : (
            liveMessages.map((msg) => (
              <article
                key={msg.eventId || msg.id}
                className={`ov-msg ${msg.direction === 'out' ? 'out' : 'in'}`}
              >
                <header className="ov-msg-head">
                  <span>{msg.senderName}</span>
                  <time>{formatTime(msg.sentAt)}</time>
                </header>
                <p className="ov-msg-body">{msg.body}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export default Overview;
