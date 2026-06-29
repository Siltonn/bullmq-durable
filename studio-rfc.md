BullMQ Durable / BullMQ Cockpit 技术方案与产品需求

1. 项目整体目标

本项目分为两个相关但独立的能力：

bullmq-durable
为 BullMQ Job 增加 durable execution 能力
bullmq-cockpit
现代化 BullMQ Dashboard，并兼容 bullmq-durable 的 Durable Instance 展示

核心目标：

1. 保持 BullMQ 原有使用心智
2. 让 Job 支持 step checkpoint / sleep / retry / resume
3. 提供 NestJS 集成，但不强依赖 @nestjs/bullmq
4. 提供现代化 Dashboard，兼容普通 BullMQ 用户
5. 对 bullmq-durable 用户提供更好的 Instance Timeline / Step Debug / Resume 控制台

⸻

Part 1：bullmq-durable

2. 项目定位

bullmq-durable 是一个 BullMQ runtime 增强包。

它不是 Temporal，也不是完整 workflow engine。

它的定位是：

Durable execution for BullMQ jobs.
Checkpoint, retry, sleep, and resume long-running jobs with a simple step API.

核心抽象：

BullMQ Job = 一段 Durable Workflow Execution
ctx.step = durable checkpoint
ctx.sleep = yield + delayed resume
ctx.retryLater = delayed retry current durable instance

⸻

3. 使用侧 API

3.1 Core API

import { DurableQueue, DurableWorker } from "bullmq-durable"
const queue = new DurableQueue("generation", {
connection,
})
await queue.add("video", {
userId,
prompt,
}, {
jobId: generationId,
})
new DurableWorker(
"generation",
async (job, ctx) => {
const task = await ctx.step("create-video-task", async () => {
return createVideoTask(job.data)
})
await ctx.sleep("wait-first-poll", "10s")
const result = await ctx.step("poll-video-result", {
retry: {
attempts: 30,
backoff: "fixed",
delay: "10s",
},
}, async () => {
const result = await pollVideoTask(task.id)
if (result.status !== "completed") {
throw ctx.retryLater("video still pending")
}
return result
})
return ctx.step("save-asset", async () => {
return saveVideoAsset(result.url)
})
},
{
connection,
},
)

设计原则：

1. DurableQueue 尽量兼容 BullMQ Queue
2. DurableWorker 尽量兼容 BullMQ Worker
3. processor 从 async (job) 变成 async (job, ctx)
4. 用户只需要传 connection，不直接操作 Redis

⸻

3.2 NestJS API

nestjs 集成放在同一个 npm 包的 subpath export：

import {
DurableBullModule,
DurableProcessor,
DurableProcess,
InjectDurableQueue,
} from "bullmq-durable/nestjs"

用法：

@Module({
imports: [
DurableBullModule.forRoot({
connection,
}),
DurableBullModule.registerQueue({
name: "generation",
}),
],
providers: [GenerationProcessor, GenerationService],
})
export class GenerationModule {}
@Injectable()
export class GenerationService {
constructor(
@InjectDurableQueue("generation")
private readonly queue: DurableQueue<GenerationJobs>,
) {}
createVideo(input: CreateVideoInput) {
return this.queue.add("video", input, {
jobId: input.generationId,
})
}
}
@DurableProcessor("generation")
export class GenerationProcessor {
@DurableProcess("video")
async run(
job: DurableJob<CreateVideoInput, VideoResult>,
ctx: DurableContext,
): Promise<VideoResult> {
const task = await ctx.step("create-task", () => {
return createVideoTask(job.data)
})
await ctx.sleep("wait", "10s")
return ctx.step("save-result", () => {
return saveResult(task.id)
})
}
}

NestJS 集成原则：

1. 不依赖 @nestjs/bullmq
2. 使用方式尽量对齐 @nestjs/bullmq
3. 只依赖 @nestjs/common / @nestjs/core 作为 optional peerDependencies
4. 核心 runtime 不知道 NestJS 存在

⸻

4. Durable Runtime 核心原理

4.1 Replay + Memoization

每次 resume 并不是恢复 JS 调用栈，而是重新执行 processor。

