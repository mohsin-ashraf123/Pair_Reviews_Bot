import { Outlet } from 'react-router-dom';
import { BotStatusProvider } from '../../context/BotStatusContext';
import Header from './Header';
import Sidebar from './Sidebar';
import '../../pages/Dashboard.css';

function DashboardLayout() {
  return (
    <BotStatusProvider>
      <div className="dashboard">
        <Sidebar />
        <div className="dashboard-main">
          <Header />
          <main className="main-content">
            <Outlet />
          </main>
        </div>
      </div>
    </BotStatusProvider>
  );
}

export default DashboardLayout;
