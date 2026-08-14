# dsh-observability

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）导出 OpenTelemetry **traces**：把每个 agent 会话导出成 OTLP span 树——turn 对应 trace，模型 step 对应子 span，工具调用对应该 step 的子 span——带 GenAI 语义约定属性，发往任何接受 OTLP/HTTP 的 collector。

这是社区插件（`dsh-plugin` topic），不属于官方仓库。它实现 harness 公开的遥测 Service Definition（`@deepseek-ai/dsh-session-telemetry`），作为官方 Provider 之外的第二个 Service Provider——官方那个导出的是 OTLP **logs**。

## 安装

本包自带 `cordis.patch.yml`，因此可以作为 profile bundle 安装：

```sh
dsh plugin --profile web add dsh-observability
export DSH_OBSERVABILITY_MODE=FULL
export DSH_OBSERVABILITY_OTLP_URL=http://127.0.0.1:4318/v1/traces
```

在 `DSH_OBSERVABILITY_MODE` 明确开启之前，共享始终关闭。配置了 endpoint 不等于同意上传会话内容，参见 [离开本机的数据](#离开本机的数据)。

自带的 patch 会关掉 base profile 的 `session-telemetry-otel` 行：遥测 Service Definition 每个 context 只接受一个后端，重复加载直接抛错。

也可以作为显式的 `cordis.yml` 行挂载：

```yaml
- id: session-telemetry-otlp-traces
  name: dsh-observability
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED（默认）
    exporter:                  # 原样透传给 SDK 的 OTLP/HTTP trace exporter
      url: http://127.0.0.1:4318/v1/traces
      compression: gzip
    processor: {}              # 可选，原样透传给 BatchSpanProcessor
    shutdownTimeoutMillis: 3000
    maxAttributeChars: 32768
```

## 配置

| 字段 | 含义 |
|---|---|
| `mode` | `FULL` 实时导出每个会话；`FEEDBACK_ONLY` 仅在用户记录 feedback 时回放并导出 canonical 会话日志；`DISABLED`（默认）不构造任何东西，也没有任何数据离开进程。词表与同意语义都属于 Service Definition，与官方 Provider 完全一致。 |
| `exporter` | 完整的 `OTLPExporterNodeConfigBase` 对象，原样透传给 OTLP/HTTP trace exporter。`url` 是本包唯一要求并自行校验的字段，且必须是**完整的 traces 路径**（`…/v1/traces`）。 |
| `processor` | 原样透传给 `BatchSpanProcessor`（`scheduledDelayMillis`、`maxQueueSize`、`maxExportBatchSize` 等）；批量、重试和丢失策略都是 SDK 文档化的行为。 |
| `shutdownTimeoutMillis` | 插件自己持有的外层截止时间，约束 SDK 的 shutdown 排空。默认 3000。 |
| `maxAttributeChars` | 每个 span 属性的序列化载荷上限（默认 32768）。上限约束的是导出值本身，已把 `…[clipped]` 标记计算在内；被截断的 span 带 `dsh.payload_clipped=true`——载荷本身就可能以该标记结尾，所以标记本身不足以作为判据。canonical 会话日志保留完整字节。 |

配置错误在插件加载时就 fail loud，且发生在构造任何 transport 之前：`url` 缺失、为空、非字符串、格式错误或非 `http(s)`；`processor.maxExportBatchSize` 不是正整数（SDK 会接受，但随后在 shutdown 时挂死）；`shutdownTimeoutMillis` 非正或非有限；`maxAttributeChars` 非正；以及未知的 `mode`。

## 字段映射

| dsh 会话事件 | Span |
|---|---|
| `turn/start` / `turn/end` | trace 根 span；结束原因写入 `dsh.turn.end_reason`，错误原因置 status ERROR，并带上失败的 `code: message` |
| `step/start` / `step/end` | 子 span，带 `gen_ai.operation.name=chat` |
| `request/header` | `gen_ai.request.model`、`gen_ai.provider.name` 和采样标量，回填到当时已经打开的 step 上。后续 header 整组替换这些属性，因此它没带的标量不会从上一份沿用下来 |
| 每个 step 的首个 `assistant/chunk` | `dsh.step.time_to_first_chunk_ms`（首 token 时间） |
| `assistant/message` | 组装后的回复，加上全部五个 `gen_ai.usage.*` 计数（输入、输出、缓存读、缓存写、reasoning） |
| `tool/call` + `tool/result` | 发起该调用的 step 的子 span，带 `gen_ai.operation.name=execute_tool`；失败结果置 status ERROR，若上报了失败标识则带上其 `code: name` |
| `user/message` | 该 turn 认领的人类 prompt（`source.kind` 为 `user`）写入 trace 根 span 的 `dsh.turn.input`。同一事件类型还承载 `agent.inject()` 注入的上下文和 goal 续轮消息，它们作为 span event 留在时间线上，不会顶替 prompt |
| `agent-error` ops 记录 | 当前打开 span 上的 `exception` span event，带 `exception.type` / `exception.message`，并置 status ERROR |
| 其他一切事件类型（todo、plan、compaction、hooks、插件事件） | 最内层打开 span 上的时点 span event |
| 本包不认识的 ops 记录操作 | 时点 span event；该操作集由 seam 拥有且可扩展，因此未知操作永远不会截断 trace |

标识符是**派生的，不是生成的**：`traceId` 由 `(session.id, turn)` 派生，`spanId` 由 `(session.id, turn, step[, callId])` 派生。因此对同一批事件，实时捕获与 `FEEDBACK_ONLY` 的 canonical 日志回放产出完全相同的树；cursor 丢失后的重新 adoption 造成的重复投递会落到已有 span 上，而不是产生第二棵互不相连的树。所有时间戳都取记录自带的 `time`，从不使用 wall clock，理由相同。

因终止事件缺失而仍然打开的 span 会被 force-end 扫描关闭并标记 `dsh.force_ended`：下一个 `turn/start` 发现前一个 turn 还开着时、会话的 `shutdown` 运维记录时、`FEEDBACK_ONLY` 回放结束时、以及后端 shutdown 时。

`turn/start` 缺失——崩溃窗口，或被脱敏规则扣下的记录——不会让该 turn 的子 span 变成孤儿。第一个落在未打开 turn 下的子记录会合成该 turn 的根 span 并标记 `dsh.turn.synthesized`，因此 collector 不会收到一个 parent 永远不会送达的 span。

## 离开本机的数据

在上传模式下，span 属性携带用户与 assistant 的消息内容、工具参数与结果（命令输出、文件内容）、模型与用量元数据，以及会话 `cwd`（一个本地路径），具体内容由 `session-telemetry/record` waterfall 的返回值决定。

**本插件不自带任何脱敏规则。** 在没有挂载 waterfall listener 的情况下，记录会原样到达 exporter，因此要导出到受信边界之外的部署必须自行挂载规则。Provider 的 API key 在结构上不存在：适配器凭据是构造参数而非会话事件，所以它们从不进入会话日志，也因此从不进入遥测。序列化载荷按 `maxAttributeChars` 逐属性截断，canonical 日志保留完整字节。

## Model Experience

无。本插件只通过遥测 Service Definition 观察会话流，并把折叠后的 span 交给 OTel SDK，从不参与构成模型请求。

#### KV Cache 影响

无。本插件既不组装也不发送 provider 请求。

## 测试

```sh
npm test                            # 单测：id 派生、折叠投影、配置 fail-loud 路径
npm run build && npm run test:e2e   # 通过 Loader 的真实组合，对打 mock collector
```

e2e 层遵循官方仓库的 REAL-composition 模式：fixture `cordis.yml` 加载**构建后的** `lib/index.js`——与部署时加载的是同一个文件——断言打在 wire 上的 OTLP 载荷，而不是内部实现。

## 版本兼容

DeepSeek Harness 处于 developer preview，不提供兼容承诺；本插件 pin 精确的 `@deepseek-ai/dsh-*` 版本。

| dsh-observability | `@deepseek-ai/dsh-*` | `@deepseek-ai/cordis` |
|---|---|---|
| 0.1.x | 0.1.0-rc.6 | 4.0.1 |

## 已知限制与待办

- **尽力投递。** 继承自 Service Definition：handoff cursor 标记的是「已交出」，不是「已送达」。崩溃时留在 SDK 批队列里的内容会丢失，cursor 丢失后的重新 adoption 可能重复交出一个前缀。派生标识符让这些重复在接收端幂等，但持久化 outbox 不在本包范围内。
- **不自带脱敏规则。** 见[离开本机的数据](#离开本机的数据)。
- **subagent 谱系未串联。** fork 出的会话，其树从继承边界开始；`session.parent_id` 和 `session.seed_length` 会作为 span 属性带出，但不创建 trace links。
- **每个 context 只能一个后端。** 想同时跑本插件和官方 OTLP-logs Provider，需要上游 Service Definition 演进出 multi-sink 能力。
- **没有 metrics 信号。** Service Definition 的记录词表是 log 形状的（time、severity、attributes、body），所以 counter 和 histogram 只能在这里推导而非直接捕获；本插件只导出 traces。

## 许可

[MIT](LICENSE.txt)