已完成 step 从 StateStore 读取 result，不再执行 callback。

第一次执行：
step A -> execute -> completed
step B -> execute -> completed
step C -> crash
第二次 resume：
step A -> cache hit
step B -> cache hit
step C -> execute

⸻

4.2 ctx.step

语义：

1. 查询 step state
2. 如果 completed，返回缓存 result
3. 如果未完成，执行 callback
4. 成功后保存 result
5. 失败后根据 retry policy 决定 fail 或 delayed resume
   await ctx.step("deduct-credits", async () => {
   return db.creditLedger.create({
   userId,
   amount: -240,
   idempotencyKey: ctx.stepId("deduct-credits"),
   })
   })

注意：

1. step key 必须稳定
2. 外部副作用仍然需要业务幂等
3. ctx.stepId 可辅助生成业务 idempotency key

⸻

4.3 ctx.sleep

await ctx.sleep("wait-provider", "30s")

内部行为：

1. 保存 sleep checkpoint
2. enqueue delayed resume job
3. throw DurableYieldError
4. worker 捕获后正常退出
5. delay 到期后重新执行 processor

⸻

4.4 ctx.retryLater

throw ctx.retryLater("provider still pending")

或：

throw ctx.retryLater("10s", "provider still pending")

适合 provider polling 场景。

⸻

5. StateStore 设计

默认使用 Redis。

原则：

BullMQ = queue / delay / worker / concurrency
RedisStateStore = durable execution checkpoint
Business DB = 业务最终状态

不建议把 durable state 放进 job.data。

job.data 只存业务输入；durable 状态单独存在 Redis。

5.1 Redis Key

{prefix}:instance:{instanceId}
{prefix}:instance:{instanceId}:steps
{prefix}:instance:{instanceId}:events
{prefix}:instance:{instanceId}:logs
{prefix}:index:instances
{prefix}:index:status:{status}
{prefix}:index:queue:{queueName}
{prefix}:index:job:{queueName}:{jobName}
{prefix}:index:tag:{key}:{value}

5.2 InstanceState

type DurableInstanceState = {
id: string
queueName: string
jobName: string
originalJobId?: string
status:
| "running"
| "sleeping"
| "retrying"
| "waiting"
| "completed"
| "failed"
| "cancelled"
input?: unknown
output?: unknown
error?: SerializedError
currentStepKey?: string
currentStepStatus?: string
runCount: number
resumeSeq: number
tags?: Record<string, string>
metadata?: Record<string, unknown>
createdAt: number
updatedAt: number
startedAt?: number
completedAt?: number
failedAt?: number
nextRunAt?: number
durationMs?: number
}

5.3 StepState

type DurableStepState = {
key: string
displayName?: string
type:
| "step"
| "sleep"
| "waitForEvent"
status:
| "pending"
| "running"
| "completed"
| "failed"
| "retrying"
| "sleeping"
| "skipped"
attempts: number
maxAttempts?: number
startedAt?: number
completedAt?: number
failedAt?: number
nextRunAt?: number
durationMs?: number
result?: unknown
resultPreview?: unknown
error?: SerializedError
}

⸻

6. Redis 持久化说明

文档必须明确：

bullmq-durable 默认把执行状态存在 Redis。
Durability 取决于 Redis 的持久化、备份、复制和淘汰策略。

推荐生产配置：

appendonly yes
appendfsync everysec
maxmemory-policy noeviction
managed Redis with replication
regular backups

关键业务状态必须进入业务 DB：

credits ledger
payment state
subscription state
asset record
refund state
affiliate payout

⸻

7. package 组织

单 npm 包：

bullmq-durable

subpath export：

{
"name": "bullmq-durable",
"exports": {
".": {
"types": "./dist/index.d.ts",
"import": "./dist/index.js"
},
"./nestjs": {
"types": "./dist/nestjs/index.d.ts",
"import": "./dist/nestjs/index.js"
}
},
"dependencies": {
"bullmq": "^5.0.0"
},
"peerDependencies": {
"@nestjs/common": ">=10",
"@nestjs/core": ">=10"
},
"peerDependenciesMeta": {
"@nestjs/common": {
"optional": true
},
"@nestjs/core": {
"optional": true
}
}
}

