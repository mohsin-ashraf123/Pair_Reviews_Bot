import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [chatOpen, setChatOpen] = useState(false);
  const [chatVisible, setChatVisible] = useState(false);
  const chatScrollRef = useRef(null);
  const chatCloseTimer = useRef(null);

  const openChat = () => {
    if (chatCloseTimer.current) {
      clearTimeout(chatCloseTimer.current);
      chatCloseTimer.current = null;
    }
    setChatVisible(true);
    // Next frame so CSS can transition from the closed state.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setChatOpen(true));
    });
  };

  const closeChat = () => {
    setChatOpen(false);
    if (chatCloseTimer.current) clearTimeout(chatCloseTimer.current);
    chatCloseTimer.current = setTimeout(() => {
      setChatVisible(false);
      chatCloseTimer.current = null;
    }, 420);
  };

  const toggleChat = () => {
    if (chatOpen) closeChat();
    else openChat();
  };

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await axios.get(`${API}/dashboard`);
        if (cancelled) return;
        setPreview(res.data.preview);
        setCountdown(res.data.countdown);
        setSchedules(res.data.schedules || []);
        setReview(res.data.review);
        setMessages(res.data.messages || []);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Failed to load dashboard');
        }
      } finally {
        // Keep skeleton visible briefly so the shimmer is noticeable on fast loads.
        const wait = Math.max(0, 450 - (Date.now() - started));
        setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, wait);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
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
          exampleNote: previewById[job.id]?.exampleNote ?? job.exampleNote ?? null,
          exampleForDate:
            previewById[job.id]?.exampleForDate || job.exampleForDate || null,
          recipients: previewById[job.id]?.recipients || job.recipients || [],
          messages: previewById[job.id]?.messages || job.messages || [],
          skipped: previewById[job.id]?.skipped || job.skipped || [],
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

  // Local second-tick from absolute nextSendAt so the UI keeps moving
  // even if the socket briefly disconnects.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setSchedules((prev) => {
        if (!prev.length) return prev;
        let changed = false;
        const next = prev.map((job) => {
          if (!job.nextSendAt) return job;
          const remainingSeconds = Math.max(
            0,
            Math.floor((new Date(job.nextSendAt).getTime() - now) / 1000)
          );
          if (remainingSeconds === job.remainingSeconds) return job;
          changed = true;
          return { ...job, remainingSeconds };
        });
        return changed ? next : prev;
      });
      setCountdown((prev) => {
        if (!prev?.nextSendAt) return prev;
        const remainingSeconds = Math.max(
          0,
          Math.floor((new Date(prev.nextSendAt).getTime() - now) / 1000)
        );
        if (remainingSeconds === prev.remainingSeconds) return prev;
        return { ...prev, remainingSeconds };
      });
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const liveMessages = useMemo(
    () =>
      [...messages]
        .filter((m) => isWithinLiveWindow(m.sentAt))
        .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt)),
    [messages]
  );

  const nextJob = useMemo(() => {
    if (!schedules.length) return null;
    return [...schedules].sort(
      (a, b) => (a.remainingSeconds ?? 0) - (b.remainingSeconds ?? 0)
    )[0];
  }, [schedules]);

  useEffect(() => {
    if (!chatOpen || !chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatOpen, liveMessages]);

  useEffect(
    () => () => {
      if (chatCloseTimer.current) clearTimeout(chatCloseTimer.current);
    },
    []
  );

  if (loading) {
    return (
      <div className="overview-page ov-skeleton" aria-busy="true" aria-label="Loading overview">
        <section className="ov-hero ov-skel-hero">
          <div className="ov-skel-hero-copy">
            <span className="ov-skel-line ov-skel-title" />
            <span className="ov-skel-line ov-skel-sub" />
          </div>
          <span className="ov-skel-timer" />
        </section>

        <div className="ov-body">
          <section className="ov-panel">
            <div className="ov-panel-head">
              <span className="ov-skel-line ov-skel-h2" />
            </div>
            <div className="ov-schedule-list">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="ov-skel-row">
                  <span className="ov-skel-line ov-skel-time" />
                  <span className="ov-skel-line ov-skel-row-title" />
                </div>
              ))}
            </div>
          </section>

          <aside className="ov-panel ov-side-stack">
            <div className="ov-side-block">
              <span className="ov-skel-line ov-skel-h2" />
              <div className="ov-skel-chips">
                <span className="ov-skel-chip" />
                <span className="ov-skel-chip" />
                <span className="ov-skel-chip" />
              </div>
              <span className="ov-skel-block" />
            </div>
            <div className="ov-side-block">
              <span className="ov-skel-line ov-skel-h2" />
              <div className="ov-skel-chips">
                <span className="ov-skel-chip ov-skel-chip-wide" />
                <span className="ov-skel-chip" />
              </div>
            </div>
          </aside>
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

      <div className="ov-body">
        <section className="ov-panel">
          <div className="ov-panel-head">
            <div>
              <h2>Today’s schedule</h2>
              <p className="ov-hint">Mon–Fri · Asia/Karachi · tap row for preview</p>
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
                        <span className="ov-chevron" aria-hidden>
                          {isOpen ? '▾' : '▸'}
                        </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="ov-schedule-preview">
                      {job.description && (
                        <p className="ov-preview-desc">{job.description}</p>
                      )}

                      {job.exampleNote && (
                        <p className="ov-preview-note">{job.exampleNote}</p>
                      )}

                      {job.exampleForDate && (
                        <p className="ov-preview-date">
                          For date: <strong>{job.exampleForDate}</strong>
                        </p>
                      )}

                      {Array.isArray(job.recipients) && job.recipients.length > 0 && (
                        <div className="ov-preview-block">
                          <p className="ov-preview-label">Who gets it</p>
                          <ul className="ov-preview-recipients">
                            {job.recipients.map((r) => (
                              <li key={`${r.name}-${r.role}`}>
                                <strong>{r.name}</strong>
                                <span>
                                  {r.role}
                                  {r.via ? ` · ${r.via}` : ''}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {Array.isArray(job.messages) && job.messages.length > 0 ? (
                        <div className="ov-preview-block">
                          <p className="ov-preview-label">Messages (in order)</p>
                          <div className="ov-preview-msgs">
                            {job.messages.map((msg, idx) => (
                              <article
                                key={`${job.id}-msg-${idx}`}
                                className="ov-preview-msg-card"
                              >
                                <header>
                                  <span>{msg.label || `Message ${idx + 1}`}</span>
                                  {msg.to && msg.to !== '—' && (
                                    <span className="ov-preview-to">→ {msg.to}</span>
                                  )}
                                </header>
                                <pre>{msg.body}</pre>
                              </article>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <pre className="ov-preview-msg">
                          {job.example || 'No preview available yet.'}
                        </pre>
                      )}

                      {Array.isArray(job.skipped) && job.skipped.length > 0 && (
                        <div className="ov-preview-block">
                          <p className="ov-preview-label">Skipped</p>
                          <ul className="ov-preview-skipped">
                            {job.skipped.map((s) => (
                              <li key={`${s.pair}-${s.reason}`}>
                                <strong>{s.pair}</strong>
                                <span>{s.reason}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <aside className="ov-panel ov-side-stack">
          <div className="ov-side-block">
            <div className="ov-panel-head">
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
          </div>

          <div className="ov-side-block">
            <div className="ov-panel-head">
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
          </div>
        </aside>
      </div>

      {chatVisible && (
        <button
          type="button"
          className={`ov-chat-backdrop${chatOpen ? ' is-open' : ''}`}
          aria-label="Close chat"
          onClick={closeChat}
        />
      )}

      <div className={`ov-chat-dock${chatOpen ? ' open' : ''}`}>
        {chatVisible && (
          <section
            className={`ov-chat-panel${chatOpen ? ' is-open' : ''}`}
            role="dialog"
            aria-label="Live room chat"
          >
            <header className="ov-chat-panel-head">
              <div>
                <h2>Live room chat</h2>
                <p>Last 24 hours · {liveMessages.length} messages</p>
              </div>
              <button
                type="button"
                className="ov-chat-close"
                onClick={closeChat}
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div className="ov-chat-panel-body" ref={chatScrollRef}>
              {liveMessages.length === 0 ? (
                <p className="muted ov-chat-empty">No messages in the last 24 hours</p>
              ) : (
                liveMessages.map((msg) => {
                  const fromBot = msg.direction === 'out';
                  return (
                    <article
                      key={msg.eventId || msg.id}
                      className={`ov-chat-bubble ${fromBot ? 'bot' : 'user'}`}
                    >
                      <header className="ov-chat-bubble-meta">
                        <strong>{msg.senderName}</strong>
                        <time>{formatTime(msg.sentAt)}</time>
                      </header>
                      <p className="ov-chat-bubble-text">{msg.body}</p>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        )}

        <button
          type="button"
          className={`ov-chat-fab${chatOpen ? ' active' : ''}`}
          onClick={toggleChat}
          aria-expanded={chatOpen}
          aria-label={chatOpen ? 'Close live chat' : 'Open live chat'}
        >
          {chatOpen ? (
            <span className="ov-chat-fab-x">×</span>
          ) : (
            <>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16h-.5A1.5 1.5 0 0 1 4 14.5Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              {liveMessages.length > 0 && (
                <span className="ov-chat-fab-badge">
                  {liveMessages.length > 99 ? '99+' : liveMessages.length}
                </span>
              )}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default Overview;
