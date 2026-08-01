import { useState, useRef, useEffect } from 'react';
import clsx from 'clsx';
import { Button } from '@/components/base';
import { motion } from 'framer-motion';

interface Message {
  id: number;
  role: 'ai' | 'student';
  content: string;
  type?: 'normal' | 'chat-off-topic' | 'fallback' | 'knowledge-summary';
}

interface AIDialogueProps {
  open: boolean;
  onClose: () => void;
  contextLabel?: string;
  isMainline?: boolean;
}

export function AIDialogue({ open, onClose, contextLabel = '讨论', isMainline = true }: AIDialogueProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: 'ai',
      content: isMainline
        ? '让我们一起来思考这个问题吧。你先说说你读到了什么？'
        : '你好，这次想探索什么知识点？可以直接问我问题。',
    },
  ]);
  const [input, setInput] = useState('');
  const [failureCount, setFailureCount] = useState(0);
  const [showFallback, setShowFallback] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = (role: 'ai' | 'student', content: string, type?: Message['type']) => {
    setMessages((prev) => [...prev, { id: Date.now(), role, content, type }]);
  };

  const handleSend = () => {
    if (!input.trim()) return;
    const text = input.trim();
    addMessage('student', text);
    setInput('');

    const chatKeywords = ['游戏', '娱乐', '你好', '无聊', '不想学'];
    const isChat = chatKeywords.some((k) => text.includes(k));

    if (isChat) {
      addMessage(
        'ai',
        '我是你的学习助手，这个话题课后你可以和好朋友聊，现在我们还是先来看看这个知识点吧。',
        'chat-off-topic',
      );
      setFailureCount((c) => c + 1);
      return;
    }

    const cannotKeywords = ['不会', '不懂', '不知道', '太难'];
    const cannot = cannotKeywords.some((k) => text.includes(k));

    if (cannot) {
      const newFailure = failureCount + 1;
      setFailureCount(newFailure);

      if (newFailure >= 3) {
        setShowFallback(true);
        addMessage('ai', '没关系，我来完整讲解一遍。仔细看下面的解析。', 'fallback');
        addMessage(
          'ai',
          '## 完整解析\n\n**步骤1**：根据题意列出已知条件...\n\n**步骤2**：代入公式...\n\n**答案**：因此结果是...\n\n记住这个解题思路，下次就能独立解答了。',
          'knowledge-summary',
        );
        setFailureCount(0);
        return;
      }

      addMessage(
        'ai',
        `别着急，我们再想想。我问你：这个知识点对应的公式是什么？提示：注意题目中的关键词哦。（第 ${newFailure}/3 次引导）`,
      );
      return;
    }

    addMessage(
      'ai',
      `嗯，说得有道理。那如果换个角度想想：这个条件能否推导出什么？\n\n${isMainline ? '（记住我们要围绕当前卡片内容来思考）' : '（可以联系你学过的其他知识点）'}`,
    );
    setFailureCount(0);
  };

  const handleUnderstand = () => {
    addMessage('ai', '太好了，那我们继续往下吧。');
  };

  if (!open) return null;

  return (
    <motion.div
      className={clsx(
        'fixed right-0 top-0 h-full w-[26.25rem] max-w-full z-30',
        'bg-[var(--bg-elevated)] shadow-[var(--shadow-elevated)]',
        'flex flex-col',
      )}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 260, damping: 24 }}
    >
      {/* 顶部提示带 */}
      <div className="px-4 py-3 bg-[var(--bg-subtle)] flex items-center gap-2 text-sm">
        <span className="text-[var(--text-secondary)]">
          {isMainline ? `当前讨论范围：${contextLabel}` : `自由探索 · ${contextLabel}`}
        </span>
        <button
          onClick={onClose}
          className="ml-auto w-7 h-7 flex items-center justify-center rounded-[var(--radius-button)] text-[var(--text-tertiary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
          aria-label="关闭"
        >
          &times;
        </button>
      </div>

      {/* 对话区 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={clsx(
              'flex gap-3',
              msg.role === 'student' ? 'flex-row-reverse' : 'flex-row',
            )}
          >
            {msg.role === 'ai' && (
              <div className="shrink-0 w-9 h-9 rounded-full bg-[var(--brand-500)] flex items-center justify-center text-white text-xs font-bold">
                AI
              </div>
            )}
            <div
              className={clsx(
                'max-w-[75%] px-4 py-3 rounded-[var(--radius-card)] text-sm leading-relaxed whitespace-pre-wrap',
                msg.role === 'student'
                  ? 'bg-[var(--brand-500)] text-white rounded-tr-sm'
                  : msg.type === 'chat-off-topic'
                    ? 'bg-[var(--success)]/10 border border-[var(--success)]/40 text-[var(--text-primary)] rounded-tl-sm'
                    : msg.type === 'fallback'
                      ? 'bg-[var(--brand-100)] border border-[var(--brand-400)] text-[var(--text-primary)] rounded-tl-sm'
                      : 'bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-tl-sm',
              )}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* 兜底按钮 */}
        {showFallback && (
          <div className="flex justify-center">
            <Button variant="primary" size="md" onClick={() => { setShowFallback(false); handleUnderstand(); }}>
              我懂了，继续
            </Button>
          </div>
        )}

        {!showFallback && messages.length > 1 && (
          <div className="flex justify-center gap-3">
            <Button variant="ghost" size="sm">换种说法</Button>
            <Button variant="primary" size="sm" onClick={handleUnderstand}>我懂了</Button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="px-4 py-3 border-t border-[var(--bg-subtle)]">
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 flex items-center justify-center rounded-[var(--radius-button)] text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--brand-500)]" title="公式编辑器" aria-label="公式编辑器">
            <span className="text-lg">∑</span>
          </button>
          <button className="w-9 h-9 flex items-center justify-center rounded-[var(--radius-button)] text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--brand-500)]" title="拍照" aria-label="拍照">
            <svg className="w-[1.125rem] h-[1.125rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
          <button className="w-9 h-9 flex items-center justify-center rounded-[var(--radius-button)] text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--brand-500)]" title="手写" aria-label="手写">
            <svg className="w-[1.125rem] h-[1.125rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              <path d="M2 2l7.586 7.586" />
              <circle cx="11" cy="11" r="2" />
            </svg>
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="输入你的想法..."
            className="flex-1 px-4 py-2.5 bg-[var(--bg-subtle)] rounded-[var(--radius-pill)] outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]"
          />
          <Button variant="primary" size="sm" onClick={handleSend}>发送</Button>
        </div>
      </div>
    </motion.div>
  );
}
