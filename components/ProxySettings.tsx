'use client';

import { useState, useEffect } from 'react';
import { Settings, X, Check } from 'lucide-react';

const PROXY_STORAGE_KEY = 'btc-iv-proxy-settings';

interface ProxySettings {
  enabled: boolean;
  host: string;
  port: number;
}

const defaultSettings: ProxySettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 7890,
};

export function useProxySettings() {
  const [settings, setSettings] = useState<ProxySettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(PROXY_STORAGE_KEY);
        if (saved) {
          setSettings(JSON.parse(saved));
        }
      } catch (e) {
        console.error('Failed to load proxy settings:', e);
      }
      setIsLoaded(true);
    }
  }, []);

  const saveSettings = (newSettings: ProxySettings) => {
    setSettings(newSettings);
    if (typeof window !== 'undefined') {
      localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(newSettings));
    }
  };

  const getProxyUrl = () => {
    if (!settings.enabled) return null;
    return `http://${settings.host}:${settings.port}`;
  };

  return {
    settings,
    setSettings: saveSettings,
    isLoaded,
    getProxyUrl,
  };
}

interface ProxySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProxySettingsModal({ isOpen, onClose }: ProxySettingsModalProps) {
  const { settings, setSettings } = useProxySettings();
  const [localSettings, setLocalSettings] = useState<ProxySettings>(settings);

  useEffect(() => {
    setLocalSettings(settings);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = () => {
    setSettings(localSettings);
    onClose();
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings className="w-5 h-5" />
            代理设置
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={localSettings.enabled}
              onChange={(e) => setLocalSettings({ ...localSettings, enabled: e.target.checked })}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-slate-200">启用代理</span>
          </label>

          <div className={localSettings.enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">
                  代理地址
                </label>
                <input
                  type="text"
                  value={localSettings.host}
                  onChange={(e) => setLocalSettings({ ...localSettings, host: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="127.0.0.1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">
                  端口
                </label>
                <input
                  type="number"
                  value={localSettings.port}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setLocalSettings({ ...localSettings, port: isNaN(val) ? localSettings.port : val });
                  }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="7890"
                />
              </div>

              <div className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                <p className="text-sm text-slate-400">
                  常用端口：
                  <span className="text-slate-200 ml-2">7890</span>
                  <span className="text-slate-400 mx-2">|</span>
                  <span className="text-slate-200">1080</span>
                  <span className="text-slate-400 mx-2">|</span>
                  <span className="text-slate-200">59526</span>
                  <span className="text-slate-400 mx-2">|</span>
                  <span className="text-slate-200">59527</span>
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" />
            保存并刷新
          </button>
        </div>
      </div>
    </div>
  );
}
