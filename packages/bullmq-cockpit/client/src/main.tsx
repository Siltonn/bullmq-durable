import "@fontsource-variable/inter"
import { HeroUIProvider } from "@heroui/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import React from "react"
import ReactDOM from "react-dom/client"
import { queryClient } from "./lib/api/query"
import { router } from "./router"
import "./styles.css"

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("bullmq-cockpit: #root element not found")

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HeroUIProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HeroUIProvider>
  </React.StrictMode>,
)
