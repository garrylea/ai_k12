import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlanetNode, SectionCard } from '@/components/business';
import { Progress } from '@/components/base';
import { Chapter, Section } from '@/types';

// 模拟章节数据（小学三年级数学人教版 上册）
const mockChapters: Chapter[] = [
  {
    id: 'ch1',
    title: '时、分、秒',
    order: 1,
    importance: 'medium',
    status: 'completed',
    progress: 100,
    sections: [
      { id: '1-1', title: '秒的认识', order: 1, knowledgePointCount: 3, status: 'completed', progress: 100 },
      { id: '1-2', title: '时间的计算', order: 2, knowledgePointCount: 4, status: 'completed', progress: 100 },
      { id: '1-3', title: '练习一', order: 3, knowledgePointCount: 2, status: 'completed', progress: 100 },
    ],
  },
  {
    id: 'ch2',
    title: '万以内的加法和减法（一）',
    order: 2,
    importance: 'large',
    status: 'completed',
    progress: 100,
    sections: [
      { id: '2-1', title: '两位数加两位数', order: 1, knowledgePointCount: 4, status: 'completed', progress: 100 },
      { id: '2-2', title: '两位数减两位数', order: 2, knowledgePointCount: 4, status: 'completed', progress: 100 },
      { id: '2-3', title: '几百几十加减', order: 3, knowledgePointCount: 3, status: 'completed', progress: 100 },
      { id: '2-4', title: '估算', order: 4, knowledgePointCount: 2, status: 'completed', progress: 100 },
    ],
  },
  {
    id: 'ch3',
    title: '测量',
    order: 3,
    importance: 'large',
    status: 'current',
    progress: 40,
    sections: [
      { id: '3-1', title: '毫米、分米的认识', order: 1, knowledgePointCount: 5, status: 'completed', progress: 100 },
      { id: '3-2', title: '千米的认识', order: 2, knowledgePointCount: 4, status: 'completed', progress: 100 },
      { id: '3-3', title: '吨的认识', order: 3, knowledgePointCount: 3, status: 'current', progress: 30 },
      { id: '3-4', title: '练习三', order: 4, knowledgePointCount: 2, status: 'locked', progress: 0 },
    ],
  },
  {
    id: 'ch4',
    title: '万以内的加法和减法（二）',
    order: 4,
    importance: 'large',
    status: 'locked',
    progress: 0,
    sections: [
      { id: '4-1', title: '加法', order: 1, knowledgePointCount: 5, status: 'locked', progress: 0 },
      { id: '4-2', title: '减法', order: 2, knowledgePointCount: 5, status: 'locked', progress: 0 },
      { id: '4-3', title: '加减法的验算', order: 3, knowledgePointCount: 3, status: 'locked', progress: 0 },
    ],
  },
  {
    id: 'ch5',
    title: '倍的认识',
    order: 5,
    importance: 'medium',
    status: 'locked',
    progress: 0,
    sections: [
      { id: '5-1', title: '倍的认识', order: 1, knowledgePointCount: 3, status: 'locked', progress: 0 },
      { id: '5-2', title: '解决问题', order: 2, knowledgePointCount: 4, status: 'locked', progress: 0 },
    ],
  },
  {
    id: 'ch6',
    title: '多位数乘一位数',
    order: 6,
    importance: 'large',
    status: 'locked',
    progress: 0,
    sections: [
      { id: '6-1', title: '口算乘法', order: 1, knowledgePointCount: 3, status: 'locked', progress: 0 },
      { id: '6-2', title: '笔算乘法', order: 2, knowledgePointCount: 5, status: 'locked', progress: 0 },
      { id: '6-3', title: '解决问题', order: 3, knowledgePointCount: 4, status: 'locked', progress: 0 },
    ],
  },
  {
    id: 'ch7',
    title: '长方形和正方形',
    order: 7,
    importance: 'medium',
    status: 'locked',
    progress: 0,
    sections: [
      { id: '7-1', title: '四边形', order: 1, knowledgePointCount: 3, status: 'locked', progress: 0 },
      { id: '7-2', title: '周长', order: 2, knowledgePointCount: 4, status: 'locked', progress: 0 },
    ],
  },
  {
    id: 'ch8',
    title: '分数的初步认识',
    order: 8,
    importance: 'small',
    status: 'locked',
    progress: 0,
    sections: [
      { id: '8-1', title: '分数的初步认识', order: 1, knowledgePointCount: 3, status: 'locked', progress: 0 },
      { id: '8-2', title: '分数的简单计算', order: 2, knowledgePointCount: 3, status: 'locked', progress: 0 },
    ],
  },
];

