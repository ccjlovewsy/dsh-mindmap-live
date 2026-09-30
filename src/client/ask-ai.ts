/**
 * ask-ai — 画布 → 当前会话的发消息通道（P0-S1 接线，spike 结论落地，见
 * .agentdoc/260929-画布提问直达会话回答-需求拆解.md §7.1）。
 * 通道：sessions.binding(sessionId)?.session.prompt(...)，与聊天输入框同一条
 * （ui-conversation ConversationController.send 即此路径）；mode 固定 'queue'
 * （追加一轮；'steer' 是打断当前轮，提问场景不用）。
 *
 * 注意：本插件 host/client 共用一个 tsconfig，cordis `Context.sessions` 被 host 侧
 * core/session 的合并（SessionStore）占据，client 侧运行时合并（ISessions）在类型上
 * 不可见——因此这里只依赖 ISessions 窄类型，由入口在边界处做一次转换（见
 * client/index.ts 的注释）。
 */
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

export interface AskAIResult {
  ok: boolean
  error?: string
}

export type AskAI = (sessionId: SessionId, text: string) => Promise<AskAIResult>

/** 绑定 sessions 服务生成发消息函数；会话不存在或宿主拒绝时返回 ok:false（不抛，交调用方走失败路径）。 */
export function createAskAI(sessions: ISessions): AskAI {
  return async (sessionId, text) => {
    const session = sessions.binding(sessionId)?.session
    if (!session) return { ok: false, error: '会话不存在或已关闭' }
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) return { ok: false, error: result.error.code + ': ' + result.error.message }
    return { ok: true }
  }
}
