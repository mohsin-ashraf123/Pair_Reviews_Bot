import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useBotStatus } from '../context/BotStatusContext';
import { API } from '../config/api.js';
import './Settings.css';

function SettingsSkeleton() {
  return (
    <div className="settings-page settings-skeleton" aria-busy="true">
      <div className="settings-header">
        <span className="set-skel-line set-skel-title" />
        <span className="set-skel-line set-skel-btn" />
      </div>
      <div className="settings-health">
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="set-skel-line set-skel-health" />
        ))}
      </div>
      <div className="settings-panel">
        <span className="set-skel-line set-skel-panel" />
        <span className="set-skel-line set-skel-panel" />
      </div>
    </div>
  );
}

function Settings() {
  const { status, loading, refresh } = useBotStatus();
  const [refreshing, setRefreshing] = useState(false);

  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');
  const pickerRef = useRef(null);

  const loadAi = async () => {
    setAiLoading(true);
    try {
      const res = await axios.get(`${API}/ai`);
      setAi(res.data);
    } catch {
      setAi(null);
    } finally {
      setAiLoading(false);
    }
  };

  const loadModels = async (keyOverride) => {
    setModelsLoading(true);
    setModelsError('');
    try {
      let res;
      if (keyOverride) {
        res = await axios.post(`${API}/ai/models`, { apiKey: keyOverride });
      } else {
        res = await axios.get(`${API}/ai/models`);
      }
      setModels(res.data?.models || []);
      return res.data?.models || [];
    } catch (err) {
      setModels([]);
      const message =
        err.response?.data?.message || err.message || 'Failed to load models';
      setModelsError(message);
      throw new Error(message);
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    loadAi();
  }, []);

  useEffect(() => {
    if (ai?.configured) {
      loadModels().catch(() => {});
    }
  }, [ai?.configured]);

  useEffect(() => {
    const onDoc = (e) => {
      if (!pickerRef.current?.contains(e.target)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setActionMsg('');
    setActionErr('');
    try {
      await Promise.all([refresh(), loadAi()]);
      try {
        if (apiKeyInput.trim()) await loadModels(apiKeyInput.trim());
        else await loadModels();
      } catch {
        /* models error already shown */
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) {
      setActionErr('Paste an OpenRouter API key first.');
      return;
    }
    setSavingKey(true);
    setActionMsg('');
    setActionErr('');
    try {
      await loadModels(key);
      const res = await axios.put(`${API}/ai`, { apiKey: key });
      setAi(res.data);
      setApiKeyInput('');
      setShowKey(false);
      setActionMsg('API key saved. Models loaded.');
      setPickerOpen(true);
    } catch (err) {
      setActionErr(
        err.response?.data?.message || err.message || 'Could not save API key'
      );
    } finally {
      setSavingKey(false);
    }
  };

  const handleClearKey = async () => {
    setSavingKey(true);
    setActionMsg('');
    setActionErr('');
    try {
      const res = await axios.put(`${API}/ai`, {
        clearKey: true,
        modelId: '',
        modelName: '',
      });
      setAi(res.data);
      setModels([]);
      setApiKeyInput('');
      setActionMsg('API key cleared.');
    } catch (err) {
      setActionErr(err.response?.data?.message || 'Could not clear key');
    } finally {
      setSavingKey(false);
    }
  };

  const handleSelectModel = async (model) => {
    setSavingModel(true);
    setActionMsg('');
    setActionErr('');
    try {
      const res = await axios.put(`${API}/ai`, {
        modelId: model.id,
        modelName: model.name,
      });
      setAi(res.data);
      setPickerOpen(false);
      setActionMsg(`Model set to ${model.name}`);
    } catch (err) {
      setActionErr(err.response?.data?.message || 'Could not save model');
    } finally {
      setSavingModel(false);
    }
  };

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (freeOnly && !m.free) return false;
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
      );
    });
  }, [models, freeOnly, search]);

  if (loading && !status) return <SettingsSkeleton />;

  const connected = Boolean(status?.matrixConnected);
  const e2ee = Boolean(status?.e2eeReady);
  const encrypted = Boolean(status?.roomEncrypted);
  const alert = status?.matrixError || status?.needsPasswordLogin;
  const selectedLabel =
    ai?.modelName || ai?.modelId || 'Select a model';

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2>Settings</h2>
        <button
          type="button"
          className="refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <section className="settings-health" aria-label="Bot health">
        <div className={`health-card${connected ? ' ok' : ' bad'}`}>
          <span className="health-label">Connection</span>
          <strong>{connected ? 'Online' : 'Offline'}</strong>
        </div>
        <div className={`health-card${e2ee ? ' ok' : ' bad'}`}>
          <span className="health-label">E2EE</span>
          <strong>{e2ee ? 'Ready' : 'Not ready'}</strong>
        </div>
        <div className={`health-card${encrypted ? ' ok' : ' warn'}`}>
          <span className="health-label">Room</span>
          <strong>{status?.roomName || '—'}</strong>
        </div>
        <div className="health-card">
          <span className="health-label">Timezone</span>
          <strong>{status?.schedule?.timezone || 'Asia/Karachi'}</strong>
        </div>
      </section>

      {alert && (
        <p className="settings-alert">
          {status?.needsPasswordLogin
            ? 'Add MATRIX_USER + MATRIX_PASSWORD in server/.env, then restart the server.'
            : status.matrixError}
        </p>
      )}

      <section className="settings-panel">
        <div className="settings-panel-head">
          <h3>AI (OpenRouter)</h3>
          <span className={ai?.configured ? 'ai-status ok' : 'ai-status'}>
            {aiLoading
              ? '…'
              : ai?.configured
                ? 'Connected'
                : 'Not configured'}
          </span>
        </div>

        <div className="ai-body">
          <p className="ai-help">
            Add your OpenRouter API key. Models load automatically — pick one
            for later AI features.
          </p>

          <label className="ai-label" htmlFor="openrouter-key">
            API key
          </label>
          <div className="ai-key-row">
            <div className="ai-key-field">
              <input
                id="openrouter-key"
                type={showKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  ai?.configured
                    ? `Saved: ${ai.apiKeyMasked}`
                    : 'sk-or-v1-…'
                }
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="ai-ghost-btn"
                onClick={() => setShowKey((v) => !v)}
                tabIndex={-1}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              type="button"
              className="ai-primary-btn"
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
            >
              {savingKey ? 'Saving…' : 'Save & load'}
            </button>
            {ai?.configured && (
              <button
                type="button"
                className="ai-ghost-btn ai-clear"
                onClick={handleClearKey}
                disabled={savingKey}
              >
                Clear
              </button>
            )}
          </div>

          {(ai?.configured || models.length > 0) && (
            <div className="ai-model-block">
              <div className="ai-model-toolbar">
                <label className="ai-label" htmlFor="model-search">
                  Model
                </label>
                <div className="ai-toolbar-actions">
                  <button
                    type="button"
                    className={`ai-chip${freeOnly ? ' active' : ''}`}
                    onClick={() => setFreeOnly((v) => !v)}
                    aria-pressed={freeOnly}
                  >
                    Free only
                  </button>
                  <button
                    type="button"
                    className="ai-ghost-btn"
                    onClick={() => loadModels()}
                    disabled={modelsLoading || !ai?.configured}
                  >
                    {modelsLoading ? 'Loading…' : 'Reload'}
                  </button>
                </div>
              </div>

              <div className="ai-picker" ref={pickerRef}>
                <button
                  type="button"
                  className="ai-picker-trigger"
                  onClick={() => setPickerOpen((v) => !v)}
                  disabled={modelsLoading && !models.length}
                  aria-expanded={pickerOpen}
                >
                  <span className="ai-picker-value">
                    {modelsLoading && !models.length
                      ? 'Loading models…'
                      : selectedLabel}
                  </span>
                  {ai?.modelId && (
                    <span className="ai-picker-id">{ai.modelId}</span>
                  )}
                  <span className="ai-picker-chevron" aria-hidden>
                    {pickerOpen ? '▴' : '▾'}
                  </span>
                </button>

                {pickerOpen && (
                  <div className="ai-picker-menu">
                    <input
                      id="model-search"
                      className="ai-search"
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search models…"
                      autoFocus
                    />
                    <div className="ai-model-list" role="listbox">
                      {modelsError ? (
                        <p className="ai-list-empty">{modelsError}</p>
                      ) : filteredModels.length === 0 ? (
                        <p className="ai-list-empty">
                          {modelsLoading
                            ? 'Loading…'
                            : freeOnly
                              ? 'No free models match.'
                              : 'No models match.'}
                        </p>
                      ) : (
                        filteredModels.map((m) => {
                          const selected = m.id === ai?.modelId;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`ai-model-option${selected ? ' selected' : ''}`}
                              onClick={() => handleSelectModel(m)}
                              disabled={savingModel}
                            >
                              <span className="ai-model-name">
                                {m.name}
                                {m.free && (
                                  <span className="ai-free-tag">Free</span>
                                )}
                              </span>
                              <span className="ai-model-id">{m.id}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                    <div className="ai-picker-foot">
                      {filteredModels.length} of {models.length}
                      {freeOnly ? ' · free filter on' : ''}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {actionMsg && <p className="ai-feedback ok">{actionMsg}</p>}
          {actionErr && <p className="ai-feedback err">{actionErr}</p>}
          {modelsError && !pickerOpen && (
            <p className="ai-feedback err">{modelsError}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export default Settings;