注意：

src/index.ts 不允许 export nestjs 内容

⸻

Part 2：bullmq-cockpit

8. Dashboard 项目定位

由于 bullmq-board npm 包已被占用，推荐名称：

bullmq-cockpit

定位：

Modern dashboard and durable instance inspector for BullMQ.

它服务两类用户：

1. 普通 BullMQ 用户
   queue / job / flow / scheduler / metrics dashboard
2. bullmq-durable 用户
   durable instance / step timeline / retry / resume / cancel inspector

⸻

## 交互参考

普通 BullMQ Dashboard 部分优先参考：

1. Workbench
   - queue overview
   - jobs table
   - status filters
   - job detail drawer
   - payload / return value / logs / error 展示
   - flows / schedulers / metrics 组织方式

2. bull-board
   - 队列适配方式
   - job actions
   - retry / promote / remove / clean 等基础操作

bullmq-cockpit 的差异化重点不在重新设计普通 BullMQ 操作，而在：

- 更现代的 HeroUI Pro 视觉系统
- 更好的表格筛选 / 搜索 / 分页体验
- bullmq-durable Durable Instance 展示
- Step Timeline
- Resume / Retry / Cancel 语义化操作
- Stuck detection
- Durable event / log / result preview

9. 为什么单独成包

bullmq-cockpit 不放进 bullmq-durable 主包。

原因：

1. Dashboard 依赖重：React、HeroUI Pro、TanStack、icons、charts
2. Runtime 必须轻量稳定
3. Dashboard 面向普通 BullMQ 用户，不只服务 durable
4. UI 迭代节奏和 runtime 不同

推荐 monorepo：

bullmq-durable/
├─ packages/
│ ├─ bullmq-durable/
│ └─ bullmq-cockpit/

发布：

bullmq-durable
bullmq-cockpit

⸻

10. bullmq-cockpit 技术栈

10.1 Server

Hono
Zod
BullMQ
ioredis

为什么 Hono：

1. 轻量
2. TypeScript 体验好
3. 适合组织嵌入式 dashboard API
4. 可以被 Express / Fastify / NestJS adapter 包装
5. 可以 standalone 运行

   10.2 Frontend

React
Vite
TanStack Router
TanStack Query
TanStack Table
HeroUI Pro / HeroUI React
Tailwind CSS
JSON viewer

不用 Next.js。

原因：

1. 不需要 SSR
2. 不需要 Server Components
3. Dashboard 是嵌入式静态 SPA
4. Vite 更轻，更适合被 server adapter 托管

# UI Design Guidelines

## Design System

整个 Dashboard 采用统一的现代设计语言。

### UI Framework

- HeroUI Pro
- Tailwind CSS
- React

### Routing

- TanStack Router

### Data

- TanStack Query
- TanStack Table

### Icons

整个项目统一使用 **Iconify** 作为 Icon Runtime，并默认采用 **Hugeicons** 作为 Icon Pack。

这样做有以下几个目的：

- 保持整个 Dashboard 的视觉风格统一
- 避免同时使用多个 Icon Library（如 Lucide、Heroicons、Tabler）
- 后续可无缝切换 Icon Pack，而无需修改业务代码
- 所有图标均通过统一组件进行渲染

推荐使用方式：

```tsx
import { Icon } from "@iconify/react"
;<Icon icon="hugeicons:dashboard-square-01" />
```

不建议直接引入其他 Icon Library：

```tsx
import { Activity } from "lucide-react"
```

### Icon Registry

项目内部建议维护统一的 Icon Registry，而不是在业务代码中直接使用 Iconify 的字符串。

例如：

```ts
export const Icons = {
  dashboard: "hugeicons:dashboard-square-01",
  queues: "hugeicons:queue-02",
  jobs: "hugeicons:ai-job-search",
  durable: "hugeicons:workflow-circle-01",
  retry: "hugeicons:refresh",
  play: "hugeicons:play",
  pause: "hugeicons:pause",
  success: "hugeicons:checkmark-circle-02",
  failed: "hugeicons:alert-02",
}
```

