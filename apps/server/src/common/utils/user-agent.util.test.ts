import { describe, it, expect, beforeEach } from 'vitest';
import { parseUserAgent, clearUserAgentCache } from './user-agent.util.js';

// 真实 UA 片段（截取足以区分平台/浏览器的部分）
const UA = {
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  electron:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) k12-desktop/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36',
} as const;

beforeEach(() => clearUserAgentCache());

describe('parseUserAgent', () => {
  it.each([
    ['iPad Safari（UA 写的是 Macintosh——单看 UA 会误判，校正由 service 做）', UA.ipadSafari, 'mac', 'safari'],
    ['Mac Chrome', UA.macChrome, 'mac', 'chrome'],
    ['iPhone Safari', UA.iphoneSafari, 'iphone', 'safari'],
    ['Android 平板（UA 无 Mobile）', UA.androidTablet, 'android_tablet', 'chrome'],
    ['Android 手机（UA 有 Mobile）', UA.androidPhone, 'android_phone', 'chrome'],
    ['Windows Edge', UA.windowsEdge, 'windows', 'edge'],
    ['Windows Firefox', UA.windowsFirefox, 'windows', 'firefox'],
    ['Linux Chrome', UA.linuxChrome, 'linux', 'chrome'],
    ['Electron 壳（浏览器判定优先于 Chrome）', UA.electron, 'mac', 'electron'],
  ])('%s', (_label, ua, platformClass, browser) => {
    expect(parseUserAgent(ua)).toEqual({ platformClass, browser });
  });

  it('空 / 缺失 UA → 两个 null（不编造 other）', () => {
    expect(parseUserAgent(null)).toEqual({ platformClass: null, browser: null });
    expect(parseUserAgent(undefined)).toEqual({ platformClass: null, browser: null });
    expect(parseUserAgent('')).toEqual({ platformClass: null, browser: null });
  });

  it('无法识别的 UA → other/other', () => {
    expect(parseUserAgent('SomeRandomBot/1.0')).toEqual({
      platformClass: 'other',
      browser: 'other',
    });
  });

  it('同一 UA 字符串走 memoize：返回同一个对象引用', () => {
    const first = parseUserAgent(UA.macChrome);
    const second = parseUserAgent(UA.macChrome);
    expect(second).toBe(first); // 引用相等 = 没有重新解析
  });
});
