import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { API, API_BASE, createSocket } from '../config/api.js';
import './LeadReports.css';

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function pairLabel(pair = []) {
  return Array.isArray(pair) ? pair.join(' + ') : '—';
}

function stageTone(stage) {
  if (stage === 'completed') return 'done';
  if (stage === 'awaiting_ready' || stage === 'idle') return 'idle';
  if (stage === 'awaiting_forgot_reason') return 'awaiting';
  return 'active';
}

function avatarSrc(path) {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${API_BASE}${path}`;
}

function LeadAvatar({ name, avatarUrl, size = 'md' }) {
  const [failed, setFailed] = useState(false);
  const initials = (name || '?').slice(0, 2).toUpperCase();

  if (!avatarUrl || failed) {
    return (
      <span className={`lead-avatar fallback size-${size}`} aria-hidden>
        {initials}
      </span>
    );
  }

  return (
    <img
      className={`lead-avatar size-${size}`}
      src={avatarSrc(avatarUrl)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 8v5l3 2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 12a8.5 8.5 0 1 0 2.2-5.6L3.5 8.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 3.5v5h5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LeadReportsSkeleton() {
  return (
    <div className="lead-page lead-skeleton" aria-busy="true">
      <div className="lead-body">
        <span className="lead-skel-line lead-skel-hero" />
        <span className="lead-skel-line lead-skel-chat" />
      </div>
    </div>
  );
}

function LeadReports() {
  const [data, setData] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef(null);

  const load = useCallback(async (dateKey, { soft = false } = {}) => {
    if (soft) setSwitching(true);
    else setLoading(true);
    try {
      const url = dateKey
        ? `${API}/lead-reports/${encodeURIComponent(dateKey)}`
        : `${API}/lead-report`;
      const res = await axios.get(url);
      setData(res.data);
      setSelectedKey(res.data.dateKey);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load lead reports');
    } finally {
      setLoading(false);
      setSwitching(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  useEffect(() => {
    const socket = createSocket(io);
    const refresh = () => {
      if (selectedKey) load(selectedKey, { soft: true });
      else load(null, { soft: true });
    };
    socket.on('member-room:message', refresh);
    socket.on('member-room:update', refresh);
    socket.on('review:update', refresh);
    return () => socket.disconnect();
  }, [load, selectedKey]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const onPointer = (event) => {
      if (!historyRef.current?.contains(event.target)) {
        setHistoryOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  const history = data?.history || [];
  const session = data?.session;
  const messages = data?.messages || [];

  const decisions = useMemo(() => {
    const rows = [];
    for (const d of session?.verifyDecisions || []) {
      rows.push({
        id: `v-${pairLabel(d.pair)}-${d.decidedAt}`,
        kind: 'verify',
        pair: d.pair,
        badge: d.verified ? 'YES' : 'NO',
        tone: d.verified ? 'yes' : 'no',
        detail: d.verified ? 'Review verified' : 'Review not verified',
        at: d.decidedAt,
      });
    }
    for (const d of session?.pairDecisions || []) {
      rows.push({
        id: `m-${pairLabel(d.pair)}-${d.letter}-${d.decidedAt}`,
        kind: 'missing',
        pair: d.pair,
        badge: d.letter || '?',
        tone: 'letter',
        detail: `${d.label || ''}${d.forgotReason ? ` — ${d.forgotReason}` : ''}`,
        at: d.decidedAt,
      });
    }
    rows.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
    return rows;
  }, [session]);

  const attendanceChips = useMemo(() => {
    const chips = [];
    for (const n of data?.attendance?.absent || []) {
      chips.push({ key: `a-${n}`, label: `${n} · absent`, tone: 'absent' });
    }
    for (const n of data?.attendance?.halfDay || []) {
      chips.push({ key: `h-${n}`, label: `${n} · half day`, tone: 'half-day' });
    }
    for (const n of data?.attendance?.forgot || []) {
      chips.push({ key: `f-${n}`, label: `${n} · forgot`, tone: 'forgot' });
    }
    for (const n of data?.attendance?.excused || []) {
      chips.push({ key: `e-${n}`, label: `${n} · excused`, tone: 'excused' });
    }
    return chips;
  }, [data?.attendance]);

  const verifyTotal = (session?.verifyDecisions || []).length;
  const verified = (session?.verifyDecisions || []).filter((d) => d.verified)
    .length;
  const missingCount = (session?.pairDecisions || []).length;

  const selectDay = (dateKey) => {
    setHistoryOpen(false);
    load(dateKey, { soft: true });
  };

  if (loading && !data) return <LeadReportsSkeleton />;

  return (
    <div className="lead-page">
      {error && <p className="feedback err">{error}</p>}

      <div className={`lead-body${switching ? ' is-switching' : ''}`}>
        <section className="lead-report">
          <div className="lead-toolbar">
            <div className="lead-toolbar-main">
              <LeadAvatar
                name={data?.lead}
                avatarUrl={data?.leadAvatarUrl}
                size="md"
              />
              <div className="lead-toolbar-copy">
                <strong>{data?.dateLabel || '—'}</strong>
                <span>
                  {data?.lead || '—'}
                  {session ? (
                    <span className={`lead-stage-pill ${stageTone(session.stage)}`}>
                      {session.stageLabel}
                    </span>
                  ) : null}
                </span>
              </div>
            </div>

            <div className="lead-toolbar-actions" ref={historyRef}>
              <div className="lead-history-wrap">
                <button
                  type="button"
                  className={`lead-icon-btn${historyOpen ? ' open' : ''}`}
                  aria-label="Open history"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((v) => !v)}
                >
                  <HistoryIcon />
                </button>

                {historyOpen && (
                  <div className="lead-history-menu" role="menu">
                    <div className="lead-history-menu-head">History</div>
                    {!history.length ? (
                      <p className="muted lead-history-empty">No reports yet.</p>
                    ) : (
                      <ul>
                        {history.map((item) => {
                          const active = item.dateKey === selectedKey;
                          return (
                            <li key={item.dateKey}>
                              <button
                                type="button"
                                role="menuitem"
                                className={`lead-history-option${active ? ' active' : ''}`}
                                onClick={() => selectDay(item.dateKey)}
                              >
                                <span className="lead-history-option-date">
                                  {item.dateLabel}
                                </span>
                                <span className="lead-history-option-meta">
                                  {item.lead || '—'}
                                  <span
                                    className={`lead-stage-pill ${stageTone(item.stage)}`}
                                  >
                                    {item.stageLabel}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lead-hero-stats" aria-label="Report stats">
            <div>
              <strong>{messages.length}</strong>
              <span>Messages</span>
            </div>
            <div>
              <strong>
                {verifyTotal ? `${verified}/${verifyTotal}` : '—'}
              </strong>
              <span>Verified</span>
            </div>
            <div>
              <strong>{missingCount}</strong>
              <span>Missing</span>
            </div>
          </div>

          <div className="lead-section">
            <div className="lead-section-head">
              <h4>Decisions</h4>
              <span>{decisions.length}</span>
            </div>
            {!session ? (
              <p className="muted lead-empty">No report session for this day.</p>
            ) : !decisions.length ? (
              <p className="muted lead-empty">No answers recorded yet.</p>
            ) : (
              <ul className="lead-decision-list">
                {decisions.map((row) => (
                  <li key={row.id}>
                    <div className="lead-decision-left">
                      <span className="lead-decision-kind">
                        {row.kind === 'verify' ? 'Verify' : 'Missing'}
                      </span>
                      <span className="lead-decision-pair">
                        {pairLabel(row.pair)}
                      </span>
                      <span className="lead-decision-detail">{row.detail}</span>
                    </div>
                    <div className="lead-decision-right">
                      <span className={`lead-decision-badge ${row.tone}`}>
                        {row.badge}
                      </span>
                      <time>{formatTime(row.at)}</time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {attendanceChips.length > 0 && (
            <div className="lead-attendance">
              {attendanceChips.map((chip) => (
                <span key={chip.key} className={`member-chip ${chip.tone}`}>
                  {chip.label}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="lead-chat">
          <div className="lead-chat-header">
            <div className="lead-chat-title">
              <LeadAvatar
                name={data?.lead}
                avatarUrl={data?.leadAvatarUrl}
                size="sm"
              />
              <h4>Conversation</h4>
            </div>
            <span>{messages.length}</span>
          </div>

          {!messages.length ? (
            <p className="muted lead-empty">No messages for this day yet.</p>
          ) : (
            <div className="lead-chat-thread">
              {messages.map((msg) => {
                const fromBot = msg.direction === 'out';
                return (
                  <div
                    key={msg.id || msg.eventId}
                    className={`lead-bubble ${fromBot ? 'bot' : 'lead'}`}
                  >
                    <div className="lead-bubble-meta">
                      <strong>{fromBot ? 'Chatbot' : data?.lead || 'Lead'}</strong>
                      <span>{formatTime(msg.sentAt)}</span>
                    </div>
                    <pre className="lead-bubble-body">{msg.body}</pre>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default LeadReports;