业务组件统一使用：

```tsx
<CockpitIcon name="retry" />
```

而不是：

```tsx
<Icon icon="hugeicons:refresh" />
```

这样未来即使更换 Icon Pack（如 Hugeicons → Solar），也只需要修改 Icon Registry，而无需修改业务代码。

⸻

11. bullmq-cockpit 使用方式

11.1 Express

import { createBullMQCockpit } from "bullmq-cockpit/express"
app.use(
"/admin/bullmq",
createBullMQCockpit({
connection,
queues: ["generation", "persona"],
durable: {
enabled: true,
prefix: "bullmq-durable",
},
auth: async ({ req }) => {
return req.user?.role === "admin"
},
}),
)

11.2 NestJS

import { BullMQCockpitModule } from "bullmq-cockpit/nestjs"
@Module({
imports: [
BullMQCockpitModule.register({
path: "/admin/bullmq",
connection,
queues: ["generation", "persona"],
durable: {
enabled: true,
},
}),
],
})
export class AdminModule {}

11.3 Standalone

npx bullmq-cockpit \
 --redis redis://localhost:6379 \
 --queues generation,persona \
 --port 3001

⸻

12. API 路径设计

必须避免和用户 business API 冲突。

原则：

所有 API 都挂在用户指定 basePath 下。

例如用户挂载：

/admin/bullmq

则内部路径：

/admin/bullmq React UI
/admin/bullmq/api/_ Dashboard API
/admin/bullmq/assets/_ Static assets

不要使用全局：

/api/queues

前端通过注入配置读取 basePath：

<script>
  window.__BULLMQ_COCKPIT__ = {
    basePath: "/admin/bullmq"
  }
</script>

前端请求：

fetch(`${window.__BULLMQ_COCKPIT__.basePath}/api/queues`)

⸻

13. Server API 设计

13.1 Hono App

import { Hono } from "hono"
export function createBoardApp(options: BullMQCockpitOptions) {
const app = new Hono()
const context = createBoardContext(options)
app.use("_", authMiddleware(context))
app.route("/api/overview", overviewRoutes(context))
app.route("/api/queues", queueRoutes(context))
app.route("/api/jobs", jobRoutes(context))
app.route("/api/durable", durableRoutes(context))
app.route("/api/health", healthRoutes(context))
app.get("_", serveClient(context))
return app
}

13.2 Context

type BoardContext = {
options: NormalizedCockpitOptions
queues: Map<string, Queue>
bullmqInspector: BullMQInspector
durableInspector?: DurableInspector
healthInspector: HealthInspector
auth: AuthHandler
readonly: boolean
}

⸻

14. Inspector 分层

Route 不直接操作 BullMQ/Redis。

routes -> inspector/actions -> BullMQ / Redis

14.1 BullMQInspector

class BullMQInspector {
listQueues(): Promise<QueueSummary[]>
getQueue(name: string): Promise<QueueDetail>
listJobs(
queueName: string,
query: JobListQuery,
): Promise<Paginated<JobSummary>>
getJob(
queueName: string,
jobId: string,
): Promise<JobDetail | null>
getJobLogs(
queueName: string,
jobId: string,
): Promise<JobLogs>
retryJob(queueName: string, jobId: string): Promise<void>
promoteJob(queueName: string, jobId: string): Promise<void>
removeJob(queueName: string, jobId: string): Promise<void>
pauseQueue(queueName: string): Promise<void>
resumeQueue(queueName: string): Promise<void>
cleanQueue(queueName: string, options: CleanOptions): Promise<void>
drainQueue(queueName: string): Promise<void>
}

14.2 DurableInspector

class DurableInspector {
listInstances(
query: DurableInstanceQuery,
): Promise<Paginated<DurableInstanceSummary>>
getInstance(
instanceId: string,
): Promise<DurableInstanceDetail | null>
getSteps(instanceId: string): Promise<DurableStepState[]>
getEvents(instanceId: string): Promise<DurableEvent[]>
resumeNow(instanceId: string): Promise<void>
retry(instanceId: string): Promise<void>
cancel(instanceId: string): Promise<void>
deleteState(instanceId: string): Promise<void>
}

