import { useEffect, useMemo, useState, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import MonthPicker from '../components/ui/MonthPicker.jsx';
import { MONTH_NAMES, buildMonthOptions } from '../utils/months.js';
import { MedalIcon, SuggestionIcon, ConcernIcon, IssueIcon, TrophyIcon, EmptyIcon } from '../components/ui/Icons.jsx';
import './Ranking.css';

function scoreClass(score) {
  if (score >= 8) return 'good';
  if (score >= 6) return 'mid';
  return 'low';
}

/* ---------- Skeleton ---------- */
function RankingSkeleton() {
  return (
    <div className="ranking-page ranking-skeleton" aria-busy="true">
      <div className="ranking-header">
        <div>
          <span className="skel-line skel-title" />
          <span className="skel-line skel-sub" />
        </div>
      </div>
      <div className="ranking-table-wrap">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="skel-line skel-row" />
        ))}
      </div>
    </div>
  );
}

/* ---------- Main Page ---------- */
function Ranking() {
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [selected, setSelected] = useState(null);
  const [processing, setProcessing] = useState(false);
  
  // State for toggling between 'ranking' and 'insights'
  const [view, setView] = useState('ranking');
  const [selectedMember, setSelectedMember] = useState(null);

  const loadMonth = useCallback(async (year, month) => {
    setLoading(true);
    setError('');
    try {
      const params = year && month ? { year, month } : undefined;
      const [rankRes, insightRes, schedRes, reportsRes] = await Promise.all([
        axios.get(`${API}/ranking`, { params }),
        axios.get(`${API}/ranking/insights`, { params }),
        axios.get(`${API}/ranking/schedule`),
        axios.get(`${API}/ranking/reports`)
      ]);

      setData(rankRes.data);
      setInsights(insightRes.data);
      setSchedule(schedRes.data);
      setReports(reportsRes.data || []);
      setSelected(`${rankRes.data.year}-${rankRes.data.month}`);
    } catch (err) {
      setData(null);
      setError(err.response?.data?.message || 'Failed to load ranking');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMonth();
  }, [loadMonth]);

  const monthOptions = useMemo(() => {
    const year = data?.year ?? new Date().getFullYear();
    return buildMonthOptions(year);
  }, [data?.year]);

  const handleMonthChange = (value) => {
    setSelected(value);
    const [year, month] = value.split('-').map(Number);
    loadMonth(year, month);
  };

  const handleProcessToday = async () => {
    setProcessing(true);
    setActionMsg('');
    try {
      const today = new Date();
      const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      await axios.post(`${API}/ranking/process`, { dateKey });
      setActionMsg('\u2705 Reviews processed for today');
      loadMonth(data?.year, data?.month);
    } catch (err) {
      setActionMsg(`❌ ${err.response?.data?.message || err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleBackfill = async () => {
    setProcessing(true);
    setActionMsg('');
    try {
      const year = data?.year || new Date().getFullYear();
      const month = String(data?.month || new Date().getMonth() + 1).padStart(2, '0');
      const startDateKey = `${year}-${month}-01`;

      const res = await axios.post(`${API}/ranking/backfill`, {
        startDateKey,
      });
      const count = res.data?.results?.length || 0;
      setActionMsg(`✅ Backfill complete — ${count} day(s) processed`);
      loadMonth(data?.year, data?.month);
    } catch (err) {
      setActionMsg(`❌ ${err.response?.data?.message || err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleGenerate = async () => {
    setProcessing(true);
    setActionMsg('');
    try {
      await axios.post(`${API}/ranking/generate`, {
        year: data?.year,
        month: data?.month,
      });
      setActionMsg('✅ Monthly report generated');
      loadMonth(data?.year, data?.month);
    } catch (err) {
      setActionMsg(`❌ ${err.response?.data?.message || err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleSend = async () => {
    setProcessing(true);
    setActionMsg('');
    try {
      const res = await axios.post(`${API}/ranking/send`, {
        year: data?.year,
        month: data?.month,
      });
      if (res.data?.skipped) {
        setActionMsg(`⚠️ ${res.data.reason}`);
      } else {
        setActionMsg('\u2705 Monthly report sent to Pair Reviews room');
      }
      loadMonth(data?.year, data?.month);
    } catch (err) {
      setActionMsg(`❌ ${err.response?.data?.message || err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleDeleteReport = async (monthKey) => {
    if (!window.confirm(`Are you sure you want to delete the report for ${monthKey}?`)) return;
    setProcessing(true);
    setActionMsg('');
    try {
      await axios.delete(`${API}/ranking/reports/${monthKey}`);
      setActionMsg('✅ Report deleted successfully');
      loadMonth(data?.year, data?.month);
    } catch (err) {
      setActionMsg(`❌ ${err.response?.data?.message || err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const monthLabel = data
    ? `${MONTH_NAMES[(data.month || 1) - 1]} ${data.year}`
    : '';

  // Group insights by member
  const insightsByMember = useMemo(() => {
    const map = {};
    if (!insights?.insights) return map;
    for (const ins of insights.insights) {
      if (!map[ins.member]) map[ins.member] = { suggestion: [], concern: [], issue: [], emptyCount: 0 };
      
      if (ins.emptyReview) {
        map[ins.member].emptyCount += 1;
      }
      
      for (const item of ins.items || []) {
        if (map[ins.member][item.type]) {
          map[ins.member][item.type].push({ ...item, dateKey: ins.dateKey, pairLabel: ins.pairLabel });
        }
      }
    }
    return map;
  }, [insights]);

  const allMembers = useMemo(() => {
    if (!data?.rankings) return [];
    return data.rankings.map((r) => r.member).sort();
  }, [data]);

  useEffect(() => {
    if (view === 'insights' && !selectedMember && allMembers.length > 0) {
      setSelectedMember(allMembers[0]);
    }
  }, [view, allMembers, selectedMember]);

  const progressPct = schedule
    ? Math.round(
        ((schedule.processedDays || 0) / Math.max(schedule.totalWorkingDays || 1, 1)) * 100
      )
    : 0;

  if (loading && !data) return <RankingSkeleton />;

  return (
    <div className="ranking-page">
      {/* Header */}
      <div className="ranking-header">
        <div className="ranking-header-text">
          <p className="ranking-kicker">{view === 'ranking' ? 'Monthly Ranking' : 'Member Insights'}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h2>{monthLabel || 'Member Ranking'}</h2>
            {view === 'ranking' ? (
              <button className="ranking-btn primary sm" onClick={() => setView('insights')}>
                📋 View Insights
              </button>
            ) : (
              <button className="ranking-btn sm" onClick={() => setView('ranking')}>
                ← Back to Ranking
              </button>
            )}
          </div>
          <p className="ranking-subtitle">
            AI-analyzed review performance
            {data?.rankings?.length > 0 && (
              <span className="ranking-meta-pill">
                {data.rankings.length} members
              </span>
            )}
            {data?.processedDays > 0 && (
              <span className="ranking-meta-pill tone-good">
                {data.processedDays} days processed
              </span>
            )}
          </p>
        </div>
        <MonthPicker
          options={monthOptions}
          value={selected || ''}
          onChange={handleMonthChange}
          disabled={loading}
        />
      </div>

      {error && <p className="feedback err">{error}</p>}
      {actionMsg && (
        <p className={`feedback ${actionMsg.startsWith('✅') || actionMsg.startsWith('✅') ? 'ok' : 'err'}`}>
          {actionMsg}
        </p>
      )}

      {view === 'ranking' ? (
        <>
          {/* Scheduled Preview & History Box */}
          {reports && reports.length > 0 && (
            <div style={{ marginBottom: '40px', background: 'rgba(255, 255, 255, 0.02)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <h3 className="ranking-section-title" style={{ marginTop: 0 }}>📅 Scheduled Preview & History</h3>
              <div style={{ display: 'flex', gap: '20px', overflowX: 'auto', paddingBottom: '10px' }}>
                {reports.map(report => (
                  <div key={report.monthKey} style={{ minWidth: '300px', background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <strong>{report.monthKey}</strong>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <span className={`score-pill ${report.status === 'scheduled' ? 'mid' : report.status === 'sent' ? 'good' : 'low'}`} style={{ fontSize: '12px', padding: '2px 8px' }}>
                          {report.status.toUpperCase()}
                        </span>
                        <button onClick={() => handleDeleteReport(report.monthKey)} style={{ background: 'transparent', border: 'none', color: '#ff7b72', cursor: 'pointer', padding: '0' }} title="Delete Report">
                          🗑️
                        </button>
                      </div>
                    </div>
                    {report.status === 'scheduled' && report.scheduledFor && (
                      <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '10px' }}>
                        Sending on: {new Date(report.scheduledFor).toLocaleString()}
                      </div>
                    )}
                    {report.imageBase64 ? (
                      <img 
                        src={`data:image/png;base64,${report.imageBase64}`} 
                        alt="Preview" 
                        style={{ width: '100%', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)' }} 
                      />
                    ) : (
                      <div style={{ fontSize: '12px', color: '#8b949e' }}>No image preview available</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ranking Table */}
          <div className={`ranking-table-wrap${loading ? ' is-loading' : ''}`}>
            <table className="ranking-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Member</th>
                  <th>Score</th>
                  <th>Performance</th>
                  <th>Reviews</th>
                  <th>Insights</th>
                  <th>Attendance</th>
                </tr>
              </thead>
              <tbody>
                {data?.rankings?.length ? (
                  data.rankings.map((r) => (
                    <tr key={r.member}>
                      <td className="rank-cell">
                        {r.rank <= 3 ? (
                          <span className="rank-medal" title={`Rank ${r.rank}`}><MedalIcon rank={r.rank} /></span>
                        ) : (
                          r.rank
                        )}
                      </td>
                      <td>
                        <div className="member-cell">
                          <span className="ranking-avatar" aria-hidden>
                            {r.member.slice(0, 1).toUpperCase()}
                          </span>
                          {r.member}
                        </div>
                      </td>
                      <td>
                        <span className={`score-pill ${scoreClass(r.score)}`}>
                          {r.score}/10
                        </span>
                      </td>
                      <td className="oneliner-cell">
                        {r.oneLiner || '—'}
                      </td>
                      <td>
                        <div className="stat-mini">
                          <span>
                            <span className="stat-label">Total: </span>
                            {r.stats.totalReviews}
                          </span>
                          <span>
                            <span className="stat-label">Empty: </span>
                            <span className={r.stats.emptyReviews > 0 ? 'stat-val-red' : ''}>
                              {r.stats.emptyReviews}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="stat-mini">
                          {r.stats.suggestions > 0 && (
                            <span style={{display: 'flex', alignItems: 'center', gap: '2px'}}><SuggestionIcon style={{width: 14, height: 14, color: '#2b6cb0'}}/> {r.stats.suggestions}</span>
                          )}
                          {r.stats.concerns > 0 && (
                            <span style={{display: 'flex', alignItems: 'center', gap: '2px'}}><ConcernIcon style={{width: 14, height: 14, color: '#8a4b00'}}/> {r.stats.concerns}</span>
                          )}
                          {r.stats.issues > 0 && (
                            <span style={{display: 'flex', alignItems: 'center', gap: '2px'}}><IssueIcon style={{width: 14, height: 14, color: '#b42318'}}/> {r.stats.issues}</span>
                          )}
                          {r.stats.suggestions === 0 &&
                            r.stats.concerns === 0 &&
                            r.stats.issues === 0 && (
                              <span className="stat-label">—</span>
                            )}
                        </div>
                      </td>
                      <td>
                        <div className="stat-mini">
                          <span>
                            <span className="stat-val-green">{r.stats.presentDays}</span>
                            <span className="stat-label">P</span>
                          </span>
                          {r.stats.absentDays > 0 && (
                            <span>
                              <span className="stat-val-red">{r.stats.absentDays}</span>
                              <span className="stat-label">A</span>
                            </span>
                          )}
                          {r.stats.halfDays > 0 && (
                            <span>
                              <span className="stat-val-yellow">{r.stats.halfDays}</span>
                              <span className="stat-label">H</span>
                            </span>
                          )}
                          {r.stats.forgotDays > 0 && (
                            <span>
                              <span className="stat-val-yellow">{r.stats.forgotDays}</span>
                              <span className="stat-label">F</span>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="ranking-empty">
                      <div className="ranking-empty-icon"><TrophyIcon style={{width: 48, height: 48, margin: '0 auto'}}/></div>
                      No ranking data for this month yet.
                      <br />
                      Process reviews to start building rankings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Schedule & Actions */}
          <h3 className="ranking-section-title">⏰ Schedule & Status</h3>
          <div className="ranking-schedule">
            <div className="schedule-grid">
              <div className="schedule-item">
                <span className="schedule-item-label">Daily Processing</span>
                <span className="schedule-item-value">
                  {schedule?.dailyCronSchedule || '6:30 PM'}
                </span>
                <span className="schedule-item-sub">Mon–Fri, parses daily reviews</span>
              </div>
              <div className="schedule-item">
                <span className="schedule-item-label">Month-End Report</span>
                <span className="schedule-item-value">
                  1st of Next Month
                </span>
                <span className="schedule-item-sub">
                  Generates 10:00 AM, Sends 06:00 PM
                </span>
              </div>
              <div className="schedule-item">
                <span className="schedule-item-label">Report Status</span>
                <span className="schedule-item-value">
                  {schedule?.report?.status
                    ? schedule.report.status.toUpperCase()
                    : 'Not generated'}
                </span>
                {schedule?.report?.sentAt && (
                  <span className="schedule-item-sub">
                    Sent: {new Date(schedule.report.sentAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            {/* Progress bar */}
            <div className="ranking-progress">
              <div className="ranking-progress-bar">
                <div
                  className="ranking-progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="ranking-progress-label">
                {schedule?.processedDays || 0} / {schedule?.totalWorkingDays || 0} working
                days processed ({progressPct}%)
              </span>
            </div>

            {/* Action buttons */}
            <div className="ranking-actions">
              <button
                className="ranking-btn"
                onClick={handleProcessToday}
                disabled={processing}
              >
                ▶ Process Today
              </button>
              <button
                className="ranking-btn"
                onClick={handleBackfill}
                disabled={processing}
              >
                🔄 Backfill from {monthLabel || 'Start of Month'}
              </button>
              <button
                className="ranking-btn primary"
                onClick={handleGenerate}
                disabled={processing}
              >
                📊 Generate Report
              </button>
              <button
                className="ranking-btn"
                onClick={handleSend}
                disabled={processing}
              >
                📤 Send to Room
              </button>
            </div>
          </div>
        </>
      ) : (
        /* Insights Split View */
        <div className="insights-split-view">
          <div className="insights-sidebar">
            <h4 className="insights-sidebar-title">Team Members</h4>
            <div className="insights-member-list">
              {allMembers.map(member => {
                const memberStats = insightsByMember[member] || { suggestion: [], concern: [], issue: [], emptyCount: 0 };
                const hasData = memberStats.suggestion.length > 0 || memberStats.concern.length > 0 || memberStats.issue.length > 0 || memberStats.emptyCount > 0;
                return (
                  <div 
                    key={member} 
                    className={`insights-member-item ${selectedMember === member ? 'active' : ''}`}
                    onClick={() => setSelectedMember(member)}
                  >
                    <div className="member-name-wrap">
                       <span className="ranking-avatar small" aria-hidden>{member.slice(0,1).toUpperCase()}</span>
                       <span className="member-name-text">{member}</span>
                    </div>
                    {hasData && (
                      <div className="member-mini-badges">
                        {memberStats.suggestion.length > 0 && <span className="mini-badge suggestion" title="Suggestions"><SuggestionIcon/> {memberStats.suggestion.length}</span>}
                        {memberStats.concern.length > 0 && <span className="mini-badge concern" title="Concerns"><ConcernIcon/> {memberStats.concern.length}</span>}
                        {memberStats.issue.length > 0 && <span className="mini-badge issue" title="Issues"><IssueIcon/> {memberStats.issue.length}</span>}
                        {memberStats.emptyCount > 0 && <span className="mini-badge empty" title="Empty Reviews"><EmptyIcon/> {memberStats.emptyCount}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="insights-main-content">
            {selectedMember ? (() => {
              const stats = insightsByMember[selectedMember] || { suggestion: [], concern: [], issue: [], emptyCount: 0 };
              const hasAny = stats.suggestion.length > 0 || stats.concern.length > 0 || stats.issue.length > 0 || stats.emptyCount > 0;
              
              if (!hasAny) {
                 return (
                   <div className="insights-empty-state">
                     <EmptyIcon className="insights-empty-icon" />
                     <h3>No insights recorded</h3>
                     <p>There are no processed reviews for {selectedMember} this month.</p>
                   </div>
                 );
              }

              return (
                <div className="insights-detail-view">
                  <h3 className="insights-detail-header">
                    Insights for {selectedMember}
                  </h3>
                  
                  {stats.emptyCount > 0 && (
                    <div className="insight-group">
                       <div className="insight-group-header empty">
                         <EmptyIcon /> {stats.emptyCount} Empty Review{stats.emptyCount > 1 ? 's' : ''}
                       </div>
                       <div className="insight-group-body">
                         <p className="insight-empty-msg">
                           The user sent "No issues identified" or a blank review on {stats.emptyCount} occasion{stats.emptyCount > 1 ? 's' : ''}.
                         </p>
                       </div>
                    </div>
                  )}

                  {stats.suggestion.length > 0 && (
                    <div className="insight-group">
                       <div className="insight-group-header suggestion">
                         <SuggestionIcon /> {stats.suggestion.length} Suggestion{stats.suggestion.length > 1 ? 's' : ''}
                       </div>
                       <div className="insight-group-body">
                         {stats.suggestion.map((item, i) => (
                           <div key={i} className="insight-item-clean">
                             <div className="insight-item-text">{item.text}</div>
                             <div className="insight-item-meta">{item.dateKey} &bull; {item.pairLabel}</div>
                           </div>
                         ))}
                       </div>
                    </div>
                  )}

                  {stats.concern.length > 0 && (
                    <div className="insight-group">
                       <div className="insight-group-header concern">
                         <ConcernIcon /> {stats.concern.length} Concern{stats.concern.length > 1 ? 's' : ''}
                       </div>
                       <div className="insight-group-body">
                         {stats.concern.map((item, i) => (
                           <div key={i} className="insight-item-clean">
                             <div className="insight-item-text">{item.text}</div>
                             <div className="insight-item-meta">{item.dateKey} &bull; {item.pairLabel}</div>
                           </div>
                         ))}
                       </div>
                    </div>
                  )}

                  {stats.issue.length > 0 && (
                    <div className="insight-group">
                       <div className="insight-group-header issue">
                         <IssueIcon /> {stats.issue.length} Issue{stats.issue.length > 1 ? 's' : ''}
                       </div>
                       <div className="insight-group-body">
                         {stats.issue.map((item, i) => (
                           <div key={i} className="insight-item-clean">
                             <div className="insight-item-text">{item.text}</div>
                             <div className="insight-item-meta">{item.dateKey} &bull; {item.pairLabel}</div>
                           </div>
                         ))}
                       </div>
                    </div>
                  )}
                </div>
              );
            })() : (
               <div className="insights-empty-state">
                  Select a member from the sidebar to view their insights.
               </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Ranking;
