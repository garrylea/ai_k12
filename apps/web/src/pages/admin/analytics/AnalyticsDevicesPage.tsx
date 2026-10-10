import { useEffect, useState } from 'react';
import { getAdminDevices, type DevicesData } from '@/services/api';
import { toast } from '@/components/base';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, fmtDuration, deviceLabel } from './shared';

type DeviceDimension = keyof DevicesData['distributions'];

const DIMENSIONS: { key: DeviceDimension; label: string }[] = [
  { key: 'platformClass', label: '平台类型' },
  { key: 'screenClass', label: '屏幕尺寸' },
  { key: 'inputType', label: '输入方式' },
  { key: 'appShell', label: '应用外壳' },
  { key: 'browser', label: '浏览器' },
];

/**
 * 埋点 Phase 2 · 设备分析（delta spec §7 Task 16）。
 * 五维分布（下拉切换，默认 platformClass）+ 多设备分档表 + 设备切换计数一行。
 * accuracy 仅 platformClass 维度有值（服务端 brief 裁定），其余维度显示 '—'。
 */
export default function AnalyticsDevicesPage() {
  const w = useAdminAnalyticsWindow();
  const [dimension, setDimension] = useState<DeviceDimension>('platformClass');
  const [data, setData] = useState<DevicesData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminDevices({ from: w.from, to: w.to })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '加载失败'));
    return () => {
      cancelled = true;
    };
  }, [w.from, w.to]);

  const rows = data ? data.distributions[dimension] : [];

  return (
    <AnalyticsPageShell
      title="设备分析"
      description="学生用什么设备学、各设备答得怎么样"
      window={w}
      onWindowChange={(next) => {
        w.setFrom(next.from);
        w.setTo(next.to);
      }}
    >
      <div>
        <select
          aria-label="设备维度"
          value={dimension}
          onChange={(e) => setDimension(e.target.value as DeviceDimension)}
          className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm"
          style={{ color: 'var(--text-primary)' }}
        >
          {DIMENSIONS.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="devices-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">设备</th>
              <th className="px-4 py-3 font-medium">人数</th>
              <th className="px-4 py-3 font-medium">时长</th>
              <th className="px-4 py-3 font-medium">会话数</th>
              <th className="px-4 py-3 font-medium">正确率</th>
            </tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-gray-200 last:border-b-0" data-testid={`device-row-${r.key}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{deviceLabel(r.key)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{r.students}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtDuration(r.seconds)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{r.sessions}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{fmtPct(r.accuracy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>多设备分档</h2>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="multi-device-table">
          <thead>
            <tr className="border-b border-gray-200 text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="px-4 py-3 font-medium">设备种数</th>
              <th className="px-4 py-3 font-medium">人数</th>
            </tr>
          </thead>
          <tbody>
            {data && data.multiDevice.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  暂无数据
                </td>
              </tr>
            )}
            {data?.multiDevice.map((m) => (
              <tr key={m.count} className="border-b border-gray-200 last:border-b-0" data-testid={`multi-device-row-${m.count}`}>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.count} 种</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{m.students}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm" style={{ color: 'var(--text-secondary)' }} data-testid="switches-line">
        {data ? `设备切换 ${data.switches.count} 次 · 涉及 ${data.switches.students} 人` : '…'}
      </p>
    </AnalyticsPageShell>
  );
}
