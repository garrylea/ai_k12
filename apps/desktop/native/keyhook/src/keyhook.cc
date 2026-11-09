// Windows 全局低级键盘钩子（WH_KEYBOARD_LL）—— 只在学生模式下启用。
//
// 为什么自己写：能"监听"的 npm 包（uiohook 之类）吞不掉按键；能吞键的只有低级钩子。
// 钩子必须装在**有消息循环的线程**上（Node 主线程不 pump Win32 消息），所以这里起一条专用线程。
//
// ⚠️ 回调里只做 O(1) 判定：禁止分配、禁止写日志、禁止回调 JS —— 每个按键都会进这里。
// ⚠️ Win 键的按下**和抬起**都要吞：只吞按下的话，抬起时开始菜单仍会弹出来。
// ⚠️ Ctrl+Alt+Del 是 Secure Attention Sequence，任何用户态程序都拦不了（已知边界）。

#include <node.h>  // node::AddEnvironmentCleanupHook + v8::Isolate
#include <napi.h>
#include <windows.h>

namespace {

HHOOK g_hook = nullptr;
HANDLE g_thread = nullptr;
DWORD g_thread_id = 0;
HANDLE g_ready = nullptr;
DWORD g_last_error = 0;

constexpr UINT kStopMessage = WM_APP + 0x4B31;

bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

bool ShouldBlock(DWORD vk, bool alt_from_hook) {
  const bool alt = alt_from_hook || IsDown(VK_MENU);
  const bool ctrl = IsDown(VK_CONTROL);

  switch (vk) {
    case VK_LWIN:
    case VK_RWIN:
      return true;
    case VK_TAB:
      // Alt+Tab / Alt+Shift+Tab / Ctrl+Alt+Tab；**Ctrl+Tab 与 Tab 放行**（应用内快捷键）。
      return alt;
    case VK_F4:
      return alt;
    case VK_ESCAPE:
      // Ctrl+Esc（开始菜单）/ Ctrl+Shift+Esc（任务管理器）/ Alt+Esc（窗口切换）。
      return ctrl || alt;
    default:
      return false;
  }
}

LRESULT CALLBACK LowLevelProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION) {
    const DWORD message = static_cast<DWORD>(wParam);
    if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN || message == WM_KEYUP ||
        message == WM_SYSKEYUP) {
      const auto* info = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
      const bool alt = (info->flags & LLKHF_ALTDOWN) != 0;
      if (ShouldBlock(info->vkCode, alt)) return 1;  // 吞掉
    }
  }
  return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

DWORD WINAPI HookThread(LPVOID) {
  g_thread_id = GetCurrentThreadId();
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelProc, GetModuleHandleW(nullptr), 0);
  if (g_hook == nullptr) {
    g_last_error = GetLastError();
    if (g_ready) SetEvent(g_ready);
    return 0;
  }
  if (g_ready) SetEvent(g_ready);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == kStopMessage) break;
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (g_hook != nullptr) {
    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
  }
  return 0;
}

bool Start() {
  if (g_thread != nullptr) return g_hook != nullptr;

  g_last_error = 0;
  g_ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (g_ready == nullptr) {
    g_last_error = GetLastError();
    return false;
  }

  g_thread = CreateThread(nullptr, 0, HookThread, nullptr, 0, nullptr);
  if (g_thread == nullptr) {
    g_last_error = GetLastError();
    CloseHandle(g_ready);
    g_ready = nullptr;
    return false;
  }

  WaitForSingleObject(g_ready, 3000);
  if (g_hook == nullptr) {
    // 线程已经自己退出（SetWindowsHookEx 失败）。
    WaitForSingleObject(g_thread, 1000);
    CloseHandle(g_thread);
    g_thread = nullptr;
    g_thread_id = 0;
    CloseHandle(g_ready);
    g_ready = nullptr;
    return false;
  }
  return true;
}

void Stop() {
  if (g_thread != nullptr) {
    if (g_thread_id != 0) PostThreadMessageW(g_thread_id, kStopMessage, 0, 0);
    WaitForSingleObject(g_thread, 2000);
    CloseHandle(g_thread);
    g_thread = nullptr;
    g_thread_id = 0;
  }
  if (g_ready != nullptr) {
    CloseHandle(g_ready);
    g_ready = nullptr;
  }
  // g_hook 由钩子线程在退出时置空；线程若超时未退，保留它（isActive 仍为 true，不谎报）。
}

Napi::Value StartBinding(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), Start());
}

Napi::Value StopBinding(const Napi::CallbackInfo& info) {
  Stop();
  return info.Env().Undefined();
}

Napi::Value IsActiveBinding(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_hook != nullptr && g_thread != nullptr);
}

Napi::Value LastErrorBinding(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(g_last_error));
}

Napi::Value PingBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", Napi::Boolean::New(env, true));
  out.Set("napi", Napi::Number::New(env, NAPI_VERSION));
  out.Set("active", Napi::Boolean::New(env, g_hook != nullptr));
  out.Set("lastError", Napi::Number::New(env, static_cast<double>(g_last_error)));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, StartBinding));
  exports.Set("stop", Napi::Function::New(env, StopBinding));
  exports.Set("isActive", Napi::Function::New(env, IsActiveBinding));
  exports.Set("lastError", Napi::Function::New(env, LastErrorBinding));
  exports.Set("ping", Napi::Function::New(env, PingBinding));

  // 环境销毁时摘钩，避免模块卸载后钩子回调仍指向已卸载的代码。
  // 进程退出本身也会由系统释放钩子，这一步是兜底。
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (isolate != nullptr) {
    node::AddEnvironmentCleanupHook(isolate, [](void*) { Stop(); }, nullptr);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
