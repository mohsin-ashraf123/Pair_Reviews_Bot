import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import './Performance.css';

const API = '/api/pairs';
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildMonthOptions(centerYear) {
  const options = [];
  for (let y = centerYear - 1; y <= centerYear + 1; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      options.push({
        value: `${y}-${m}`,
        label: `${MONTH_NAMES[m - 1]} ${y}`,
      });
    }
  }
  return options;
}

function cellLabel(cell) {
  if (!cell) return '—';
  if (cell.status === 'present') return 'Present';
  if (cell.status === 'absent') return `Absent · ${cell.pairLabel}`;
  if (cell.status === 'pending') return 'Pending';
  if (cell.status === 'future') return '—';
  if (cell.status === 'no_data') return 'N/A';
  return '—';
}

function cellClass(cell) {
  if (!cell) return 'cell-neutral';
  return `cell-${cell.status.replace('_', '-')}`;
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

  const handleMonthChange = (e) => {
    const value = e.target.value;
    setSelected(value);
    const [year, month] = value.split('-').map(Number);
    loadMonth(year, month);
  };

  const monthLabel = data
    ? `${MONTH_NAMES[data.month - 1]} ${data.year}`
    : '';

  if (loading && !data) {
    return (
      <div className="content-card">
        <p className="muted">Loading performance…</p>
      </div>
    );
  }

  return (
    <div className="performance-page">
      <div className="performance-header">
        <div>
          <h2>{monthLabel || 'Monthly Performance'}</h2>
          <p className="muted">
            Review attendance by member — absent days show the assigned pair
          </p>
        </div>
        <select
          className="month-select"
          value={selected || ''}
          onChange={handleMonthChange}
          disabled={loading}
        >
          {monthOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="feedback err">{error}</p>}

      <div className="performance-legend">
        <span className="legend-item present">Present</span>
        <span className="legend-item absent">Absent (with pair)</span>
        <span className="legend-item pending">Pending</span>
        <span className="legend-item neutral">Future / N/A</span>
      </div>

      <div className="content-card performance-table-wrap">
        {loading ? (
          <p className="muted table-loading">Updating…</p>
        ) : (
          <table className="performance-table">
            <thead>
              <tr>
                <th className="sticky-col">Member</th>
                {data?.days?.map((day) => (
                  <th key={day.dateKey} className="day-col" title={day.dateKey}>
                    <span className="day-head">{day.dayName}</span>
                    <span className="day-sub">{day.shortDate}</span>
                  </th>
                ))}
                <th className="summary-col">Present</th>
                <th className="summary-col">Absent</th>
                <th className="summary-col">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows?.length ? (
                data.rows.map((row) => (
                  <tr key={row.member}>
                    <td className="sticky-col member-name">{row.member}</td>
                    {data.days.map((day) => {
                      const cell = row.cells[day.dateKey];
                      return (
                        <td
                          key={day.dateKey}
                          className={`day-cell ${cellClass(cell)}`}
                          title={cellLabel(cell)}
                        >
                          {cell?.status === 'present' && '✓'}
                          {cell?.status === 'absent' && (
                            <span className="absent-text">
                              Absent
                              <small>{cell.pairLabel}</small>
                            </span>
                          )}
                          {cell?.status === 'pending' && '…'}
                          {(cell?.status === 'future' ||
                            cell?.status === 'no_data' ||
                            cell?.status === 'not_assigned') &&
                            '—'}
                        </td>
                      );
                    })}
                    <td className="summary-col present-count">{row.summary.present}</td>
                    <td className="summary-col absent-count">{row.summary.absent}</td>
                    <td className="summary-col rate-col">
                      {row.summary.rate != null ? `${row.summary.rate}%` : '—'}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={(data?.days?.length || 0) + 4} className="empty-row">
                    No performance data for this month
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default Performance;
