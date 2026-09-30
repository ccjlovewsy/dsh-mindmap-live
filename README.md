# @dsh-external/dsh-mindmap-live

实时双向同步思维导图：Agent 与用户在**同一画布**上共编**同一棵树**，任何一方修改即时同步。支持停靠侧边栏（conversation 视图页签）与全屏专注（Esc 退出）。

## 架构

```
Agent 工具 (mindmap_get / mindmap_edit)
        │ ctx.tools.register
        ▼
┌─────────────────────────┐
│  host: 共享树状态        │  version 单调递增
│  ~/.dsh/mindmap-live/   │  变更即持久化
│  tree.json              │
└─────────────────────────┘
        │ ctx.webServer.register (prefix route)
        ▼
HTTP API  /@dsh-external/dsh-mindmap-live/api
  GET  /state   全量树 + version
  POST /op      {ops:[...]} 批量变更（逐条失败隔离）
  GET  /events  SSE：version 变更即推帧（25s 心跳）
        ▼
client 画布（conversation.view 页签，React TSX → tsdown → lib/client.js）
  SSE 即时重渲染 + 2.5s 轮询兜底；用户操作走 POST /op（与 Agent 同一条变更管线）
```

## 工具（模型侧）

- **mindmap_get** — 读全树（id/title/children/collapsed）+ version。改前拿 id、怀疑心智模型过期时重读。
- **mindmap_edit** — 批量 ops：`setTitle | addNode(→新id) | renameNode | deleteNode(根禁删) | moveNode | setCollapsed | replaceTree`。逐条失败不影响整批；用户在并发共编，拿不准先 `mindmap_get`。

## 构建与安装

```bash
bash scripts/build.sh        # 自动探测 DSH_CHECKOUT（本机 ~/.dsh/dsh-harness 链接）
                             # = tsc 编译 host + tsdown 打包 client + npm pack
# 注入器环境内二选一：
dev_install_package <本目录>   # 持久装配（profile dependencies + bundles + 热装配）
dev_inject_plugin  <本目录>   # 仅运行时注入
```

## 复现命令（不依赖注入器）

```bash
B=http://127.0.0.1:3080/@dsh-external/dsh-mindmap-live/api
curl -s $B/state                                   # 读树
curl -s -X POST $B/op -H 'Content-Type: application/json' \
     -d '{"ops":[{"op":"addNode","title":"新节点"}]}'
curl -s -N --max-time 2 $B/events                  # SSE 首帧：data: {"version":N}
```

## schema DSL 两个坑（本插件踩过）

1. **value schema（output 及 parameters 的嵌套层）禁用 `required`** —— 只允许出现在
   parameters 根属性上；output 里写 `required: true`（无论对象级还是属性级）都会在
   loader 装配期报 `schema.required is not supported by the value schema DSL`。
2. **object 节点必须显式 `additionalProperties: boolean`**（开放性强制声明）。

另：装配失败重试前若改过代码，须先清宿主 loader 的模块缓存（`loader.internal.loadCache`），
否则 `loader.create` 会复用旧模块实例——失败现象与代码错误完全相同但文件已是新的。
