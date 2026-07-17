# Hydration 安全的任务历史加载设计

## 背景

`AuditConsole` 当前使用 `useState(readStoredTasks)` 初始化任务列表。服务端没有
`window`，因此首屏得到空列表；浏览器 hydration 时读取 `localStorage`，如果存在
历史任务，客户端首屏会立即得到非空列表，造成服务端和客户端 HTML 不一致。

## 设计

- `tasks` 的服务端和客户端首次状态都固定为空数组，保证 hydration 输入一致。
- 组件挂载后在 `useEffect` 中调用 `readStoredTasks()`，再恢复浏览器本地历史任务。
- 保留现有存储键、数据校验、任务排序和刷新行为，不改变审计业务流程。
- 不关闭 SSR，也不使用 `suppressHydrationWarning` 掩盖不一致。

## 数据流

1. 服务端渲染空任务列表，任务概览显示 `0`。
2. 浏览器用同样的空列表完成 hydration。
3. 挂载 effect 读取 `localStorage` 并更新状态。
4. 若存在历史任务，页面在 hydration 后正常显示并可继续回看。

## 测试与验收

- 回归测试要求状态初始化不能直接读取 `localStorage`，而应在挂载 effect 中恢复。
- 现有单元测试、类型检查、Lint 和生产构建必须通过。
- 本地页面在预置一条历史任务的情况下不再出现 hydration mismatch，并仍显示该任务。
