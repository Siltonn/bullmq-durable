/**
 * Code-based TanStack Router setup (no generated route tree). Each route's
 * component is a thin wrapper that reads typed params/search and forwards them
 * as props, keeping the feature pages decoupled from routing.
 *
 * The router is mounted under the cockpit's base path so every link and the
 * browser history work when embedded at e.g. `/admin/bullmq`.
 */

import {
  createRootRoute,
  createRouter,
  createRoute,
  Outlet,
  useNavigate,
} from "@tanstack/react-router"
import { AppShell } from "@/components/layout/app-shell"
import { AlertsPage } from "@/features/alerts"
import { DurableDetailPage, DurablePage } from "@/features/durable"
import { FlowsPage } from "@/features/flows"
import { HealthPage } from "@/features/health"
import { JobDetailPage, JobsPage } from "@/features/jobs"
import { MetricsPage } from "@/features/metrics"
import { OverviewPage } from "@/features/overview"
import { QueueDetailPage, QueuesPage } from "@/features/queues"
import { SchedulersPage } from "@/features/schedulers"
import { getBasePath } from "@/lib/base-path"
import { ConfigProvider } from "@/lib/providers/config"
import { ConfirmProvider } from "@/lib/providers/confirm"
import {
  durableSearchSchema,
  jobsSearchSchema,
  type DurableSearch,
  type JobsSearch,
} from "@/lib/search"
import { TimeZoneProvider } from "@/lib/providers/time"
import { ToastProvider } from "@/lib/providers/toast"

function RootLayout() {
  return (
    <ConfigProvider>
      <ToastProvider>
        <ConfirmProvider>
          <TimeZoneProvider>
            <AppShell>
              <Outlet />
            </AppShell>
          </TimeZoneProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ConfigProvider>
  )
}

// Route components are function declarations (hoisted) so they can reference the
// route consts below at render time without a temporal-dead-zone problem.
function QueueDetailRoute() {
  const { queueName } = queueDetailRoute.useParams()
  return <QueueDetailPage queueName={queueName} />
}

function JobsRoute() {
  const search = jobsRoute.useSearch()
  const navigate = useNavigate()
  return (
    <JobsPage
      search={search}
      onSearchChange={(patch) =>
        navigate({ to: "/jobs", search: (prev) => ({ ...prev, ...patch }) as JobsSearch })
      }
    />
  )
}

function DurableRoute() {
  const search = durableRoute.useSearch()
  const navigate = useNavigate()
  return (
    <DurablePage
      search={search}
      onSearchChange={(patch) =>
        navigate({ to: "/durable", search: (prev) => ({ ...prev, ...patch }) as DurableSearch })
      }
    />
  )
}

function DurableDetailRoute() {
  const { instanceId } = durableDetailRoute.useParams()
  return <DurableDetailPage instanceId={instanceId} />
}

function JobDetailRoute() {
  const { queueName, jobId } = jobDetailRoute.useParams()
  return <JobDetailPage queueName={queueName} jobId={jobId} />
}

const rootRoute = createRootRoute({ component: RootLayout })

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
})
const queuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queues",
  component: QueuesPage,
})
const queueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queues/$queueName",
  component: QueueDetailRoute,
})
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  validateSearch: (search) => jobsSearchSchema.parse(search),
  component: JobsRoute,
})
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$queueName/$jobId",
  component: JobDetailRoute,
})
const durableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/durable",
  validateSearch: (search) => durableSearchSchema.parse(search),
  component: DurableRoute,
})
const durableDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/durable/$instanceId",
  component: DurableDetailRoute,
})
const flowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flows",
  component: FlowsPage,
})
const schedulersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedulers",
  component: SchedulersPage,
})
const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/metrics",
  component: MetricsPage,
})
const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alerts",
  component: AlertsPage,
})
const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthPage,
})

const routeTree = rootRoute.addChildren([
  overviewRoute,
  queuesRoute,
  queueDetailRoute,
  jobsRoute,
  jobDetailRoute,
  flowsRoute,
  schedulersRoute,
  metricsRoute,
  durableRoute,
  durableDetailRoute,
  alertsRoute,
  healthRoute,
])

export const router = createRouter({
  routeTree,
  basepath: getBasePath() || undefined,
  defaultPreload: false,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
