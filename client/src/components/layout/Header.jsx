import { useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBotStatus } from '../../context/BotStatusContext';
import '../../pages/Dashboard.css';

const PAGE_TITLES = {
  '/dashboard': 'Overview',
  '/dashboard/pairs': 'Pairs',
  '/dashboard/threads': 'Threads',
  '/dashboard/history': 'History',
  '/dashboard/performance': 'Performance',
  '/dashboard/members': 'Member Rooms',
  '/dashboard/leads': 'Lead Reports',
  '/dashboard/ai': 'AI Analyzed',
  '/dashboard/settings': 'Settings',
};

function Header() {
  const { user } = useAuth();
  const { status } = useBotStatus();
  const { pathname } = useLocation();

  const connected = status?.matrixConnected;
  const e2ee = status?.e2eeReady;
  const pageTitle = PAGE_TITLES[pathname] || 'Dashboard';

  return (
    <header className="header">
      <div className="header-left header-mobile-brand">
        <div className="header-logo" aria-hidden>
          EP
        </div>
        <div className="header-title-wrap">
          <h1 className="header-title">Pair Review</h1>
        </div>
      </div>

      <div className="header-page">
        <p className="header-page-kicker">Dashboard</p>
        <h1 className="header-page-title">{pageTitle}</h1>
      </div>

      <div className="header-right">
        <div className="header-status" aria-label="Bot status">
          <span
            className={`header-dot ${connected ? 'good' : 'bad'}`}
            title={connected ? 'Matrix connected' : 'Matrix offline'}
          >
            <span className="header-dot-mark" />
            {connected ? 'Online' : 'Offline'}
          </span>
          {connected && (
            <span
              className={`header-dot ${e2ee ? 'good' : 'warn'}`}
              title={e2ee ? 'End-to-end encryption ready' : 'E2EE still syncing'}
            >
              <span className="header-dot-mark" />
              {e2ee ? 'E2EE' : 'E2EE…'}
            </span>
          )}
        </div>
        <div className="header-user-chip" title={user || 'Admin'}>
          <span className="header-user-avatar" aria-hidden>
            {(user || 'A').slice(0, 1).toUpperCase()}
          </span>
          <span className="header-user-name">{user || 'Admin'}</span>
        </div>
      </div>
    </header>
  );
}

export default Header;
