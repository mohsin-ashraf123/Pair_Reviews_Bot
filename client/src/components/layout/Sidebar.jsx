import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

const navItems = [
  { label: 'Overview', short: 'Home', to: '/dashboard' },
  { label: 'Pairs', short: 'Pairs', to: '/dashboard/pairs' },
  { label: 'History', short: 'History', to: '/dashboard/history' },
  { label: 'Performance', short: 'Perf', to: '/dashboard/performance' },
  { label: 'Settings', short: 'Settings', to: '/dashboard/settings' },
];

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

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/dashboard'}
            className={({ isActive }) =>
              `mobile-nav-link${isActive ? ' active' : ''}`
            }
          >
            {item.short}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export default Sidebar;
