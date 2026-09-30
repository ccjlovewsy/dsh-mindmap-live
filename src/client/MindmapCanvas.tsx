/**
 * MindmapCanvas — 实时双向同步的思维导图画布。
 * 数据面：GET /api/state 全量、POST /api/op 变更、SSE /api/events 即时推 version（2.5s 轮询兜底）。
 * Agent（mindmap_edit 工具）与用户（画布操作）走同一条变更管线，version 单调递增。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

const API = '/@dsh-external/dsh-mindmap-live/api'

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

interface OpResult { i: number; ok: boolean; id?: string; error?: string }

interface Placed {
  n: MMNode
  x: number
  y: number
  parentId: string | null
  depth: number
}

const COL_W = 210
const NODE_W = 176
const NODE_H = 32
const PAD = 28
const ROW_H = 46

function findNode(n: MMNode, id: string): MMNode | null {
  if (n.id === id) return n
  for (const c of n.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

function findParentOf(n: MMNode, id: string): { parent: MMNode; index: number } | null {
  for (let i = 0; i < n.children.length; i++) {
    if (n.children[i].id === id) return { parent: n, index: i }
    const hit = findParentOf(n.children[i], id)
    if (hit) return hit
  }
  return null
}

/** 紧凑树布局：x=深度列，y=叶子行游标；父 y 取首末子均值。返回平铺列表供渲染。 */
function computeLayout(root: MMNode): { items: Placed[]; w: number; h: number } {
  const items: Placed[] = []
  let cursor = 0
  let maxDepth = 0
  const walk = (n: MMNode, depth: number, parentId: string | null): number => {
    maxDepth = Math.max(maxDepth, depth)
    const x = depth * COL_W
    const kids = n.collapsed ? [] : n.children
    let y: number
    if (kids.length === 0) {
      y = cursor * ROW_H
      cursor += 1
    } else {
      const ys = kids.map(k => walk(k, depth + 1, n.id))
      y = (ys[0] + ys[ys.length - 1]) / 2
    }
    items.push({ n, x, y, parentId, depth })
    return y
  }
  walk(root, 0, null)
  const leaves = items.filter(p => p.n.collapsed || p.n.children.length === 0).length
  return {
    items,
    w: maxDepth * COL_W + NODE_W + PAD * 2,
    h: Math.max(leaves * ROW_H, NODE_H) + PAD * 2,
  }
}

let styleInjected = false
function injectStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin', 'dsh-mindmap-live')
  tag.textContent = canvasCss()
  document.head.appendChild(tag)
}

