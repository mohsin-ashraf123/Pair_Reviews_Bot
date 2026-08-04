import { useEffect, useState } from 'react';
import { useBotStatus } from '../context/BotStatusContext';
import './Settings.css';

function Settings() {
  const { status, loading, refresh } = useBotStatus();
  const schedules = status?.scheduledMessages?.schedules || [];

  if (loading && !status) {
    return (
      <div className="content-card">
        <p className="muted">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div>
          <h2>Settings</h2>
          <p className="muted">Bot connection and schedule configuration</p>
        </div>
        <button type="button" className="refresh-btn" onClick={refresh}>
          Refresh status
        </button>
      </div>

      <section className="content-card">
        <h3>Bot Status</h3>
        <div className="status-grid">
          <div className="status-item">
            <span>Element connected</span>
            <span className={`pill ${status?.matrixConnected ? 'good' : 'bad'}`}>
              {status?.matrixConnected ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="status-item">
            <span>Room name</span>
            <span className="pill neutral">{status?.roomName || '—'}</span>
          </div>
          <div className="status-item">
            <span>Room ID</span>
            <span className="pill neutral">{status?.roomId || '—'}</span>
          </div>
          {status?.matrixUserId && (
            <div className="status-item">
              <span>Bot user</span>
              <span className="pill neutral">{status.matrixUserId}</span>
            </div>
          )}
          {status?.matrixDeviceId && (
            <div className="status-item">
              <span>Bot device</span>
              <span className="pill neutral">{status.matrixDeviceId}</span>
            </div>
          )}
          <div className="status-item">
            <span>Room encryption</span>
            <span className={`pill ${status?.roomEncrypted ? 'good' : 'bad'}`}>
              {status?.roomEncrypted ? 'Enabled' : status?.roomEncrypted === false ? 'Off' : '—'}
            </span>
          </div>
          <div className="status-item">
            <span>E2EE ready</span>
            <span className={`pill ${status?.e2eeReady ? 'good' : 'bad'}`}>
              {status?.e2eeReady ? 'Yes' : 'No'}
            </span>
          </div>
          {status?.matrixError && (
            <div className="status-item">
              <span>Note</span>
              <span className="pill bad status-note">{status.matrixError}</span>
            </div>
          )}
          {status?.needsPasswordLogin && (
            <div className="status-item">
              <span>Action needed</span>
              <span className="pill bad status-note">
                Add MATRIX_USER + MATRIX_PASSWORD in server/.env, then restart server
              </span>
            </div>
          )}
          <div className="status-item">
            <span>Timezone</span>
            <span className="pill neutral">{status?.schedule?.timezone || '—'}</span>
          </div>
          <div className="status-item">
            <span>Developers</span>
            <span className="pill neutral">{status?.team?.developers?.join(', ') || '—'}</span>
          </div>
          <div className="status-item">
            <span>QA (fixed pair)</span>
            <span className="pill neutral">{status?.team?.qaTeam?.join(' + ') || '—'}</span>
          </div>
        </div>
      </section>

      <section className="content-card schedule-messages">
        <h3>Scheduled Messages</h3>
        <p className="muted schedule-intro">
          Automated messages sent to the Element room ({status?.schedule?.timezone || 'Asia/Karachi'})
        </p>
        <div className="schedule-list">
          {schedules.map((item) => (
            <article key={item.id} className="schedule-card">
              <div className="schedule-card-head">
                <div>
                  <h4>{item.title}</h4>
                  <p className="schedule-meta">
                    {item.days} · {item.time}
                    {item.exampleForDate ? ` · for ${item.exampleForDate}` : ''}
                  </p>
                </div>
                <span className="schedule-time-badge">{item.time}</span>
              </div>
              <p className="schedule-desc">{item.description}</p>
              {item.exampleNote && (
                <p className="schedule-note">{item.exampleNote}</p>
              )}
              <pre className="schedule-example">{item.example}</pre>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default Settings;
