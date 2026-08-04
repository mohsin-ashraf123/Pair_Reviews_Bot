import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import MonthPicker from '../components/ui/MonthPicker.jsx';
import { MONTH_NAMES, buildMonthOptions } from '../utils/months.js';
import './Pairs.css';

function Pairs() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const loadMonth = async (year, month) => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.get(`${API}/month`, {
        params: year && month ? { year, month } : undefined,
      });
      setData(res.data);
      setSelected(`${res.data.year}-${res.data.month}`);
    } catch (err) {
      setData(null);
      setError(err.response?.data?.message || 'Failed to load monthly pairs');
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

  const handleMonthChange = (value) => {
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
        <p className="muted">Loading monthly pairs…</p>
      </div>
    );
  }

  return (
    <div className="pairs-page">
      <div className="pairs-header">
        <div className="pairs-header-text">
          <h2>{monthLabel || 'Monthly Pairs'}</h2>
          <p className="muted pairs-subtitle">
            Weekdays only — Sat &amp; Sun off
            {data?.schedule?.length > 0 && (
              <span className="pairs-count-inline">
                {' · '}{data.schedule.length} working days
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

      <div className="content-card pairs-table-wrap">
        {loading ? (
          <p className="muted table-loading">Updating…</p>
        ) : (
          <table className="pairs-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Day</th>
                <th>Lead</th>
                <th>Pairs</th>
              </tr>
            </thead>
            <tbody>
              {data?.schedule?.length ? (
                data.schedule.map((row, index) => (
                  <tr key={row.dateKey}>
                    <td className="col-num">{index + 1}</td>
                    <td className="col-date">{row.dateKey}</td>
                    <td className="col-day">{row.dayName}</td>
                    <td className="col-lead">{row.lead}</td>
                    <td className="col-pairs">
                      <div className="pairs-cell">
                        {row.pairs.map((pair) => (
                          <span key={pair} className="pair-chip">
                            {pair}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="empty-row">
                    No weekday pairs for this month
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

export default Pairs;
