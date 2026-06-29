import { useEffect, useState } from "react"

type Theme = "light" | "dark"
const STORAGE_KEY = "bullmq-cockpit:theme"

function readTheme(): Theme {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark") return stored
  }
  return "dark"
}

/** Dark/light theme bound to the `dark` class on `<html>` (HeroUI's strategy). */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle("dark", theme === "dark")
    root.classList.toggle("light", theme === "light")
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }, [theme])

  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }
}