⸻

15. HTTP API

Overview

GET /api/overview

Queues

GET /api/queues
GET /api/queues/:queueName
POST /api/queues/:queueName/pause
POST /api/queues/:queueName/resume
POST /api/queues/:queueName/clean
POST /api/queues/:queueName/drain

Jobs

GET /api/queues/:queueName/jobs
GET /api/queues/:queueName/jobs/:jobId
GET /api/queues/:queueName/jobs/:jobId/logs
GET /api/queues/:queueName/jobs/:jobId/dependencies
POST /api/queues/:queueName/jobs/:jobId/retry
POST /api/queues/:queueName/jobs/:jobId/promote
POST /api/queues/:queueName/jobs/:jobId/remove

Durable

GET /api/durable/instances
GET /api/durable/instances/:instanceId
GET /api/durable/instances/:instanceId/steps
GET /api/durable/instances/:instanceId/events
GET /api/durable/instances/:instanceId/logs
POST /api/durable/instances/:instanceId/resume
POST /api/durable/instances/:instanceId/retry
POST /api/durable/instances/:instanceId/cancel
POST /api/durable/instances/:instanceId/delete

Health

GET /api/health
GET /api/health/stuck

⸻

16. Frontend 结构

client/
├─ index.html
├─ vite.config.ts
├─ src/
│ ├─ main.tsx
│ ├─ app.tsx
│ ├─ routeTree.gen.ts
│ │
│ ├─ routes/
│ │ ├─ \_\_root.tsx
│ │ ├─ index.tsx
│ │ ├─ queues.tsx
│ │ ├─ queues.$queueName.tsx
│  │  ├─ jobs.tsx
│  │  ├─ jobs.$queueName.$jobId.tsx
│  │  ├─ durable.tsx
│  │  ├─ durable.$instanceId.tsx
│ │ └─ health.tsx
│ │
│ ├─ layouts/
│ │ ├─ dashboard-layout.tsx
│ │ ├─ sidebar.tsx
│ │ ├─ topbar.tsx
│ │ └─ command-menu.tsx
│ │
│ ├─ features/
│ │ ├─ overview/
│ │ ├─ queues/
│ │ ├─ jobs/
│ │ ├─ durable/
│ │ └─ health/
│ │
│ ├─ components/
│ │ ├─ data-table/
│ │ ├─ status-badge.tsx
│ │ ├─ metric-card.tsx
│ │ ├─ json-viewer.tsx
│ │ ├─ confirm-dialog.tsx
│ │ └─ action-menu.tsx
│ │
│ └─ lib/
│ ├─ api-client.ts
│ ├─ query-client.ts
│ ├─ base-path.ts
│ ├─ format.ts
│ └─ status.ts

⸻

17. Frontend 路由

使用 TanStack Router。

原因：

1. 与 TanStack Query/Table 搭配自然
2. search params 类型化
3. filter / pagination / sorting 可以放 URL
4. Dashboard 很适合 URL-state 模型

示例：

/admin/bullmq/jobs?queue=generation&status=failed&page=1&pageSize=50
/admin/bullmq/durable?status=retrying&queue=generation&stuckOnly=true

路由 search schema：

export const Route = createFileRoute("/jobs")({
validateSearch: z.object({
queue: z.string().optional(),
status: z.string().optional(),
page: z.number().catch(1),
pageSize: z.number().catch(50),
}),
component: JobsPage,
})

⸻

18. UI 页面需求

18.1 Overview

显示：

Queue total
Waiting
Active
Delayed
Failed
Completed
Durable Running
Durable Retrying
Durable Sleeping
Durable Failed
Durable Stuck

18.2 Queues

表格字段：

Queue
Waiting
Active
Delayed
Failed
Completed
Paused
Workers
Actions

18.3 Jobs

表格字段：

ID
Name
Queue
Status
Attempts
Priority
Delay
Created
Processed
Finished
Duration
Durable
Actions

Job detail tabs：

Overview
Data
Return Value
Logs
Error
Dependencies
Raw
Durable

18.4 Durable Instances

表格字段：

