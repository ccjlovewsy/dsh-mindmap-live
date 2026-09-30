/**
 * @dsh-external/dsh-mindmap-live — host 侧：共享思维导图状态 + Agent 工具 + HTTP/SSE 通道。
 *
 * 双向同步模型（同一棵树、同一份 version）：
 *   - Agent 侧走 mindmap_get / mindmap_edit 工具；
 *   - 用户侧在画布上操作，走 POST /api/op；
 *   - 任一侧成功变更 ⇒ version++ ⇒ SSE 即时广播（客户端另有 2.5s 轮询兜底）；
 *   - 树持久化在 ~/.dsh/mindmap-live/tree.json，重启不丢。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from 'schemastery'

export const name = '@dsh-external/dsh-mindmap-live'
export const inject = ['tools', 'webServer']

export interface Config {
  /** 树持久化路径；缺省 ~/.dsh/mindmap-live/tree.json */
  persistPath: string
}

export const Config = z.object({
  persistPath: z.string().default(''),
})

const SHORT = 'dsh-mindmap-live'
const ROUTE = '/@dsh-external/dsh-mindmap-live/api'
const MAX_NODES = 2000
const MAX_DEPTH = 32
const MAX_BODY = 1 << 20

interface MMNode {
  id: string
  title: string
  collapsed?: boolean
  children: MMNode[]
}

interface MMState {
  version: number
  updatedAt: number
  root: MMNode
}

interface OpResult {
  i: number
  ok: boolean
  id?: string
  error?: string
}

interface MmOp {
  op: string
  id?: unknown
  parentId?: unknown
  title?: unknown
  index?: unknown
  collapsed?: unknown
  root?: unknown
}

let idSeq = 0
const newId = (): string => 'n' + Date.now().toString(36) + '-' + (idSeq++).toString(36)

