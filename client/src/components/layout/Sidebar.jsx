import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const navItems = [
  { label: 'Overview', short: 'Home', to: '/dashboard', icon: 'home' },
  { label: 'Pairs', short: 'Pairs', to: '/dashboard/pairs', icon: 'pairs' },
  { label: 'History', short: 'History', to: '/dashboard/history', icon: 'history' },
  { label: 'Performance', short: 'Stats', to: '/dashboard/performance', icon: 'stats' },
  { label: 'Settings', short: 'Settings', to: '/dashboard/settings', icon: 'settings' },
];

function TabIcon({ name, active }) {
  const stroke = active ? 'var(--primary)' : '#8e8e93';
  const props = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    strokeWidth: active ? 2.2 : 1.8,
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
          <span className="sidebar-brand-dot" />
          <span className="sidebar-brand-text">Menu</span>
        </div>

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
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="sidebar-user">{user}</span>
          <button
            type="button"
            className="logout-btn sidebar-logout"
            onClick={handleLogout}
          >
            Logout
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
                  <TabIcon name={item.icon} active={isActive} />
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
