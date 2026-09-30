/**
 * @dsh-external/dsh-mindmap-live — client 画布（conversation.view 视图页签）。
 * 构建：npm run build:client（tsdown → lib/client.js，closure-factory 产物）。
 * 注册形态对齐官方 ui-trajectory：ctx.slots.inject(slot, () => ctx.slots.register(options, Component))。
 */
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { MindmapCanvas } from './MindmapCanvas.tsx'
import { createAskAI } from './ask-ai.ts'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  // host/client 同 tsconfig 编译：cordis Context.sessions 的静态类型被 host 侧
  // core/session 的合并（SessionStore）占据；运行时 client ctx 上挂的实为 ISessions
  // （dsh-client-runtime 的 SessionRuntime），故在边界处做一次类型还原。
  const askAI = createAskAI((ctx as unknown as { sessions: ISessions }).sessions)
  // S1 调试把手：S2 接入 UI 前可在 devtools 手动验证通道；S2 落地后移除
  ;(globalThis as Record<string, unknown>).__mindmapAskAI = askAI
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mindmap-live',
    order: 30,
    label: () => '思维导图',
  }, MindmapCanvas))
}