export function MindmapCanvas(_props: ConvViewProps): React.ReactElement {
  const [state, setState] = useState<MMState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [live, setLive] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const versionRef = useRef(-1)
  const stateRef = useRef<MMState | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 是否已自动定位过根节点（进入全屏后重置一次，避免与用户手动滚动打架） */
  const centeredRef = useRef(false)

  const adopt = useCallback((s: MMState): void => {
    if (s.version < versionRef.current) return
    versionRef.current = s.version
    stateRef.current = s
    setState(s)
    setSelected(sel => (sel && !findNode(s.root, sel) ? null : sel))
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(API + '/state', { cache: 'no-store' })
      if (r.ok) adopt(await r.json() as MMState)
    } catch { /* 离线中，轮询会再试 */ }
  }, [adopt])

  useEffect(() => {
    void load()
    const es = new EventSource(API + '/events')
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    es.onmessage = ev => {
      try {
        const v = (JSON.parse(ev.data) as { version?: number }).version
        if (typeof v === 'number' && v !== versionRef.current) void load()
      } catch { /* 忽略坏帧 */ }
    }
    const poll = window.setInterval(() => { void load() }, 2500)
    return () => { es.close(); window.clearInterval(poll) }
  }, [load])

  const ops = useCallback(async (list: Record<string, unknown>[]): Promise<void> => {
    try {
      const r = await fetch(API + '/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: list }),
      })
      if (!r.ok) { setFlash('操作失败（HTTP ' + String(r.status) + '）'); return }
      const s = await r.json() as MMState & { results: OpResult[] }
      adopt(s)
      const bad = s.results.find(x => !x.ok)
      setFlash(bad ? (bad.error ?? '操作被拒绝') : null)
      const created = s.results.find(x => x.ok && typeof x.id === 'string')
      if (created?.id) setSelected(created.id)
    } catch (e) {
      setFlash('网络错误：' + String(e).slice(0, 60))
    }
  }, [adopt])

  const addSibling = useCallback(async (): Promise<void> => {
    const s = stateRef.current
    if (!s) return
    if (!selected) { await ops([{ op: 'addNode', parentId: s.root.id, title: '新节点' }]); return }
    const hit = findParentOf(s.root, selected)
    if (!hit) { await ops([{ op: 'addNode', parentId: s.root.id, title: '新节点' }]); return }
    await ops([{ op: 'addNode', parentId: hit.parent.id, index: hit.index + 1, title: '新节点' }])
  }, [ops, selected])

  const toggleCollapse = useCallback(async (): Promise<void> => {
    const s = stateRef.current
    if (!s || !selected) return
    const n = findNode(s.root, selected)
    if (!n) return
    await ops([{ op: 'setCollapsed', id: selected, collapsed: !n.collapsed }])
  }, [ops, selected])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  /**
   * 把根节点滚到视野中央。
   * 停靠面板可视区只有 340px 高，而树常达上千 px：默认滚动位置 (0,0) 会让根节点
   * 落在可视区下方，打开面板时看起来像"没有导图"。
   */
  const centerOnRoot = useCallback((): void => {
    const host = hostRef.current
    const s = stateRef.current
    if (host === null || s === null) return
    const { items } = computeLayout(s.root)
    const rootRow = items.find(p => p.parentId === null)
    if (rootRow === undefined) return
    host.scrollTop = Math.max(rootRow.y + PAD - host.clientHeight / 2, 0)
    host.scrollLeft = 0
  }, [])

  // 视口高度变了（进出全屏）允许重新定位一次
  useEffect(() => { centeredRef.current = false }, [fullscreen])

  // 首次拿到树后自动定位到根节点；此后不再打断用户的手动滚动
  useEffect(() => {
    if (state === null || centeredRef.current) return
    centerOnRoot()
    centeredRef.current = true
  }, [state, fullscreen, centerOnRoot])

  injectStyle()

  if (state === null) {
    return <div className="mml-root"><div className="mml-loading">思维导图加载中…</div></div>
  }

  const { items, w, h } = computeLayout(state.root)
  const selNode = selected ? findNode(state.root, selected) : null

  const startRename = (id: string): void => setRenaming(id)
  const commitRename = (id: string, value: string): void => {
    setRenaming(null)
    const title = value.trim()
    if (title) void ops([{ op: 'renameNode', id, title }])
  }

  const nodeEls = items.map(p => {
    const isSel = p.n.id === selected
    const hasKids = p.n.children.length > 0
    return (
      <div
        key={p.n.id}
        className={'mml-node' + (isSel ? ' mml-sel' : '')}
        style={{ left: p.x + PAD, top: p.y + PAD - NODE_H / 2, width: NODE_W, height: NODE_H }}
        onClick={e => { e.stopPropagation(); setSelected(p.n.id) }}
        onDoubleClick={() => startRename(p.n.id)}
      >
        <span
          className="mml-chev"
          style={{ visibility: hasKids ? 'visible' : 'hidden' }}
          onClick={e => {
            e.stopPropagation()
            void ops([{ op: 'setCollapsed', id: p.n.id, collapsed: !p.n.collapsed }])
          }}
        >
          {hasKids ? (p.n.collapsed ? '▸' : '▾') : '·'}
        </span>
        {renaming === p.n.id
          ? (
              <input
                className="mml-rename"
                defaultValue={p.n.title}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(p.n.id, (e.target as HTMLInputElement).value)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={e => commitRename(p.n.id, e.currentTarget.value)}
              />
            )
          : <span className="mml-title" title={p.n.title}>{p.n.title}</span>}
      </div>
    )
  })

  const linkEls = items.flatMap(p => {
    if (p.parentId === null) return []
    const parent = items.find(q => q.n.id === p.parentId)
    if (parent === undefined) return []
    const x1 = parent.x + NODE_W
    const y1 = parent.y
    const x2 = p.x
    const y2 = p.y
    const mx = (x1 + x2) / 2
    return [<path key={p.n.id} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} />]
  })

  return (
    <div className={'mml-root' + (fullscreen ? ' mml-full' : '')}>
      <div className="mml-bar">
        <span className={'mml-dot ' + (live ? 'mml-dot-on' : 'mml-dot-off')} title={live ? 'SSE 已连接（即时同步）' : 'SSE 断开，轮询兜底中'} />
        <span className="mml-ver">{'v' + String(state.version)}</span>
        <button className="mml-btn" onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? '⤡ 停靠' : '⛶ 全屏'}</button>
        <button className="mml-btn" title="把根节点滚回视野中央" onClick={() => { centeredRef.current = true; centerOnRoot() }}>⌖ 根</button>
        <button className="mml-btn" disabled={!selected} onClick={() => { if (selected) void ops([{ op: 'addNode', parentId: selected, title: '新节点' }]) }}>＋子节点</button>
        <button className="mml-btn" onClick={() => { void addSibling() }}>＋同级</button>
        <button className="mml-btn" disabled={!selected} onClick={() => { if (selected) setRenaming(selected) }}>✎ 改名</button>
        <button className="mml-btn" disabled={!selected} onClick={() => { if (selected) void ops([{ op: 'deleteNode', id: selected }]) }}>✕ 删除</button>
        <button className="mml-btn" disabled={!selNode || selNode.children.length === 0} onClick={() => { void toggleCollapse() }}>
          {selNode?.collapsed ? '▾ 展开' : '▸ 折叠'}
        </button>
        <span className="mml-flash">{flash ?? ''}</span>
      </div>
      <div className="mml-canvas-host" ref={hostRef} onClick={() => setSelected(null)}>
        <div className="mml-canvas" style={{ width: w, height: h }}>
          <svg className="mml-lines" width={w} height={h}>{linkEls}</svg>
          {nodeEls}
        </div>
      </div>
    </div>
  )
}

