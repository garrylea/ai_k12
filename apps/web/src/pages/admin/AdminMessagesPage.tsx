import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, toast } from '@/components/base';
import {
  sendAdminMessage,
  listAdminMessages,
  deleteAdminMessage,
  searchParents,
  type AdminMessageItem,
  type AdminParentItem,
} from '@/services/api';

type MessageType = 'promo' | 'learning' | 'system';
type Scope = 'broadcast' | 'target';

const TYPE_LABELS: Record<MessageType, string> = {
  promo: '优惠',
  learning: '学情',
  system: '系统公告',
};

const TYPE_STYLES: Record<MessageType, { color: string; bg: string }> = {
  promo: { color: '#1D4ED8', bg: 'rgba(29,78,216,0.08)' },
  learning: { color: '#047857', bg: 'rgba(4,120,87,0.08)' },
  system: { color: 'var(--text-secondary)', bg: 'rgba(0,0,0,0.04)' },
};

const emptyForm = { type: 'promo' as MessageType, title: '', content: '' };

/** 打码手机号：前 3 位 + **** + 后 4 位。 */
const maskPhone = (phone: string) =>
  phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;

export default function AdminMessagesPage() {
  const [type, setType] = useState<MessageType>(emptyForm.type);
  const [title, setTitle] = useState(emptyForm.title);
  const [content, setContent] = useState(emptyForm.content);
  const [scope, setScope] = useState<Scope>('broadcast');
  const [parentSearch, setParentSearch] = useState('');
  const [parentCandidates, setParentCandidates] = useState<AdminParentItem[]>([]);
  const [targetParent, setTargetParent] = useState<AdminParentItem | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<AdminMessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<AdminMessageItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setMessages(await listAdminMessages());
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleQuery = async () => {
    try {
      const list = await searchParents(parentSearch.trim());
      setParentCandidates(list.slice(0, 10));
      setHasSearched(true);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '查询失败');
    }
  };

  const handleSend = async () => {
    if (!title.trim() || !content.trim()) {
      toast('error', '请填写标题与正文');
      return;
    }
    setSending(true);
    try {
      await sendAdminMessage({
        type,
        title: title.trim(),
        content: content.trim(),
        ...(targetParent ? { parentId: targetParent.id } : {}),
      });
      toast('success', '已发送');
      setType(emptyForm.type);
      setTitle(emptyForm.title);
      setContent(emptyForm.content);
      setScope('broadcast');
      setTargetParent(null);
      setParentCandidates([]);
      setParentSearch('');
      setHasSearched(false);
      await load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const m = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAdminMessage(m.id);
      toast('success', '已撤回');
      await load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '撤回失败');
    }
  };

  const typeTag = (t: string) => {
    const key: MessageType =
      t === 'promo' || t === 'learning' || t === 'system' ? t : 'system';
    const s = TYPE_STYLES[key];
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
        style={{ color: s.color, backgroundColor: s.bg }}
      >
        {TYPE_LABELS[key]}
      </span>
    );
  };

  const radioBase =
    'flex items-center gap-2 px-4 h-10 rounded-lg border text-sm font-semibold cursor-pointer transition-colors';
  const radioActive =
    'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]';
  const radioInactive =
    'border-gray-200 bg-white text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]';
  const radioDot = (selected: boolean) => (
    <span
      className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
        selected ? 'border-[var(--brand-500)]' : 'border-gray-300'
      }`}
    >
      {selected && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-500)]" />}
    </span>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
          消息推送
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          向全体家长或指定家长推送通知消息，支持优惠、学情、系统公告三类。
        </p>
      </div>

      {/* 发送表单 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
        <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>发送新消息</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>消息类型</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as MessageType)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
            >
              <option value="promo">优惠</option>
              <option value="learning">学情</option>
              <option value="system">系统公告</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="消息标题"
              maxLength={100}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>正文</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="消息正文内容..."
            rows={4}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none resize-y min-h-24"
          />
        </div>

        {/* 发送范围 */}
        <div>
          <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>发送范围</label>
          <div className="flex gap-3">
            <button
              type="button"
              className={`${radioBase} ${scope === 'broadcast' ? radioActive : radioInactive}`}
              onClick={() => {
                setScope('broadcast');
                setTargetParent(null);
                setParentCandidates([]);
                setHasSearched(false);
              }}
            >
              {radioDot(scope === 'broadcast')}
              全体家长
            </button>
            <button
              type="button"
              className={`${radioBase} ${scope === 'target' ? radioActive : radioInactive}`}
              onClick={() => setScope('target')}
            >
              {radioDot(scope === 'target')}
              指定家长
            </button>
          </div>
        </div>

        {scope === 'target' && (
          <div className="space-y-3">
            {targetParent ? (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 text-sm">
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  发给：{maskPhone(targetParent.phone)} {targetParent.name ?? ''}
                </span>
                <button
                  type="button"
                  className="text-xs font-semibold text-[var(--text-secondary)] hover:underline"
                  onClick={() => setTargetParent(null)}
                >
                  取消
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    value={parentSearch}
                    onChange={(e) => setParentSearch(e.target.value)}
                    placeholder="输入家长手机号或姓名"
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-md focus:border-[var(--brand-500)] outline-none"
                  />
                  <Button variant="secondary" size="md" onClick={handleQuery}>查询</Button>
                </div>
                {parentCandidates.length > 0 && (
                  <ul className="border border-gray-200 rounded-lg overflow-hidden">
                    {parentCandidates.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-subtle)] border-b border-gray-50 last:border-0"
                          onClick={() => {
                            setTargetParent(p);
                            setParentCandidates([]);
                            setParentSearch('');
                            setHasSearched(false);
                          }}
                        >
                          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{maskPhone(p.phone)}</span>
                          <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>{p.name ?? '-'}</span>
                          <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{p.studentCount} 个学生</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {hasSearched && parentCandidates.length === 0 && (
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>未找到匹配家长</p>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-2 border-t border-gray-100">
          <Button variant="primary" size="md" loading={sending} onClick={handleSend}>发送</Button>
        </div>
      </div>

      {/* 已发列表 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>已发消息</h2>
        </div>
        {messages.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            {loading ? '加载中...' : '暂无已发送消息'}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {messages.map((m) => (
              <div key={m.id} className="px-5 py-4 flex items-center gap-4">
                <div className="flex items-center gap-2 shrink-0">
                  {typeTag(m.type)}
                  {m.isBroadcast && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600">
                      全员
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {m.title}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    触达 {m.reachCount} / 已读 {m.readCount} · {new Date(m.createdAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button
                  className="text-xs font-semibold text-[var(--error)] hover:underline shrink-0"
                  onClick={() => setDeleteTarget(m)}
                >
                  撤回
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="提示："
        message="确认撤回该消息？已读记录将一并清除。"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
