import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API, API_BASE, createSocket } from '../config/api.js';
import './MemberRooms.css';

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function snippet(text, max = 72) {
  if (!text) return '';
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function avatarSrc(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${API_BASE}${path}`;
}

function MemberAvatar({ member, avatarUrl }) {
  const [failed, setFailed] = useState(false);
  const initials = (member || '?').slice(0, 2).toUpperCase();

  if (!avatarUrl || failed) {
    return (
      <span className="member-avatar fallback" aria-hidden>
        {initials}
      </span>
    );
  }

  return (
    <img
      className="member-avatar"
      src={avatarSrc(avatarUrl)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function statusMeta(item, leadTimeLabel, discussionTimeLabel) {
  if (item.discussion?.status === 'pending') {
    return { label: 'Awaiting meeting reply', tone: 'awaiting' };
  }
  if (item.discussion?.status === 'answered') {
    return { label: 'Meeting check done', tone: 'done' };
  }
  if (item.discussion?.willSend) {
    return { label: `Meeting · ${discussionTimeLabel}`, tone: 'discussion' };
  }
  if (item.preview?.willSend) {
    return { label: `Lead · ${leadTimeLabel}`, tone: 'queued' };
  }
  if (item.reviewSubmitted) {
    return { label: 'Review in', tone: 'done' };
  }
  if (!item.joined) {
    return { label: 'Not joined', tone: 'failed' };
  }
  return { label: 'Idle', tone: 'idle' };
}

function MemberRoomsSkeleton() {
  return (
    <div className="member-rooms-page member-rooms-skeleton" aria-busy="true">
      <div className="member-rooms-header">
        <div>
          <span className="mr-skel-line mr-skel-title" />
          <span className="mr-skel-line mr-skel-sub" />
        </div>
      </div>
      <div className="member-room-list">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="mr-skel-row">
            <span className="mr-skel-line mr-skel-avatar" />
            <span className="mr-skel-line mr-skel-name" />
            <span className="mr-skel-line mr-skel-status" />
          </div>
        ))}
      </div>
    </div>
  );
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

  const leadTimeLabel = data?.sendTimeLabel || '10:50 AM';
  const discussionTimeLabel = data?.discussionTimeLabel || '5:00 PM';
  const discussionQueued = data?.discussionQueued || [];

  const sortedMembers = useMemo(() => {
    const members = [...(data?.members || [])];
    members.sort((a, b) => {
      const score = (item) => {
        if (item.discussion?.willSend || item.discussion?.status === 'pending')
          return 0;
        if (item.preview?.willSend) return 1;
        return 2;
      };
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      return a.member.localeCompare(b.member);
    });
    return members;
  }, [data?.members]);

  if (loading) return <MemberRoomsSkeleton />;

  return (
    <div className="member-rooms-page">
      <div className="member-rooms-header">
        <div>
          <p className="member-rooms-kicker">Personal rooms</p>
          <h2>Member Rooms</h2>
          <p className="member-rooms-subtitle">
            {data?.targetDateLabel || '—'} follow-ups · meeting check at{' '}
            {discussionTimeLabel}
          </p>
        </div>
        <div className="member-rooms-actions">
          <button
            type="button"
            className="refresh-btn"
            onClick={() =>
              runAction('join', '/member-rooms/join', 'Rooms refreshed')
            }
            disabled={Boolean(busy)}
          >
            {busy === 'join' ? 'Joining…' : 'Re-join'}
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() =>
              runAction(
                'prompts',
                '/member-rooms/send-prompts',
                'Follow-ups processed'
              )
            }
            disabled={Boolean(busy)}
          >
            {busy === 'prompts' ? 'Sending…' : 'Send now'}
          </button>
        </div>
      </div>

      {error && <p className="feedback err">{error}</p>}
      {feedback && <p className="feedback ok">{feedback}</p>}

      <section className="member-queue-banner">
        <div className="member-queue-banner-copy">
          <p className="member-queue-kicker">Today · {discussionTimeLabel}</p>
          <h3>Meeting discussion check</h3>
          <p>
            {discussionQueued.length
              ? `Asking if yesterday’s pair review (${data?.discussionReviewDateLabel || '—'}) was discussed in today’s meeting.`
              : data?.discussionNote ||
                'No meeting-check DMs queued for today.'}
          </p>
        </div>
        <div className="member-queue-people">
          {discussionQueued.length ? (
            discussionQueued.map((entry) => {
              const memberItem = data?.members?.find(
                (m) => m.member === entry.member
              );
              return (
                <button
                  key={entry.member}
                  type="button"
                  className="member-queue-chip"
                  onClick={() => setOpenMember(entry.member)}
                  title={
                    entry.pair?.length
                      ? entry.pair.join(' + ')
                      : entry.member
                  }
                >
                  <MemberAvatar
                    member={entry.member}
                    avatarUrl={memberItem?.avatarUrl}
                  />
                  <span>
                    <strong>{entry.member}</strong>
                    {entry.pair?.length ? (
                      <small>{entry.pair.join(' + ')}</small>
                    ) : null}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="muted">Nobody in the 5:00 PM queue right now.</p>
          )}
        </div>
      </section>

      <div className="member-room-list">
        <div className="member-room-list-head">
          <h3>Conversations</h3>
          <span>{sortedMembers.length} rooms</span>
        </div>

        {sortedMembers.map((item) => {
          const status = statusMeta(item, leadTimeLabel, discussionTimeLabel);
          const isOpen = openMember === item.member;
          const previewText =
            (item.discussion?.willSend && item.discussion.message) ||
            item.lastMessagePreview ||
            (item.pair ? item.pair.join(' + ') : 'No messages yet');

          return (
            <article
              key={item.member}
              className={`member-room-card ${status.tone}${isOpen ? ' open' : ''}`}
            >
              <button
                type="button"
                className="member-room-head"
                onClick={() => setOpenMember(isOpen ? null : item.member)}
                aria-expanded={isOpen}
              >
                <div className="member-room-identity">
                  <MemberAvatar
                    member={item.member}
                    avatarUrl={item.avatarUrl}
                  />
                  <div className="member-room-titles">
                    <span className="member-room-name">
                      {item.member}
                      {item.isLead ? (
                        <span className="member-lead-tag">Lead</span>
                      ) : null}
                    </span>
                    <span className="member-room-sub">
                      {snippet(previewText)}
                    </span>
                  </div>
                </div>
                <div className="member-room-meta">
                  <span className={`member-status ${status.tone}`}>
                    {status.label}
                  </span>
                  <span className="member-chevron" aria-hidden>
                    {isOpen ? '▾' : '▸'}
                  </span>
                </div>
              </button>

              {isOpen && (
                <div className="member-room-body">
                  {item.joinError && (
                    <p className="feedback err">Join error: {item.joinError}</p>
                  )}

                  <div className="member-thread">
                    {item.messages?.length ? (
                      item.messages.map((msg) => (
                        <div
                          key={msg.eventId || msg.id}
                          className={`member-msg ${
                            msg.direction === 'out' ? 'out' : 'in'
                          }${msg.scheduled ? ' scheduled' : ''}`}
                        >
                          <div className="member-msg-head">
                            <span>
                              {msg.scheduled
                                ? msg.scheduleKind === 'discussion'
                                  ? `Scheduled · ${discussionTimeLabel}`
                                  : `Scheduled · ${leadTimeLabel}`
                                : msg.senderName ||
                                  (msg.direction === 'out'
                                    ? 'Bot'
                                    : item.member)}
                            </span>
                            <span>
                              {msg.scheduled
                                ? 'pending'
                                : formatTime(msg.sentAt)}
                            </span>
                          </div>
                          <p className="member-msg-body">{msg.body}</p>
                        </div>
                      ))
                    ) : (
                      <p className="muted member-thread-empty">
                        No messages in this room yet.
                      </p>
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
