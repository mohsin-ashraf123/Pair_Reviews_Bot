import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import MonthPicker from '../components/ui/MonthPicker.jsx';
import { MONTH_NAMES, buildMonthOptions, todayDateKey } from '../utils/months.js';
import './Performance.css';

function cellLabel(cell) {
  if (!cell) return '—';
  const note = cell.note ? ` · ${cell.note}` : '';
  if (cell.status === 'present') return `Present${note}`;
  if (cell.status === 'forgot')
    return `Forgot to send review · ${cell.pairLabel || ''}${note}`;
  if (cell.status === 'absent')
    return `Absent · ${cell.pairLabel || ''}${note}`;
  if (cell.status === 'half_day')
    return `Half day leave · ${cell.pairLabel || ''}${note}`;
  if (cell.status === 'excused')
    return `Excused · ${cell.pairLabel || ''}${note}`;
  if (cell.status === 'pending') return 'Pending';
  if (cell.status === 'no_data') return 'N/A';
  return '—';
}

function cellClass(cell) {
  if (!cell) return 'cell-neutral';
  return `cell-${cell.status.replace('_', '-')}`;
}

function statusLetter(status) {
  if (status === 'absent') return 'A';
  if (status === 'forgot') return 'F';
  if (status === 'half_day') return 'H';
  if (status === 'excused') return 'E';
  return null;
}

function CellMark({ cell }) {
  if (!cell) return <span className="mark-empty">—</span>;
  if (cell.status === 'present') return <span className="mark-check">✓</span>;
  if (cell.status === 'pending') return <span className="mark-pending">···</span>;
  if (cell.status === 'no_data' || cell.status === 'not_assigned') {
    return <span className="mark-empty">—</span>;
  }

  const letter = statusLetter(cell.status);
  if (!letter) return <span className="mark-empty">—</span>;

  return <span className="mark-code">{letter}</span>;
}

function PerformanceSkeleton() {
  return (
    <div className="performance-page performance-skeleton" aria-busy="true">
      <div className="performance-header">
        <div>
          <span className="perf-skel-line perf-skel-title" />
          <span className="perf-skel-line perf-skel-sub" />
        </div>
        <span className="perf-skel-line perf-skel-picker" />
      </div>
      <div className="performance-legend">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="perf-skel-line perf-skel-chip" />
        ))}
      </div>
      <div className="performance-table-wrap">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="perf-skel-row">
            <span className="perf-skel-line perf-skel-name" />
            <span className="perf-skel-line perf-skel-cells" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Performance() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const loadMonth = async (year, month) => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.get(`${API}/performance`, {
        params: year && month ? { year, month } : undefined,
      });
      setData(res.data);
      setSelected(`${res.data.year}-${res.data.month}`);
    } catch (err) {
      setData(null);
      setError(err.response?.data?.message || 'Failed to load performance');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMonth();
  }, []);

  const monthOptions = useMemo(() => {
    const year = data?.year ?? new Date().getFullYear();
    return buildMonthOptions(year);
  }, [data?.year]);

  const visibleDays = useMemo(() => {
    if (!data?.days) return [];
    const today = todayDateKey();
    return data.days.filter((day) => day.dateKey <= today);
  }, [data?.days]);

  const handleMonthChange = (value) => {
    setSelected(value);
    const [year, month] = value.split('-').map(Number);
    loadMonth(year, month);
  };

  const monthLabel = data
    ? `${MONTH_NAMES[data.month - 1]} ${data.year}`
    : '';

  const teamCount = data?.rows?.length || 0;
  const avgRate = useMemo(() => {
    if (!data?.rows?.length) return null;
    const rates = data.rows
      .map((r) => r.summary?.rate)
      .filter((r) => r != null);
    if (!rates.length) return null;
    return Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
  }, [data?.rows]);

  if (loading && !data) return <PerformanceSkeleton />;

  return (
    <div className="performance-page">
      <div className="performance-header">
        <div className="performance-header-text">
          <p className="performance-kicker">Attendance</p>
          <h2>{monthLabel || 'Monthly Performance'}</h2>
          <p className="performance-subtitle">
            Daily review status by member
            {teamCount > 0 && (
              <span className="performance-meta-pill">{teamCount} members</span>
            )}
            {avgRate != null && (
              <span className="performance-meta-pill tone-rate">
                Avg {avgRate}%
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

      <div className="performance-legend" aria-label="Status legend">
        <span className="legend-item present">
          <i>✓</i> Present
        </span>
        <span className="legend-item absent">
          <i>A</i> Absent
        </span>
        <span className="legend-item forgot">
          <i>F</i> Forgot
        </span>
        <span className="legend-item half-day">
          <i>H</i> Half day
        </span>
        <span className="legend-item excused">
          <i>E</i> Excused
        </span>
        <span className="legend-item pending">
          <i>·</i> Pending
        </span>
      </div>

      <div className={`performance-table-wrap${loading ? ' is-loading' : ''}`}>
        <div className="performance-table-scroll">
          <table className="performance-table">
            <thead>
              <tr>
                <th className="sticky-col">Member</th>
                {visibleDays.map((day) => (
                  <th key={day.dateKey} className="day-col" title={day.dateKey}>
                    <span className="day-head">{day.dayName}</span>
                    <span className="day-sub">{day.shortDate}</span>
                  </th>
                ))}
                <th className="summary-col">Present</th>
                <th className="summary-col">Absent</th>
                <th className="summary-col rate-head">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows?.length ? (
                data.rows.map((row) => (
                  <tr key={row.member}>
                    <td className="sticky-col member-name">
                      <span className="member-avatar" aria-hidden>
                        {row.member.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="member-label">{row.member}</span>
                    </td>
                    {visibleDays.map((day) => {
                      const cell = row.cells[day.dateKey];
                      return (
                        <td
                          key={day.dateKey}
                          className={`day-cell ${cellClass(cell)}`}
                          title={cellLabel(cell)}
                        >
                          <CellMark cell={cell} />
                        </td>
                      );
                    })}
                    <td className="summary-col present-count">
                      {row.summary.present}
                    </td>
                    <td className="summary-col absent-count">
                      {row.summary.absent}
                    </td>
                    <td className="summary-col rate-col">
                      {row.summary.rate != null ? (
                        <span
                          className={`rate-pill${
                            row.summary.rate >= 75
                              ? ' good'
                              : row.summary.rate >= 50
                                ? ' mid'
                                : ' low'
                          }`}
                        >
                          {row.summary.rate}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={visibleDays.length + 4} className="empty-row">
                    No performance data for this month
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default Performance;