export function apply(ctx: Context & {
  tools: { register(tool: unknown): unknown }
  webServer: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
}, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const persistPath = config.persistPath || join(dshHome, SHORT, 'tree.json')
  const log = ctx.logger?.info?.bind(ctx.logger) ?? (() => {})

  // ── 状态与持久化 ─────────────────────────────────────────────
  const seed = (): MMState => ({
    version: 1,
    updatedAt: Date.now(),
    root: {
      id: newId(),
      title: '中心主题',
      children: [
        { id: newId(), title: '主题 A', children: [] },
        { id: newId(), title: '主题 B', children: [] },
        { id: newId(), title: '主题 C', children: [] },
      ],
    },
  })

  let state: MMState = seed()
  try {
    if (existsSync(persistPath)) {
      const loaded = JSON.parse(readFileSync(persistPath, 'utf8')) as MMState
      if (loaded && typeof loaded.version === 'number' && loaded.root?.id) state = loaded
    }
  } catch (e) {
    log(`[${SHORT}] 持久化文件损坏，使用种子树：` + String(e).slice(0, 80))
  }

  const persist = (): void => {
    try {
      mkdirSync(dirname(persistPath), { recursive: true })
      writeFileSync(persistPath, JSON.stringify(state))
    } catch (e) {
      log(`[${SHORT}] 持久化失败：` + String(e).slice(0, 80))
    }
  }

  // ── 树操作原语 ───────────────────────────────────────────────
  const findById = (n: MMNode, id: string): MMNode | null => {
    if (n.id === id) return n
    for (const c of n.children) {
      const hit = findById(c, id)
      if (hit) return hit
    }
    return null
  }

  const findParent = (n: MMNode, id: string): { parent: MMNode; index: number } | null => {
    for (let i = 0; i < n.children.length; i++) {
      if (n.children[i].id === id) return { parent: n, index: i }
      const hit = findParent(n.children[i], id)
      if (hit) return hit
    }
    return null
  }

  const containsId = (n: MMNode, id: string): boolean => findById(n, id) !== null

  const countNodes = (n: MMNode): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0)

  const sanitizeTree = (raw: unknown, depth: number, counter: { n: number }): MMNode | null => {
    if (depth > MAX_DEPTH || counter.n >= MAX_NODES) return null
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string') return null
    counter.n += 1
    const node: MMNode = {
      id: typeof r.id === 'string' && r.id ? r.id : newId(),
      title: r.title,
      children: [],
    }
    if (r.collapsed === true) node.collapsed = true
    if (Array.isArray(r.children)) {
      for (const c of r.children) {
        const child = sanitizeTree(c, depth + 1, counter)
        if (!child) return null
        node.children.push(child)
      }
    }
    return node
  }

  /** 依序应用一批操作；单个失败不影响后续。返回逐条结果与是否发生变更。 */
  const applyOps = (ops: MmOp[]): { results: OpResult[]; changed: boolean } => {
    const results: OpResult[] = []
    let changed = false
    ops.forEach((raw, i) => {
      const fail = (error: string): void => { results.push({ i, ok: false, error }) }
      try {
        if (typeof raw !== 'object' || raw === null || typeof raw.op !== 'string') return fail('op 缺失')
        const op = raw.op
        const asIndex = (v: unknown, fallback: number): number =>
          typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback

        if (op === 'setTitle' || op === 'renameNode') {
          const title = typeof raw.title === 'string' ? raw.title.trim() : ''
          if (!title) return fail('title 必填')
          if (op === 'setTitle') { state.root.title = title } else {
            if (typeof raw.id !== 'string') return fail('id 必填')
            const node = findById(state.root, raw.id)
            if (!node) return fail('id 不存在：' + raw.id)
            node.title = title
          }
        } else if (op === 'addNode') {
          const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '新节点'
          const parentId = typeof raw.parentId === 'string' ? raw.parentId : state.root.id
          const parent = findById(state.root, parentId)
          if (!parent) return fail('parentId 不存在：' + parentId)
          if (countNodes(state.root) >= MAX_NODES) return fail('节点数达到上限 ' + MAX_NODES)
          const node: MMNode = { id: newId(), title, children: [] }
          const idx = asIndex(raw.index, parent.children.length)
          parent.children.splice(Math.min(idx, parent.children.length), 0, node)
          results.push({ i, ok: true, id: node.id })
          changed = true
          return
        } else if (op === 'deleteNode') {
          if (typeof raw.id !== 'string') return fail('id 必填')
          if (raw.id === state.root.id) return fail('不能删除根节点')
          const hit = findParent(state.root, raw.id)
          if (!hit) return fail('id 不存在：' + raw.id)
          hit.parent.children.splice(hit.index, 1)
        } else if (op === 'moveNode') {
          if (typeof raw.id !== 'string') return fail('id 必填')
          if (raw.id === state.root.id) return fail('不能移动根节点')
          const parentId = typeof raw.parentId === 'string' ? raw.parentId : state.root.id
          const node = findById(state.root, raw.id)
          const parent = findById(state.root, parentId)
          if (!node) return fail('id 不存在：' + raw.id)
          if (!parent) return fail('parentId 不存在：' + parentId)
          if (containsId(node, parentId)) return fail('不能移动到自己的子孙下')
          const hit = findParent(state.root, raw.id)
          if (hit) hit.parent.children.splice(hit.index, 1)
          const idx = asIndex(raw.index, parent.children.length)
          parent.children.splice(Math.min(idx, parent.children.length), 0, node)
        } else if (op === 'setCollapsed') {
          if (typeof raw.id !== 'string') return fail('id 必填')
          const node = findById(state.root, raw.id)
          if (!node) return fail('id 不存在：' + raw.id)
          if (raw.collapsed === true) node.collapsed = true
          else delete node.collapsed
        } else if (op === 'replaceTree') {
          const counter = { n: 0 }
          const root = sanitizeTree(raw.root, 0, counter)
          if (!root) return fail('root 结构非法（需 {title, children[]}，深度≤' + MAX_DEPTH + '，节点≤' + MAX_NODES + '）')
          state.root = root
        } else {
          return fail('未知 op：' + op)
        }
        results.push({ i, ok: true })
        changed = true
      } catch (e) {
        fail(String(e).slice(0, 120))
      }
    })
    return { results, changed }
  }

  const commit = (): void => {
    state.version += 1
    state.updatedAt = Date.now()
    persist()
    broadcast()
  }

  // ── SSE 即时广播 ─────────────────────────────────────────────
  const sseClients = new Set<ServerResponse>()

  const broadcast = (): void => {
    const frame = 'data: ' + JSON.stringify({ version: state.version }) + '\n\n'
    for (const res of sseClients) {
      try { res.write(frame) } catch { sseClients.delete(res) }
    }
  }

  // ── HTTP 通道 ────────────────────────────────────────────────
  const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new Error('body 过大')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '').split('?')[0]
    const sub = url.startsWith(ROUTE) ? url.slice(ROUTE.length) : url

    if (sub === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('data: ' + JSON.stringify({ version: state.version }) + '\n\n')
      sseClients.add(res)
      const hb = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* 忽略 */ }
      }, 25000)
      req.on('close', () => { clearInterval(hb); sseClients.delete(res) })
      return
    }

    if (sub === '/state' || sub === '' || sub === '/') {
      return sendJson(res, 200, state)
    }

    if (sub === '/op' && req.method === 'POST') {
      let body: unknown
      try { body = JSON.parse(await readBody(req)) } catch { return sendJson(res, 400, { ok: false, error: 'JSON 非法' }) }
      const b = (typeof body === 'object' && body !== null ? body : {}) as { ops?: unknown; op?: unknown }
      const ops: MmOp[] = Array.isArray(b.ops) ? b.ops as MmOp[] : [b as MmOp]
      const { results, changed } = applyOps(ops)
      if (changed) commit()
      return sendJson(res, 200, { ok: results.every(r => r.ok), version: state.version, results, root: state.root })
    }

    return sendJson(res, 404, { ok: false, error: '未知子路径：' + sub })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => { void handle(req, res) },
  }), SHORT + ': api')

  // ── Agent 工具 ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mindmap_get',
    description: 'Read the live mindmap canvas that is shared with the user in real time. '
      + 'Returns the full tree (id/title/children per node, collapsed flags) and its version. '
      + 'Cheap and local — call it whenever you need current node ids before editing, '
      + 'or to verify what the user has drawn so far.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer', description: 'Monotonic canvas version.' },
          nodeCount: { type: 'integer', description: 'Total node count including the root.' },
          root: { type: 'object', additionalProperties: true, description: 'Full tree: {id,title,collapsed?,children[]}' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({
      version: state.version,
      nodeCount: countNodes(state.root),
      // JSON 往返：既满足 output schema 的 Record<string, JsonValue> 收窄，又天然防御外部写入的非法结构
      root: JSON.parse(JSON.stringify(state.root)) as Record<string, never>,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'mindmap_edit',
    description: 'Apply edits to the live mindmap the user is watching — every change appears on '
      + 'their canvas instantly (dockable sidebar or fullscreen). Send a BATCH of ops per call. '
      + 'Ops: setTitle{title} | addNode{parentId?,title,index?}→returns new id | '
      + 'renameNode{id,title} | deleteNode{id} (root forbidden) | '
      + 'moveNode{id,parentId,index?} | setCollapsed{id,collapsed} | '
      + 'replaceTree{root:{title,children[]}} (bulk rebuild, drops ids not provided). '
      + 'Node ids come from mindmap_get or from earlier addNode results. '
      + 'Co-editing etiquette: the user edits the same tree concurrently — re-read with '
      + 'mindmap_get if your mental model may be stale instead of blindly re-appling.',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: 'Ordered operations; each fails independently without aborting the batch.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: ['setTitle', 'addNode', 'renameNode', 'deleteNode', 'moveNode', 'setCollapsed', 'replaceTree'], description: 'Operation kind.' },
            id: { type: 'string', description: 'Target node id (renameNode/deleteNode/moveNode/setCollapsed).' },
            parentId: { type: 'string', description: 'Parent id (addNode; defaults to root — moveNode target parent).' },
            title: { type: 'string', description: 'Node title (setTitle/addNode/renameNode).' },
            index: { type: 'integer', description: 'Insert position among siblings (0-based; default = end).' },
            collapsed: { type: 'boolean', description: 'Collapse state (setCollapsed).' },
            root: { type: 'object', additionalProperties: true, description: 'Whole tree for replaceTree: {title, children:[...]}.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'True when every op applied.' },
          version: { type: 'integer', description: 'Canvas version after the batch.' },
          applied: { type: 'integer', description: 'Number of ops applied.' },
          results: {
            type: 'array',
            description: 'Per-op outcome in input order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                i: { type: 'integer', description: 'Op index in the batch.' },
                ok: { type: 'boolean', description: 'Whether this op applied.' },
                id: { type: 'string', description: 'Created node id (addNode only).' },
                error: { type: 'string', description: 'Per-op failure reason.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const { ops } = (args ?? {}) as { ops?: MmOp[] }
      const list = Array.isArray(ops) ? ops : []
      const { results, changed } = applyOps(list)
      if (changed) commit()
      return {
        ok: results.every(r => r.ok),
        version: state.version,
        applied: results.filter(r => r.ok).length,
        results,
      }
    },
  }))

  log(`[${SHORT}] 就绪：route=${ROUTE} persist=${persistPath} version=${state.version}`)
}