export default function StarMapPage() {
  const [chapters] = useState<Chapter[]>(mockChapters);
  const [selectedChapterId, setSelectedChapterId] = useState<string>(
    mockChapters.find((c) => c.status === 'current')?.id || mockChapters[0].id,
  );

  const selectedChapter = chapters.find((c) => c.id === selectedChapterId);
  const completedCount = chapters.filter((c) => c.status === 'completed').length;

  const handleSectionClick = (section: Section) => {
    // 占位：进入小节学习
    console.log('进入小节', section.id);
  };

  return (
    <div className="student-theme-container min-h-full p-8">
      <div className="max-w-7xl mx-auto">
        {/* 顶部：学期信息 + 进度 */}
        <div className="mb-8">
          <div className="flex items-end justify-between mb-4">
            <div>
              <h1
                className="font-bold text-[var(--text-primary)] mb-1"
                style={{ fontSize: 'var(--fs-h1)' }}
              >
                三年级数学（上册）
              </h1>
              <p className="text-[var(--text-secondary)]" style={{ fontSize: 'var(--fs-body)' }}>
                人教版 · 共 {chapters.length} 章 · 已完成 {completedCount} 章
              </p>
            </div>
            <div className="flex items-center gap-3 text-sm text-[var(--text-tertiary)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)]" /> 已完成
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-[var(--brand-500)]" /> 当前
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-[var(--text-tertiary)]" /> 未解锁
              </span>
            </div>
          </div>
          <Progress
            value={completedCount}
            max={chapters.length}
            variant="linear"
            showPercent
            label="学期进度"
          />
        </div>

        {/* 章节星链图 */}
        <div className="bg-[var(--bg-card)] rounded-[var(--radius-card)] shadow-[var(--shadow-card)] p-8 mb-8">
          <div className="text-sm font-semibold text-[var(--text-secondary)] mb-6">
            章节星链
          </div>
          <div className="overflow-x-auto pb-4">
            <div className="relative min-w-[1000px]">
              {/* 星轨连接线 */}
              <svg
                className="absolute top-1/2 left-0 w-full h-2 -translate-y-1/2 pointer-events-none"
                viewBox="0 0 1000 8"
                preserveAspectRatio="none"
              >
                <line
                  x1="50" y1="4" x2="950" y2="4"
                  stroke="var(--bg-subtle)"
                  strokeWidth="2"
                  strokeDasharray="6 6"
                  strokeLinecap="round"
                />
              </svg>
              {/* 章节星球 */}
              <div className="relative flex items-center justify-between gap-4 px-4">
                {chapters.map((chapter) => (
                  <div
                    key={chapter.id}
                    className="flex-1 flex justify-center"
                    style={{ minWidth: chapter.importance === 'large' ? 140 : chapter.importance === 'medium' ? 110 : 80 }}
                  >
                    <PlanetNode
                      size={chapter.importance}
                      status={chapter.status}
                      label={`第${chapter.order}章`}
                      sublabel={chapter.title}
                      selected={chapter.id === selectedChapterId}
                      onClick={() => setSelectedChapterId(chapter.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 选中章节的小节列表 */}
        <AnimatePresence mode="wait">
          {selectedChapter && (
            <motion.div
              key={selectedChapter.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="bg-[var(--bg-card)] rounded-[var(--radius-card)] shadow-[var(--shadow-card)] p-8"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <div className="text-xs text-[var(--text-tertiary)] mb-1">
                    第 {selectedChapter.order} 章
                  </div>
                  <h2
                    className="font-bold text-[var(--text-primary)]"
                    style={{ fontSize: 'var(--fs-h2)' }}
                  >
                    {selectedChapter.title}
                  </h2>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-[var(--text-tertiary)]">
                    {selectedChapter.sections.length} 个小节
                  </span>
                  <Progress
                    value={selectedChapter.progress}
                    variant="ring"
                    size={56}
                    showPercent
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {selectedChapter.sections.map((section) => (
                  <SectionCard
                    key={section.id}
                    section={section}
                    onClick={() => handleSectionClick(section)}
                  />
                ))}
              </div>

              {selectedChapter.status === 'locked' && (
                <div className="mt-6 p-4 bg-[var(--bg-subtle)] rounded-[var(--radius-button)] text-sm text-[var(--text-secondary)] flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>本章节尚未解锁，请先完成前置章节的学习</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
