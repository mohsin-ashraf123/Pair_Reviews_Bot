import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import DashboardLayout from './components/layout/DashboardLayout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Pairs from './pages/Pairs';
import History from './pages/History';
import Performance from './pages/Performance';
import MemberRooms from './pages/MemberRooms';
import LeadReports from './pages/LeadReports';
import AiAnalyzed from './pages/AiAnalyzed';
import Settings from './pages/Settings';

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

function PublicRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/dashboard" replace /> : children;
}

function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Overview />} />
        <Route path="pairs" element={<Pairs />} />
        <Route path="history" element={<History />} />
        <Route path="performance" element={<Performance />} />
        <Route path="members" element={<MemberRooms />} />
        <Route path="leads" element={<LeadReports />} />
        <Route path="ai" element={<AiAnalyzed />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default App;
