import { useEffect, useMemo, useState } from 'react';
import { Button, Modal, toast } from '@/components/base';
import {
  listAdminModels,
  listAdminRoutes,
  createAdminModel,
  updateAdminModel,
  setAdminModelStatus,
  saveAdminRoutes,
  validateModelConnection,
  type AdminModelItem,
  type AdminRouteItem,
} from '@/services/api';

const PROVIDER_TYPES = ['kimi', 'qwen', 'deepseek', 'gemini', 'openai_compatible'];
const SUBJECTS = ['math', 'chinese', 'english', '*'];

interface ModelFormState {
  modelKey: string;
  name: string;
  providerType: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  maxOutputTokens: string;
}

const emptyModelForm: ModelFormState = {
  modelKey: '',
  name: '',
  providerType: 'kimi',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  contextWindow: '',
  maxOutputTokens: '',
};

const fieldCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none';

export default function AdminModelsPage() {
  const [models, setModels] = useState<AdminModelItem[]>([]);
  const [routes, setRoutes] = useState<AdminRouteItem[]>([]);
  const [scenes, setScenes] = useState<string[]>([]);
  const [providerTypes, setProviderTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingModel, setEditingModel] = useState<AdminModelItem | null>(null);
  const [form, setForm] = useState<ModelFormState>(emptyModelForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [newRule, setNewRule] = useState({ scene: '', subject: 'math', primaryModelKey: '', fallbackModelKey: '' });
  const [routesSaving, setRoutesSaving] = useState(false);

  const loadModels = async () => {
    try {
      setModels(await listAdminModels());
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '刷新失败');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modelList, routeData] = await Promise.all([listAdminModels(), listAdminRoutes()]);
        if (cancelled) return;
        setModels(modelList);
        setRoutes(routeData.routes);
        setScenes(routeData.scenes);
        setProviderTypes(routeData.providerTypes);
        setNewRule((r) => ({ ...r, scene: r.scene || routeData.scenes[0] || '' }));
      } catch (err: unknown) {
        toast('error', err instanceof Error ? err.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledModels = useMemo(() => models.filter((m) => m.isEnabled), [models]);
  const providerOptions = providerTypes.length > 0 ? providerTypes : PROVIDER_TYPES;

  const isEnabledKey = (k: string) => enabledModels.some((m) => m.modelKey === k);

  // 路由里可能引用了已停用的模型：把这些 key 也列进下拉（disabled 标注），
  // 避免受控 select 的 value 无对应 option 时显示为空。
  const optionKeys = (currentKey: string | null) => {
    const keys = enabledModels.map((m) => m.modelKey);
    return currentKey && !keys.includes(currentKey) ? [currentKey, ...keys] : keys;
  };

  // --- 模型池 CRUD ---

  const openCreate = () => {
    setEditingModel(null);
    setForm(emptyModelForm);
    setFormError('');
    setModalMode('create');
  };

  const openEdit = (m: AdminModelItem) => {
    setEditingModel(m);
    setForm({
      modelKey: m.modelKey,
      name: m.name,
      providerType: m.providerType,
      modelId: m.modelId,
      baseUrl: m.baseUrl,
      apiKey: '',
      contextWindow: m.contextWindow ? String(m.contextWindow) : '',
      maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : '',
    });
    setFormError('');
    setModalMode('edit');
  };

  const handleToggleStatus = async (m: AdminModelItem) => {
    try {
      await setAdminModelStatus(m.modelKey, !m.isEnabled);
      toast('success', m.isEnabled ? '已停用' : '已启用');
      await loadModels();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleTest = async (m: AdminModelItem) => {
    try {
      const res = await validateModelConnection(m.modelKey);
      if (res.ok) {
        toast('success', `连通成功 · ${res.latencyMs}ms`);
      } else {
        toast('error', res.sample || '连接失败');
      }
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '连接失败');
    }
  };

  const handleCreateModel = async () => {
    setFormError('');
    if (
      !form.modelKey.trim() ||
      !form.name.trim() ||
      !form.providerType ||
      !form.modelId.trim() ||
      !form.baseUrl.trim() ||
      !form.apiKey
    ) {
      setFormError('请完整填写必填项（模型名/名称/类型/modelId/Base URL/apiKey）');
      return;
    }
    setSaving(true);
    try {
      await createAdminModel({
        modelKey: form.modelKey.trim(),
        name: form.name.trim(),
        providerType: form.providerType,
        modelId: form.modelId.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
        ...(form.maxOutputTokens ? { maxOutputTokens: Number(form.maxOutputTokens) } : {}),
      });
      toast('success', `模型 ${form.modelKey.trim()} 已创建`);
      setModalMode(null);
      await loadModels();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateModel = async () => {
    setFormError('');
    if (!editingModel) return;
    if (!form.name.trim() || !form.providerType || !form.modelId.trim() || !form.baseUrl.trim()) {
      setFormError('请完整填写必填项（名称/类型/modelId/Base URL）');
      return;
    }
    setSaving(true);
    try {
      await updateAdminModel(editingModel.modelKey, {
        name: form.name.trim(),
        providerType: form.providerType,
        modelId: form.modelId.trim(),
        baseUrl: form.baseUrl.trim(),
        // apiKey 留空则不修改（后端不更新该字段）
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      });
      toast('success', `模型 ${editingModel.modelKey} 已更新`);
      setModalMode(null);
      await loadModels();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  // --- 场景路由 ---

  const updateRoute = (index: number, patch: Partial<AdminRouteItem>) => {
    setRoutes((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const handleAddRule = () => {
    if (!newRule.scene || !newRule.subject || !newRule.primaryModelKey) {
      toast('error', '请选择场景、学科与主模型');
      return;
    }
    setRoutes((prev) => [
      ...prev,
      {
        scene: newRule.scene,
        subject: newRule.subject,
        primaryModelKey: newRule.primaryModelKey,
        fallbackModelKey: newRule.fallbackModelKey || null,
      },
    ]);
    setNewRule((r) => ({ ...r, primaryModelKey: '', fallbackModelKey: '' }));
  };

  const handleSaveRoutes = async () => {
    // 空主模型的占位行不提交（前端保证 primaryModelKey 必选）
    const clean = routes
      .filter((r) => r.primaryModelKey)
      .map((r) => ({ ...r, fallbackModelKey: r.fallbackModelKey || null }));
    setRoutesSaving(true);
    try {
      await saveAdminRoutes(clean);
      setRoutes(clean);
      toast('success', '路由已生效');
    } catch (err: unknown) {
      // 1004 整批拒时保留原 routes 不变（不 setRoutes）
      toast('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setRoutesSaving(false);
    }
  };

  if (loading && models.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>模型配置</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>管理模型池与场景路由，保存即生效。</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-sm" style={{ color: 'var(--text-secondary)' }}>
          加载中...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>模型配置</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>管理模型池与场景路由，保存即生效。</p>
      </div>

      {/* 上半：模型池 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>模型池</h2>
          <Button variant="primary" size="sm" onClick={openCreate}>新增模型</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--text-secondary)] border-b border-gray-100">
                <th className="px-5 py-3 font-semibold">模型名</th>
                <th className="px-5 py-3 font-semibold">名称</th>
                <th className="px-5 py-3 font-semibold">modelId</th>
                <th className="px-5 py-3 font-semibold">Base URL</th>
                <th className="px-5 py-3 font-semibold">apiKey</th>
                <th className="px-5 py-3 font-semibold">类型</th>
                <th className="px-5 py-3 font-semibold">状态</th>
                <th className="px-5 py-3 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.modelKey} className="border-b border-gray-50 last:border-0">
                  <td className="px-5 py-3 font-semibold" style={{ color: 'var(--text-primary)' }}>{m.modelKey}</td>
                  <td className="px-5 py-3">{m.name}</td>
                  <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{m.modelId}</td>
                  <td className="px-5 py-3 max-w-[200px] truncate">{m.baseUrl || '-'}</td>
                  <td className="px-5 py-3">{m.apiKeyMasked || '-'}</td>
                  <td className="px-5 py-3">{m.providerType}</td>
                  <td className="px-5 py-3">
                    <span
                      className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded"
                      style={{
                        color: m.isEnabled ? '#059669' : 'var(--text-secondary)',
                        backgroundColor: m.isEnabled ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
                      }}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${m.isEnabled ? 'bg-[#059669]' : 'bg-[var(--text-secondary)]'}`}></span>
                      {m.isEnabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex gap-3 justify-end text-xs font-semibold whitespace-nowrap">
                      <button className="text-[var(--brand-500)] hover:underline" onClick={() => openEdit(m)}>编辑</button>
                      <button className="text-[var(--text-secondary)] hover:underline" onClick={() => handleToggleStatus(m)}>
                        {m.isEnabled ? '停用' : '启用'}
                      </button>
                      <button className="text-[var(--text-secondary)] hover:underline" onClick={() => handleTest(m)}>测试连接</button>
                    </div>
                  </td>
                </tr>
              ))}
              {models.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]">暂无模型</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 下半：场景路由 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>场景路由</h2>
          <Button variant="secondary" size="sm" loading={routesSaving} onClick={handleSaveRoutes}>保存路由表</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--text-secondary)] border-b border-gray-100">
                <th className="px-5 py-3 font-semibold">场景</th>
                <th className="px-5 py-3 font-semibold">学科</th>
                <th className="px-5 py-3 font-semibold">主模型</th>
                <th className="px-5 py-3 font-semibold">备选模型</th>
                <th className="px-5 py-3 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r, i) => (
                <tr key={`${r.scene}-${r.subject}-${i}`} className="border-b border-gray-50 last:border-0">
                  <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{r.scene}</td>
                  <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{r.subject}</td>
                  <td className="px-5 py-3">
                    <select
                      value={r.primaryModelKey}
                      onChange={(e) => updateRoute(i, { primaryModelKey: e.target.value })}
                      className="w-44 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
                    >
                      {optionKeys(r.primaryModelKey).map((k) => (
                        <option key={k} value={k} disabled={!isEnabledKey(k)}>
                          {k}{isEnabledKey(k) ? '' : '（已停用）'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-5 py-3">
                    <select
                      value={r.fallbackModelKey ?? ''}
                      onChange={(e) => updateRoute(i, { fallbackModelKey: e.target.value || null })}
                      className="w-44 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
                    >
                      <option value="">无</option>
                      {optionKeys(r.fallbackModelKey).map((k) => (
                        <option key={k} value={k} disabled={!isEnabledKey(k)}>
                          {k}{isEnabledKey(k) ? '' : '（已停用）'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      className="text-xs font-semibold text-[var(--text-secondary)] hover:underline"
                      onClick={() => setRoutes((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {routes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-sm text-[var(--text-secondary)]">暂无路由规则</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 新增规则 */}
        <div className="px-5 py-4 border-t border-gray-100 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>场景</label>
            <select
              value={newRule.scene}
              onChange={(e) => setNewRule((r) => ({ ...r, scene: e.target.value }))}
              className="w-32 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              {!newRule.scene && <option value="" disabled>请选择场景</option>}
              {scenes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>学科</label>
            <select
              value={newRule.subject}
              onChange={(e) => setNewRule((r) => ({ ...r, subject: e.target.value }))}
              className="w-32 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>主模型</label>
            <select
              value={newRule.primaryModelKey}
              onChange={(e) => setNewRule((r) => ({ ...r, primaryModelKey: e.target.value }))}
              className="w-40 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              <option value="" disabled>请选择主模型</option>
              {enabledModels.map((m) => <option key={m.modelKey} value={m.modelKey}>{m.modelKey}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>备选模型</label>
            <select
              value={newRule.fallbackModelKey}
              onChange={(e) => setNewRule((r) => ({ ...r, fallbackModelKey: e.target.value }))}
              className="w-40 px-2 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              <option value="">无</option>
              {enabledModels.map((m) => <option key={m.modelKey} value={m.modelKey}>{m.modelKey}</option>)}
            </select>
          </div>
          <Button variant="primary" size="sm" onClick={handleAddRule}>添加规则</Button>
        </div>
      </div>

      {/* 新增 / 编辑模型 Modal */}
      <Modal
        open={modalMode !== null}
        onClose={() => {
          if (!saving) setModalMode(null);
        }}
        title={modalMode === 'edit' ? `编辑模型 ${editingModel?.modelKey ?? ''}` : '新增模型'}
        className="max-h-[88vh] overflow-y-auto"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>模型名（modelKey）</label>
              <input
                value={form.modelKey}
                onChange={(e) => setForm({ ...form, modelKey: e.target.value })}
                placeholder="如：kimi-latest"
                disabled={modalMode === 'edit'}
                maxLength={50}
                className={fieldCls}
              />
              {modalMode === 'edit' && (
                <p className="text-[11px] mt-1 text-[var(--text-secondary)]">模型名创建后不可修改</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如：Kimi 最新版"
                maxLength={100}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>类型（providerType）</label>
              <select
                value={form.providerType}
                onChange={(e) => setForm({ ...form, providerType: e.target.value })}
                className={fieldCls}
              >
                {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>modelId</label>
              <input
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                placeholder="如：kimi-latest"
                maxLength={100}
                className={fieldCls}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Base URL</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="如：https://api.moonshot.cn/v1"
              maxLength={500}
              className={fieldCls}
            />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>apiKey</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={modalMode === 'edit' ? '留空则不修改' : '输入模型 API Key'}
              maxLength={500}
              className={fieldCls}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>上下文窗口（可选）</label>
              <input
                type="number"
                value={form.contextWindow}
                onChange={(e) => setForm({ ...form, contextWindow: e.target.value })}
                placeholder="如：128000"
                min={1}
                disabled={modalMode === 'edit'}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>最大输出（可选）</label>
              <input
                type="number"
                value={form.maxOutputTokens}
                onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })}
                placeholder="如：8192"
                min={1}
                disabled={modalMode === 'edit'}
                className={fieldCls}
              />
            </div>
          </div>
          {formError && <p className="text-sm" style={{ color: 'var(--error)' }}>{formError}</p>}
          <div className="flex gap-3 justify-end pt-2 border-t border-gray-100">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setModalMode(null)}>取消</Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={modalMode === 'edit' ? handleUpdateModel : handleCreateModel}
            >
              {modalMode === 'edit' ? '保存修改' : '确认创建'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
