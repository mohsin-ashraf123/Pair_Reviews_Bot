import { Outlet, useLocation } from 'react-router-dom';
import { BotStatusProvider } from '../../context/BotStatusContext';
import Header from './Header';
import Sidebar from './Sidebar';
import '../../pages/Dashboard.css';

function DashboardLayout() {
  const location = useLocation();
  const isOverview = location.pathname === '/dashboard' || location.pathname === '/dashboard/';

  return (
    <BotStatusProvider>
      <div className="dashboard">
        <Header />
        <div className="dashboard-body">
          <Sidebar />
          <main className={`main-content${isOverview ? ' main-content--fit' : ''}`}>
            <Outlet />
          </main>
        </div>
      </div>
    </BotStatusProvider>
  );
}

export default DashboardLayout;