function canvasCss(): string {
  return `
.mml-root{border:1px solid #3a3f4b;border-radius:10px;overflow:hidden;background:#14161c;color:#e8eaf0;
  font:13px/1.4 -apple-system,"PingFang SC","Segoe UI",sans-serif;margin:6px 0}
.mml-root.mml-full{position:fixed;inset:0;z-index:9999;border-radius:0;margin:0}
.mml-bar{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid #2a2f3a;background:#191c24;flex-wrap:wrap}
.mml-btn{border:1px solid #3a3f4b;background:#222633;color:#e8eaf0;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px}
.mml-btn:hover{background:#2c3140}
.mml-btn:disabled{opacity:.4;cursor:default}
.mml-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
.mml-dot-on{background:#3fbf6f;box-shadow:0 0 6px #3fbf6f88}
.mml-dot-off{background:#e0a33f}
.mml-ver{color:#9aa3b2;font-size:11px;margin-right:6px;min-width:26px}
.mml-flash{color:#e0a33f;font-size:11px;margin-left:auto}
.mml-canvas-host{position:relative;height:340px;overflow:auto}
.mml-full .mml-canvas-host{height:calc(100% - 41px)}
.mml-canvas{position:relative;min-width:100%;min-height:100%}
.mml-lines{position:absolute;left:0;top:0;pointer-events:none}
.mml-lines path{fill:none;stroke:#5b6472;stroke-width:1.6px}
.mml-node{position:absolute;display:flex;align-items:center;gap:4px;background:#2653a6;border:1px solid #3f6cc0;
  border-radius:7px;padding:0 6px;cursor:pointer;user-select:none;box-sizing:border-box}
.mml-node:hover{background:#2d61bd}
.mml-node.mml-sel{outline:2px solid #7fb1ff;background:#2f63c4}
.mml-chev{width:14px;text-align:center;color:#bcd2f5;cursor:pointer;flex:none}
.mml-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.mml-rename{width:100%;min-width:0;border:1px solid #7fb1ff;border-radius:4px;background:#10131a;color:#fff;
  font:inherit;padding:1px 4px}
.mml-loading{padding:16px;color:#9aa3b2}
`
}
