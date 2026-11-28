import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { probeStudentSession } from '@/services/api';

/**
 * `/student`、`/student/mainline` 两条旧地址的落点（2026-09-20 删除 `StudentLayout` 后保留的兼容重定向）。
 *
 * **落点为什么是学科选择页、不是星图**：星图的数据全部按学科取（`?subjectId=`），这个 id 由学科选择页
 * 写进 `location.state`；旧地址进来没有 state，落到星图只会得到一句「缺少学生或学科信息」。学科选择页
 * 不需要任何入参，登录态有效时永远能用。
 *
 * **为什么还要先探一次会话**：外层 `RequireRole` 只解码**本地 JWT 的 exp**，看不到服务端会话。后端重启后
 * 注册表重建失败、账号被踢、token 被吊销时，本地 token 仍然「没过期」，守卫照样放行；而学科选择页拉的是
 * **公开**接口（`/content/subjects`），不会返回 1003 —— 会话早就没了也不会有人发现。所以这里先拿一个
 * **学生本人维度**的受保护接口（`/points/me`：只读、新学生也返回全 0、不依赖任何入参）探一次：
 * - 会话已在服务端失效 → api 层清登录态并整页跳 `/login?reason=expired`（1003）或
 *   `/login?kicked=1`（1013）。那条分支返回永不 resolve 的 Promise，这里永远不会放行；
 * - 探测成功 → 放行到学科选择页；
 * - 其它失败（网络抖动 / 5xx）→ 不当作登录过期，照常放行，交给目标页自己的错误态。
 */
export default function StudentIndexRedirect() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    probeStudentSession().then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  if (!ready) return null;
  return <Navigate to="/student/subjects" replace />;
}
