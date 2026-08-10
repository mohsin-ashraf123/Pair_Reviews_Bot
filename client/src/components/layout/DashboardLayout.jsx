import { Outlet } from 'react-router-dom';
import { BotStatusProvider } from '../../context/BotStatusContext';
import Header from './Header';
import Sidebar from './Sidebar';
import '../../pages/Dashboard.css';

function DashboardLayout() {
  return (
    <BotStatusProvider>
      <div className="dashboard">
        <Header />
        <div className="dashboard-body">
          <Sidebar />
          <main className="main-content">
            <Outlet />
          </main>
        </div>
      </div>
    </BotStatusProvider>
  );
}

export default DashboardLayout;
