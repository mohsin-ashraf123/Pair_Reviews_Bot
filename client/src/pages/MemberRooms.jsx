import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API, createSocket } from '../config/api.js';
import './MemberRooms.css';

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusMeta(item, sendTimeLabel) {
  if (item.prompt?.status === 'answered') {
    return { label: 'Answered', tone: 'answered' };
  }
  if (item.prompt?.status === 'failed') {
    return { label: 'Send failed', tone: 'failed' };
  }
  if (item.prompt?.status === 'pending') {
    return { label: 'Awaiting reply', tone: 'awaiting' };
  }
  if (item.preview?.willSend) {
    return { label: `Will be sent ${sendTimeLabel}`, tone: 'queued' };
  }
  if (item.reviewSubmitted) {
    return { label: 'Review submitted', tone: 'done' };
  }
  return { label: 'Nothing pending', tone: 'idle' };
}

function MemberRooms() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [openMember, setOpenMember] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/member-rooms`);
      setData(res.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load member rooms');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const socket = createSocket(io);
    socket.on('member-room:message', () => load());
    socket.on('member-room:update', () => load());
    return () => socket.disconnect();
  }, [load]);

  const runAction = async (key, path, successText) => {
    setBusy(key);
    setFeedback('');
    setError('');
    try {
      await axios.post(`${API}${path}`);
      setFeedback(successText);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(() => {
    const members = data?.members || [];
    return {
      queued: members.filter((m) => m.preview?.willSend).length,
      pending: members.filter((m) => m.prompt?.status === 'pending').length,
      answered: members.filter((m) => m.prompt?.status === 'answered').length,
      submitted: members.filter((m) => m.reviewSubmitted).length,
    };
  }, [data]);

  const sendTimeLabel = data?.sendTimeLabel || '10:50 AM';

  if (loading) {
    return (
      <div className="content-card">
        <p className="muted">Loading member rooms…</p>
      </div>
    );
  }

  return (
    <div className="member-rooms-page">
      <div className="member-rooms-header">
        <div>
          <h2>Member Rooms</h2>
          <p className="muted">
            Tracking reviews for {data?.targetDateLabel || '—'} — whoever is still
            missing gets a private message at {sendTimeLabel}
          </p>
        </div>
        <div className="member-rooms-actions">
          <button
            type="button"
            className="refresh-btn"
            onClick={() => runAction('join', '/member-rooms/join', 'Room join refreshed')}
            disabled={Boolean(busy)}
          >
            {busy === 'join' ? 'Joining…' : 'Re-join rooms'}
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() =>
              runAction(
                'prompts',
                '/member-rooms/send-prompts',
                'Follow-up messages processed'
              )
            }
            disabled={Boolean(busy)}
          >
            {busy === 'prompts' ? 'Sending…' : 'Send follow-ups now'}
          </button>
        </div>
      </div>

      {error && <p className="feedback err">{error}</p>}
      {feedback && <p className="feedback ok">{feedback}</p>}

      <div className="member-stats">
        <div className="member-stat done">
          <span className="member-stat-value">{counts.submitted}</span>
          <span className="member-stat-label">Review submitted</span>
        </div>
        <div className="member-stat queued">
          <span className="member-stat-value">{counts.queued}</span>
          <span className="member-stat-label">Will be messaged</span>
        </div>
        <div className="member-stat awaiting">
          <span className="member-stat-value">{counts.pending}</span>
          <span className="member-stat-label">Awaiting reply</span>
        </div>
        <div className="member-stat answered">
          <span className="member-stat-value">{counts.answered}</span>
          <span className="member-stat-label">Answered</span>
        </div>
      </div>

      <section className="member-summary">
        <div className="member-summary-block">
          <h3>Will be messaged at {sendTimeLabel}</h3>
          {data?.queued?.length ? (
            <div className="member-chip-row">
              {data.queued.map((name) => (
                <span key={name} className="member-chip queued">
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">
              No one — every review for {data?.targetDateLabel} is in.
            </p>
          )}
        </div>

        <div className="member-summary-block">
          <h3>Responses received</h3>
          {data?.answers?.length ? (
            <ul className="member-answer-list">
              {data.answers.map((answer) => (
                <li key={answer.member}>
                  <span className="member-answer-who">{answer.member}</span>
                  <span className="member-answer-pair">{answer.pair.join(' + ')}</span>
                  <span className="member-answer-letter">{answer.letter}</span>
                  <span className="member-answer-label">{answer.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No replies yet.</p>
          )}
        </div>

        <div className="member-summary-block">
          <h3>Attendance from replies</h3>
          <div className="member-chip-row">
            {data?.attendance?.absent?.map((name) => (
              <span key={`a-${name}`} className="member-chip absent">
                {name} · absent
              </span>
            ))}
            {data?.attendance?.halfDay?.map((name) => (
              <span key={`h-${name}`} className="member-chip half-day">
                {name} · half day
              </span>
            ))}
            {data?.attendance?.forgot?.map((name) => (
              <span key={`f-${name}`} className="member-chip forgot">
                {name} · forgot
              </span>
            ))}
            {data?.attendance?.excused?.map((name) => (
              <span key={`e-${name}`} className="member-chip excused">
                {name} · excused
              </span>
            ))}
            {!data?.attendance?.absent?.length &&
              !data?.attendance?.halfDay?.length &&
              !data?.attendance?.forgot?.length &&
              !data?.attendance?.excused?.length && (
                <p className="muted">Nothing marked from replies yet.</p>
              )}
          </div>
        </div>
      </section>

      <div className="member-room-list">
        {data?.members?.map((item) => {
          const status = statusMeta(item, sendTimeLabel);
          const isOpen = openMember === item.member;
          const shownMessage = item.prompt?.message || item.preview?.message;
          const options = item.prompt?.options || item.preview?.options || [];

          return (
            <article key={item.member} className={`member-room-card ${status.tone}`}>
              <button
                type="button"
                className="member-room-head"
                onClick={() => setOpenMember(isOpen ? null : item.member)}
                aria-expanded={isOpen}
              >
                <div className="member-room-identity">
                  <span className="member-avatar">{item.member.slice(0, 2)}</span>
                  <div className="member-room-titles">
                    <span className="member-room-name">{item.member}</span>
                    <span className="member-room-sub">
                      {item.pair ? item.pair.join(' + ') : 'No pair for this date'}
                    </span>
                  </div>
                </div>
                <div className="member-room-meta">
                  <span className={`member-status ${status.tone}`}>{status.label}</span>
                  {!item.joined && <span className="member-status failed">Not joined</span>}
                  <span className="member-chevron">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {item.prompt?.response?.letter && (
                <p className="member-answer">
                  <strong>{item.prompt.response.letter}</strong> — {item.prompt.response.label}
                  <span className="member-answer-time">
                    {formatDateTime(item.prompt.response.respondedAt)}
                  </span>
                </p>
              )}

              {isOpen && (
                <div className="member-room-body">
                  <div className="member-room-info">
                    <span className="member-info-chip">{item.roomId}</span>
                    <span className="member-info-chip">
                      Last sent: {formatDateTime(item.lastPromptAt)}
                    </span>
                    <span className="member-info-chip">
                      Last reply: {formatDateTime(item.lastReplyAt)}
                    </span>
                  </div>

                  {item.joinError && (
                    <p className="feedback err">Join error: {item.joinError}</p>
                  )}
                  {item.prompt?.sendError && (
                    <p className="feedback err">Send error: {item.prompt.sendError}</p>
                  )}

                  <h4 className="member-section-title">
                    {item.prompt ? 'Message sent' : 'Message preview'}
                  </h4>
                  <pre className="member-message-preview">
                    {shownMessage || 'No follow-up needed for this member.'}
                  </pre>

                  {options.length > 0 && (
                    <div className="member-options">
                      {options.map((opt) => (
                        <span
                          key={opt.letter}
                          className={`member-option ${
                            item.prompt?.response?.letter === opt.letter ? 'chosen' : ''
                          }`}
                        >
                          <strong>{opt.letter}</strong> {opt.label}
                        </span>
                      ))}
                    </div>
                  )}

                  <h4 className="member-section-title">Room conversation</h4>
                  <div className="member-thread">
                    {item.messages.length ? (
                      item.messages.map((msg) => (
                        <div
                          key={msg.eventId || msg.id}
                          className={`member-msg ${msg.direction === 'out' ? 'out' : 'in'}`}
                        >
                          <div className="member-msg-head">
                            <span>{msg.senderName}</span>
                            <span>{formatTime(msg.sentAt)}</span>
                          </div>
                          <p className="member-msg-body">{msg.body}</p>
                        </div>
                      ))
                    ) : (
                      <p className="muted">No messages in this room yet.</p>
                    )}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default MemberRooms;
