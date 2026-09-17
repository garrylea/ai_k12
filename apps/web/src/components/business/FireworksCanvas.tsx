import { useEffect, useRef } from 'react';
import { useThemeStore } from '@/store/themeStore';

/**
 * Canvas 2D 烟花：纯代码粒子，无图片素材、无装饰字符。
 *
 * 尺寸与粒子数按 iPad 横屏定的上限（计划 §2.3、风险表）：每波 ≤120 粒子 × 3 波，
 * 约 3 秒后自动结束并回调 `onDone`（父组件可据此切静态光晕）。
 * 颜色一律读 CSS 变量，因此日夜主题与训练轨硬编码日间主题下都对。
 */

/** 动画总时长（约 3 秒后卸载）。 */
const DURATION_MS = 3000;
/** 每波粒子数（≤120，留足余量）。 */
const PARTICLES_PER_WAVE = 90;
/** 三波烟花的起始时刻。 */
const WAVE_OFFSETS_MS = [0, 1000, 2000];
/** 取色用的 CSS 变量名（仓内已确认存在）。 */
const COLOR_VARS = ['--brand-500', '--brand-400', '--brand-600', '--success', '--warning', '--info'];
/** 取不到任何变量时的兜底色（brand-500）。 */
const FALLBACK_COLOR = '#ff6b35';
/** 重力（px/s²）。 */
const GRAVITY = 220;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 已存活毫秒 */
  age: number;
  /** 总寿命毫秒 */
  life: number;
  color: string;
  size: number;
}

interface FireworksCanvasProps {
  /** false 时不渲染 canvas、不跑 RAF */
  active: boolean;
  /** 动画结束（约 3s）后回调 */
  onDone?: () => void;
}

/** 系统级降级：`typeof` 双保险，jsdom 与部分老旧 WebView 没有 matchMedia。 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 读 CSS 变量取色；`getPropertyValue` 会带前导空格，必须 trim。 */
function readColors(el: Element): string[] {
  const styles = getComputedStyle(el);
  const colors = COLOR_VARS.map((name) => styles.getPropertyValue(name).trim()).filter(Boolean);
  return colors.length > 0 ? colors : [FALLBACK_COLOR];
}

export function FireworksCanvas({ active, onDone }: FireworksCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionEnabled = useThemeStore((s) => s.motionEnabled);
  // 用 ref 持有回调：父组件每次渲染换新闭包时不重启动画
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const animate = active && motionEnabled && !prefersReducedMotion();

  useEffect(() => {
    if (!active) return;
    // 系统级 / 用户级关动效：不跑 RAF，直接告诉父组件「动画已结束」→ 父组件改静态光晕
    if (!motionEnabled || prefersReducedMotion()) {
      onDoneRef.current?.();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // 无 canvas 实现（老 WebView / jsdom）：同样静默降级，不能让庆祝卡住
      onDoneRef.current?.();
      return;
    }

    const width = canvas.clientWidth || window.innerWidth || 800;
    const height = canvas.clientHeight || window.innerHeight || 600;
    canvas.width = width;
    canvas.height = height;

    const colors = readColors(canvas);
    const particles: Particle[] = [];
    let start: number | null = null;
    let last = 0;
    let nextWave = 0;
    let rafId = 0;
    let finished = false;

    const spawnWave = () => {
      const cx = width * (0.2 + Math.random() * 0.6);
      const cy = height * (0.15 + Math.random() * 0.35);
      for (let i = 0; i < PARTICLES_PER_WAVE; i += 1) {
        const angle = (Math.PI * 2 * i) / PARTICLES_PER_WAVE + Math.random() * 0.15;
        const speed = 60 + Math.random() * 150;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          age: 0,
          life: 600 + Math.random() * 700,
          color: colors[i % colors.length],
          size: 1.2 + Math.random() * 1.6,
        });
      }
    };

    const frame = (now: number) => {
      if (finished) return;
      if (start === null) start = now;
      const elapsed = now - start;
      const dt = Math.min(48, now - last);
      last = now;

      while (nextWave < WAVE_OFFSETS_MS.length && elapsed >= WAVE_OFFSETS_MS[nextWave]) {
        spawnWave();
        nextWave += 1;
      }

      ctx.clearRect(0, 0, width, height);
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.life) {
          particles.splice(i, 1);
          continue;
        }
        const t = dt / 1000;
        p.vy += GRAVITY * t;
        p.x += p.vx * t;
        p.y += p.vy * t;
        ctx.globalAlpha = 1 - p.age / p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (elapsed >= DURATION_MS) {
        finished = true;
        ctx.clearRect(0, 0, width, height);
        onDoneRef.current?.();
        return;
      }
      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      finished = true;
      cancelAnimationFrame(rafId);
    };
  }, [active, motionEnabled]);

  if (!animate) return null;

  return (
    <canvas
      ref={canvasRef}
      data-testid="fireworks-canvas"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
