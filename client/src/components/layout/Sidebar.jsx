import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const navItems = [
  { label: 'Overview', short: 'Home', to: '/dashboard', icon: 'home' },
  { label: 'Pairs', short: 'Pairs', to: '/dashboard/pairs', icon: 'pairs' },
  { label: 'Threads', short: 'Threads', to: '/dashboard/threads', icon: 'threads' },
  { label: 'History', short: 'History', to: '/dashboard/history', icon: 'history' },
  { label: 'Performance', short: 'Stats', to: '/dashboard/performance', icon: 'stats' },
  { label: 'Member Rooms', short: 'Rooms', to: '/dashboard/members', icon: 'rooms' },
  { label: 'Lead Reports', short: 'Leads', to: '/dashboard/leads', icon: 'leads' },
  { label: 'AI Analyzed', short: 'AI', to: '/dashboard/ai', icon: 'ai' },
  { label: 'Settings', short: 'Settings', to: '/dashboard/settings', icon: 'settings' },
];

function NavIcon({ name, active, size = 18 }) {
  const stroke = active ? 'var(--primary)' : 'currentColor';
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: active ? 2.1 : 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  switch (name) {
    case 'home':
      return (
        <svg {...props}>
          <path d="M4 10.5 12 4l8 6.5" />
          <path d="M6 9.5V19h12V9.5" />
        </svg>
      );
    case 'pairs':
      return (
        <svg {...props}>
          <circle cx="8" cy="9" r="2.5" />
          <circle cx="16" cy="9" r="2.5" />
          <path d="M5 19c0-2.2 1.8-4 4-4" />
          <path d="M19 19c0-2.2-1.8-4-4-4" />
        </svg>
      );
    case 'threads':
      return (
        <svg {...props}>
          <path d="M6 5h12" />
          <path d="M6 10h12" />
          <path d="M6 15h7" />
          <path d="M15 15v4l3-2.2" />
        </svg>
      );
    case 'history':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2.5" />
        </svg>
      );
    case 'stats':
      return (
        <svg {...props}>
          <path d="M5 19V11" />
          <path d="M12 19V5" />
          <path d="M19 19v-7" />
        </svg>
      );
    case 'rooms':
      return (
        <svg {...props}>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16h-.5A1.5 1.5 0 0 1 4 14.5Z" />
          <path d="M8.5 10h7" />
        </svg>
      );
    case 'leads':
      return (
        <svg {...props}>
          <circle cx="12" cy="8" r="3" />
          <path d="M5 19c0-3.3 3-5 7-5s7 1.7 7 5" />
        </svg>
      );
    case 'ai':
      return (
        <svg {...props}>
          <path d="M12 3v3" />
          <path d="M12 18v3" />
          <path d="M3 12h3" />
          <path d="M18 12h3" />
          <path d="M6.2 6.2l2.1 2.1" />
          <path d="M15.7 15.7l2.1 2.1" />
          <path d="M6.2 17.8l2.1-2.1" />
          <path d="M15.7 8.3l2.1-2.1" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
        </svg>
      );
    default:
      return null;
  }
}

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark" aria-hidden>
            EP
          </div>
          <div className="sidebar-brand-copy">
            <span className="sidebar-brand-title">Pair Review</span>
            <span className="sidebar-brand-sub">Workspace</span>
          </div>
        </div>

        <p className="sidebar-section-label">Navigate</p>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/dashboard'}
              className={({ isActive }) =>
                `sidebar-link${isActive ? ' active' : ''}`
              }
            >
              {({ isActive }) => (
                <>
                  <span className="sidebar-link-icon">
                    <NavIcon name={item.icon} active={isActive} />
                  </span>
                  <span className="sidebar-link-label">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user-block">
            <span className="sidebar-user-avatar" aria-hidden>
              {(user || 'A').slice(0, 1).toUpperCase()}
            </span>
            <div className="sidebar-user-meta">
              <span className="sidebar-user">{user || 'Admin'}</span>
              <span className="sidebar-user-role">Operator</span>
            </div>
          </div>
          <button
            type="button"
            className="logout-btn sidebar-logout"
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
      </aside>

      <nav className="mobile-tab-bar" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/dashboard'}
            className={({ isActive }) =>
              `mobile-tab${isActive ? ' active' : ''}`
            }
          >
            {({ isActive }) => (
              <>
                <span className="mobile-tab-icon">
                  <NavIcon name={item.icon} active={isActive} size={22} />
                </span>
                <span className="mobile-tab-label">{item.short}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export default Sidebar;