Instance
Business ID
Queue
Job
Status
Current Step
Attempts
Next Resume
Duration
Updated
Tags
Actions

18.5 Durable Instance Detail

布局：

Header:
status / instanceId / queue / jobName / duration / next resume
Left:
Step Timeline
Center:
Selected Step Detail
Right:
Metadata + Actions

Timeline 示例：

✓ Create Provider Task completed 421ms
✓ Initial Wait slept 10s
↻ Poll Provider Result retrying 12/60, next in 8s
○ Save Asset pending
○ Notify User pending

⸻

19. 权限与安全

19.1 Auth Hook

type AuthHandler = (ctx: AuthContext) => Promise<AuthResult> | AuthResult
type AuthResult =
| boolean
| {
allowed: boolean
user?: {
id: string
name?: string
role?: string
}
permissions?: BoardPermission[]
}

权限：

type BoardPermission =
| "queue:read"
| "queue:write"
| "job:read"
| "job:write"
| "durable:read"
| "durable:resume"
| "durable:retry"
| "durable:cancel"
| "durable:delete"
| "dangerous:write"

19.2 Readonly Mode

createBullMQCockpit({
readonly: true,
})

Readonly 禁止：

pause queue
clean queue
drain queue
remove job
retry job
resume durable instance
cancel durable instance
delete state

⸻

20. Stuck Detection

Dashboard 需要识别 stuck durable instance。

类型：

running_stale:
status = running
updatedAt 超过阈值
resume_missed:
nextRunAt 已经过期
instance 仍未更新
orphan_resume_job:
BullMQ 有 resume job，但 durable instance 不存在
orphan_instance:
durable instance 存在，但找不到相关 BullMQ job

API：

GET /api/health/stuck

⸻

21. Actions 语义

Resume Now

适用于：

sleeping
retrying
waiting
stuck

行为：

enqueue resume job delay=0
写 durable event
写 audit log

Retry

适用于：

failed

行为：

instance status -> running/retrying
保留 completed steps
failed step 重新执行
enqueue resume job

Cancel

行为：

mark instance cancelled
尝试移除 delayed resume job
后续 resume tick 发现 cancelled 后退出

Delete State

行为：

删除 durable state
不删除业务 DB
不默认删除 BullMQ jobs

⸻

22. Build 方案

Server

用 tsup：

export default defineConfig({
entry: [
"src/index.ts",
"src/adapters/express.ts",
"src/adapters/fastify.ts",
"src/adapters/nestjs.ts",
"src/adapters/standalone.ts",
"src/cli/index.ts",
],
format: ["esm"],
dts: true,
clean: true,
external: [
"express",
"fastify",
"@nestjs/common",
"@nestjs/core",
],
})

Client

用 Vite：

client -> dist/client

Server 托管：

{basePath}/assets/_
{basePath}/_

⸻

23. MVP 范围

第一版做：

bullmq-durable:
DurableQueue
DurableWorker
ctx.step
ctx.sleep
ctx.retryLater
RedisStateStore
NestJS integration
bullmq-cockpit:
Express adapter
Standalone CLI
Hono API core
Overview page
Queue list
Job list
Job detail
Durable instance list
Durable instance detail
Step timeline
Resume / retry / cancel
Readonly mode
Auth hook

第二阶段：

Fastify adapter
NestJS adapter
Flow view
Schedulers page
Stuck detection
Audit log
Metrics charts
Related BullMQ jobs
Redaction config

第三阶段：

WebSocket realtime
Replay from step
Plugin system
Saved filters
Advanced search
Alert rules
RBAC UI

⸻

24. 最终架构决策总结

1. bullmq-durable 和 bullmq-cockpit 拆成两个 npm 包
1. 放在同一个 monorepo 维护
1. bullmq-durable/nestjs 放在 runtime 包里，用 optional peer dependency
1. bullmq-cockpit 用 Hono 组织 server API
1. bullmq-cockpit 前端用 React + Vite + TanStack Router + HeroUI Pro
1. 所有 API 必须挂在 basePath 下，避免和业务 API 冲突
1. 普通 BullMQ 用户可以只用 BullMQ dashboard
1. durable 用户会自动获得 Durable Instance Inspector
