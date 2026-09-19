/**
 * User-Agent 粗分类（**只到类别**，不存原始 UA 字符串、不做设备指纹）。
 *
 * 为什么不引 `ua-parser` / `bowser`：我们只需要约 8 个平台档 + 6 个浏览器档、
 * 不要版本号，自研粗正则足够，且省一个依赖（spec §4.2）。
 *
 * 为什么 memoize：本函数在每个采集请求上调用（心跳 30s 一次），而学生群体里
 * UA 字符串的分布极窄（同一台设备反复请求）。按**原始 UA 字符串**缓存解析结果，
 * 命中即返回同一个对象——调用方**不得**修改返回值。
 *
 * ⚠️ iPadOS 13+ 的 Safari UA 写的是 `Macintosh`（苹果的 desktop-class browsing 策略），
 * 单看这里**必然**把 iPad 判成 mac。产品的主断点是 iPad 横屏，误判会让设备报表失去意义。
 * 校正放在 `StudySessionsService`（那里同时有前端上报的 `input_type`）：
 * `platform_class === 'mac' && input_type === 'touch' → 'ipad'`。
 */

export type PlatformClass =
  | 'ipad'
  | 'iphone'
  | 'android_tablet'
  | 'android_phone'
  | 'mac'
  | 'windows'
  | 'linux'
  | 'other';

export type BrowserClass = 'chrome' | 'safari' | 'edge' | 'firefox' | 'electron' | 'other';

export interface UserAgentInfo {
  platformClass: PlatformClass | null;
  browser: BrowserClass | null;
}

/** 缓存上限：UA 种类很少，超过就整体清空（比 LRU 简单，且不会无限增长）。 */
const CACHE_MAX = 500;
const cache = new Map<string, UserAgentInfo>();

/** 测试用：清空 memoize 缓存，保证用例互不影响。 */
export function clearUserAgentCache(): void {
  cache.clear();
}

function detectPlatform(ua: string): PlatformClass {
  // 顺序敏感：这些模式互相重叠，靠「先命中先返回」区分。
  // · `/iPad/` 必须排在 `/Macintosh|Mac OS X/` 之前——iPadOS 13+ 的 Safari UA 带 `Macintosh`。
  // · `/iPhone|iPod/` 同样必须排在 `/Macintosh|Mac OS X/` 之前——iPhone UA 含 `like Mac OS X`。
  // 任何一条落到 mac 那条之后，iPhone / iPad 都会被误判成 mac。
  if (/iPad/i.test(ua)) return 'ipad';
  if (/iPhone|iPod/i.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'android_phone' : 'android_tablet';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function detectBrowser(ua: string): BrowserClass {
  // Electron 必须排在 Chrome 之前——Electron 的 UA 里同时含 `Chrome/`。
  if (/Electron/i.test(ua)) return 'electron';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\/|CriOS/i.test(ua)) return 'chrome';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'firefox';
  if (/Safari\//i.test(ua) && !/Chromium/i.test(ua)) return 'safari';
  return 'other';
}

export function parseUserAgent(ua: string | null | undefined): UserAgentInfo {
  if (!ua) return { platformClass: null, browser: null };

  const hit = cache.get(ua);
  if (hit) return hit;

  const info: UserAgentInfo = {
    platformClass: detectPlatform(ua),
    browser: detectBrowser(ua),
  };

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ua, info);
  return info;
}
