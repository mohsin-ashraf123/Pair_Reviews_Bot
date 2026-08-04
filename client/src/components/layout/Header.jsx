import { useAuth } from '../../context/AuthContext';
import { useBotStatus } from '../../context/BotStatusContext';
import '../../pages/Dashboard.css';

function Header() {
  const { user } = useAuth();
  const { status } = useBotStatus();

  const connected = status?.matrixConnected;
  const e2ee = status?.e2eeReady;

  return (
    <header className="header">
      <div className="header-left">
        <div className="header-logo">EP</div>
        <div className="header-title-wrap">
          <h1 className="header-title">
            <span className="header-title-full">Element Pair Review Bot</span>
            <span className="header-title-short">Pair Review</span>
          </h1>
          <p className="header-subtitle">Daily pair automation for Element</p>
        </div>
      </div>

      <div className="header-right">
        <div className="header-status">
          <span
            className={`header-pill ${connected ? 'good' : 'bad'}`}
            title={status?.roomName || 'Element connection'}
          >
            {connected ? '● Connected' : '● Offline'}
          </span>
          {connected && (
            <span className={`header-pill ${e2ee ? 'good' : 'warn'}`}>
              {e2ee ? 'E2EE Ready' : 'E2EE Pending'}
            </span>
          )}
          {status?.roomName && (
            <span className="header-room">{status.roomName}</span>
          )}
        </div>
        <span className="header-user">{user}</span>
      </div>
    </header>
  );
}

export default Header;
