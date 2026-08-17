import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API } from '../config/api.js';
import MonthPicker from '../components/ui/MonthPicker.jsx';
import { MONTH_NAMES, buildMonthOptions } from '../utils/months.js';
import './Pairs.css';

function todayKeyKarachi() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function formatShortDate(dateKey) {
  if (!dateKey) return '—';
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function PairsSkeleton() {
  return (
    <div className="pairs-page pairs-skeleton" aria-busy="true">
      <div className="pairs-header">
        <div className="pairs-header-text">
          <span className="pairs-skel-line pairs-skel-title" />
          <span className="pairs-skel-line pairs-skel-sub" />
        </div>
        <span className="pairs-skel-line pairs-skel-picker" />
      </div>
      <div className="pairs-table-card">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="pairs-skel-row">
            <span className="pairs-skel-line pairs-skel-num" />
            <span className="pairs-skel-line pairs-skel-date" />
            <span className="pairs-skel-line pairs-skel-day" />
            <span className="pairs-skel-line pairs-skel-lead" />
            <span className="pairs-skel-line pairs-skel-pairs" />
            <span className="pairs-skel-line pairs-skel-status" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Pairs() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [savingKey, setSavingKey] = useState('');
  const todayKey = useMemo(() => todayKeyKarachi(), []);

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

  const handleHolidayChange = async (dateKey, nextValue) => {
    const holiday = nextValue === 'holiday';
    setSavingKey(dateKey);
    setError('');

    // Optimistic UI
    setData((prev) => {
      if (!prev?.schedule) return prev;
      return {
        ...prev,
        schedule: prev.schedule.map((row) =>
          row.dateKey === dateKey ? { ...row, isHoliday: holiday } : row
        ),
      };
    });

    try {
      await axios.put(`${API}/holidays`, { dateKey, holiday });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update holiday');
      // Reload to restore truth
      if (data?.year && data?.month) {
        await loadMonth(data.year, data.month);
      }
    } finally {
      setSavingKey('');
    }
  };

  const monthLabel = data
    ? `${MONTH_NAMES[data.month - 1]} ${data.year}`
    : '';

  const holidayCount = data?.schedule?.filter((r) => r.isHoliday).length || 0;

  if (loading && !data) {
    return <PairsSkeleton />;
  }

  return (
    <div className="pairs-page">
      <div className="pairs-header">
        <div className="pairs-header-text">
          <p className="pairs-kicker">Monthly schedule</p>
          <h2>{monthLabel || 'Monthly Pairs'}</h2>
          <p className="muted pairs-subtitle">
            Weekdays only · Sat &amp; Sun off
            {data?.schedule?.length > 0 && (
              <span className="pairs-count-pill">
                {data.schedule.length} days
              </span>
            )}
            {holidayCount > 0 && (
              <span className="pairs-count-pill holiday">
                {holidayCount} holiday{holidayCount === 1 ? '' : 's'}
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

      <div className={`pairs-table-card${loading ? ' is-loading' : ''}`}>
        <div className="pairs-table-scroll">
          <table className="pairs-table">
            <thead>
              <tr>
                <th className="col-num">#</th>
                <th>Date</th>
                <th>Day</th>
                <th>Lead</th>
                <th>Pairs</th>
                <th className="col-status">Day type</th>
              </tr>
            </thead>
            <tbody>
              {data?.schedule?.length ? (
                data.schedule.map((row, index) => {
                  const isToday = row.dateKey === todayKey;
                  const isHoliday = Boolean(row.isHoliday);
                  return (
                    <tr
                      key={row.dateKey}
                      className={[
                        isToday ? 'is-today' : '',
                        isHoliday ? 'is-holiday' : '',
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined}
                    >
                      <td className="col-num">{index + 1}</td>
                      <td className="col-date">
                        <span className="date-main">{formatShortDate(row.dateKey)}</span>
                        {isToday && <span className="today-tag">Today</span>}
                        {isHoliday && <span className="holiday-tag">Holiday</span>}
                      </td>
                      <td className="col-day">{row.dayName}</td>
                      <td className="col-lead">
                        <span className="lead-chip">{row.lead}</span>
                      </td>
                      <td className="col-pairs">
                        <div className="pairs-cell">
                          {row.pairs.map((pair) => (
                            <span key={pair} className="pair-chip">
                              {pair}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="col-status">
                        <select
                          className={`day-type-select${isHoliday ? ' holiday' : ''}`}
                          value={isHoliday ? 'holiday' : 'working'}
                          disabled={savingKey === row.dateKey || loading}
                          aria-label={`Day type for ${row.dateKey}`}
                          onChange={(e) =>
                            handleHolidayChange(row.dateKey, e.target.value)
                          }
                        >
                          <option value="working">Working day</option>
                          <option value="holiday">Holiday</option>
                        </select>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="empty-row">
                    No weekday pairs for this month
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

export default Pairs;
