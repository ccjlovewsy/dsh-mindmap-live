/**
 * @dsh-external/dsh-mindmap-live — client 画布（conversation.view 视图页签）。
 * 构建：npm run build:client（tsdown → lib/client.js，closure-factory 产物）。
 * 注册形态对齐官方 ui-trajectory：ctx.slots.inject(slot, () => ctx.slots.register(options, Component))。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MindmapCanvas } from './MindmapCanvas.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mindmap-live',
    order: 30,
    label: () => '思维导图',
  }, MindmapCanvas))
}
