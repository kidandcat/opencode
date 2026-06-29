import { Prompt, type PromptRef } from "../../component/prompt"
import { Spinner } from "../../component/spinner"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useProject } from "../../context/project"
import { useToast } from "../../ui/toast"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useTuiConfig } from "../../config"
import { usePromptRef } from "../../context/prompt"
import { useBindings } from "../../keymap"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { ScrollBoxRenderable } from "@opentui/core"
import { Locale } from "../../util/locale"
import { formatDuration } from "../../util/format"
import { errorMessage } from "../../util/error"
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
  Show,
  type JSX,
} from "solid-js"
import type {
  AssistantMessage,
  ExperimentalBackgroundJob,
  Session,
} from "@opencode-ai/sdk/v2"
import path from "path"

const placeholder = {
  normal: ["Dispatch a new agent...", "Run a background task...", "Investigate the auth bug"],
  shell: ["ls -la", "git status", "pwd"],
}

type FleetStatus = "running" | "idle" | "compacting" | "retry" | "error" | "cancelled"

function isRunning(s: FleetStatus) {
  return s === "running" || s === "retry" || s === "compacting"
}

export function Agents() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const project = useProject()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const tuiConfig = useTuiConfig()
  const promptRefCtx = usePromptRef()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  const [selectedID, setSelectedID] = createSignal<string>()
  const [promptRef, setPromptRef] = createSignal<PromptRef | undefined>()
  const [now, setNow] = createSignal(Date.now())
  const [bgJobs, setBgJobs] = createSignal<Record<string, ExperimentalBackgroundJob>>({})
  let scroll: ScrollBoxRenderable | undefined

  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  function statusOf(s: Session): FleetStatus {
    const job = bgJobs()[s.id]
    if (job) {
      if (job.status === "running") return "running"
      if (job.status === "error") return "error"
      if (job.status === "cancelled") return "cancelled"
      return "idle"
    }
    if (s.time.compacting) return "compacting"
    const status = sync.data.session_status[s.id]
    if (status?.type === "busy") return "running"
    if (status?.type === "retry") return "retry"
    return "idle"
  }

  async function refreshBgJobs() {
    if (!sync.data.capabilities.experimentalBackgroundSubagents) return
    try {
      const res = await sdk.client.experimental.background.list({ workspace: project.workspace.current() })
      const list = res.data ?? []
      setBgJobs(Object.fromEntries(list.map((j) => [j.id, j])))
    } catch {
      // background subagents disabled or unavailable; leave jobs empty
    }
  }

  const bgPoll = setInterval(() => void refreshBgJobs(), 2000)
  onCleanup(() => clearInterval(bgPoll))

  const rows = createMemo(() => {
    const all = sync.data.session
    const childrenByParent = new Map<string, Session[]>()
    for (const s of all) {
      if (!s.parentID) continue
      const arr = childrenByParent.get(s.parentID) ?? []
      arr.push(s)
      childrenByParent.set(s.parentID, arr)
    }
    const sortFn = (a: Session, b: Session) => {
      const ra = isRunning(statusOf(a)) ? 0 : 1
      const rb = isRunning(statusOf(b)) ? 0 : 1
      if (ra !== rb) return ra - rb
      return b.time.updated - a.time.updated
    }
    const parents = all.filter((s) => s.parentID === undefined).toSorted(sortFn)
    const out: { session: Session; depth: 0 | 1 }[] = []
    for (const p of parents) {
      out.push({ session: p, depth: 0 })
      for (const c of (childrenByParent.get(p.id) ?? []).toSorted(sortFn)) {
        out.push({ session: c, depth: 1 })
      }
    }
    return out
  })

  const runningCount = createMemo(() => rows().filter((r) => isRunning(statusOf(r.session))).length)

  const selectedIndex = createMemo(() => {
    const id = selectedID()
    if (!id) return 0
    const idx = rows().findIndex((r) => r.session.id === id)
    return idx === -1 ? 0 : idx
  })

  const selected = createMemo(() => rows()[selectedIndex()]?.session)

  createEffect(() => {
    const id = selectedID()
    if (id) void sync.session.sync(id)
  })

  onMount(() => {
    void refreshBgJobs()
    if (!selectedID() && rows().length > 0) setSelectedID(rows()[0].session.id)
  })

  function scrollToSelection() {
    if (!scroll) return
    const children = scroll.getChildren()
    const target = children[selectedIndex()]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    if (y < 0) scroll.scrollBy(y)
  }

  function move(delta: number) {
    const list = rows()
    if (list.length === 0) return
    const next = Math.min(Math.max(selectedIndex() + delta, 0), list.length - 1)
    setSelectedID(list[next].session.id)
    queueMicrotask(scrollToSelection)
  }

  function resume() {
    const s = selected()
    if (!s) return
    route.navigate({ type: "session", sessionID: s.id })
  }

  async function interrupt() {
    const s = selected()
    if (!s) return
    const job = bgJobs()[s.id]
    try {
      if (job && job.status === "running") {
        await sdk.client.experimental.background.cancel({ id: s.id, workspace: project.workspace.current() })
        toast.show({ message: `Cancelled ${Locale.truncate(s.title, 30)}`, variant: "info" })
      } else {
        if (statusOf(s) === "idle") return
        await sdk.client.session.abort({ sessionID: s.id })
        toast.show({ message: `Interrupted ${Locale.truncate(s.title, 30)}`, variant: "info" })
      }
      void refreshBgJobs()
    } catch (error) {
      toast.show({ title: "Failed to interrupt", message: errorMessage(error), variant: "error" })
    }
  }

  async function deleteSession() {
    const s = selected()
    if (!s) return
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete session",
      `Delete session "${Locale.truncate(s.title, 40)}"?`,
    )
    if (!confirmed) return
    try {
      await sdk.client.session.delete({ sessionID: s.id })
      await sync.session.refresh()
    } catch (error) {
      toast.show({ title: "Failed to delete session", message: errorMessage(error), variant: "error" })
    }
  }

  function focusPrompt() {
    promptRef()?.focus()
  }

  function blurPrompt() {
    promptRef()?.blur()
  }

  function goHome() {
    promptRef()?.blur()
    route.navigate({ type: "home" })
  }

  function onCreated(sessionID: string) {
    setSelectedID(sessionID)
    void sync.session.refresh()
    void refreshBgJobs()
  }

  const agentsCommands = createMemo(() => [
    { name: "agents.up", title: "Fleet: previous", category: "Agents", hidden: true, run: () => move(-1) },
    { name: "agents.down", title: "Fleet: next", category: "Agents", hidden: true, run: () => move(1) },
    { name: "agents.resume", title: "Fleet: resume", category: "Agents", hidden: true, run: resume },
    { name: "agents.interrupt", title: "Fleet: interrupt", category: "Agents", hidden: true, run: () => void interrupt() },
    { name: "agents.delete", title: "Fleet: delete", category: "Agents", hidden: true, run: () => void deleteSession() },
    { name: "agents.focus_prompt", title: "Fleet: focus prompt", category: "Agents", hidden: true, run: focusPrompt },
    { name: "agents.home", title: "Fleet: leave", category: "Agents", hidden: true, run: goHome },
    { name: "agents.prompt.blur", title: "Fleet: blur prompt", category: "Agents", hidden: true, run: blurPrompt },
  ])

  const unfocusedBindings = createMemo(() =>
    tuiConfig.keybinds.gather("agents", [
      "agents.up",
      "agents.down",
      "agents.resume",
      "agents.interrupt",
      "agents.delete",
      "agents.focus_prompt",
      "agents.home",
    ]),
  )
  const focusedBindings = createMemo(() => tuiConfig.keybinds.gather("agents.focused", ["agents.prompt.blur"]))

  useBindings(() => ({ commands: agentsCommands() }))
  useBindings(() => ({ enabled: () => renderer.currentFocusedEditor === null, bindings: unfocusedBindings() }))
  useBindings(() => ({ enabled: () => renderer.currentFocusedEditor !== null, bindings: focusedBindings() }))

  const detail = createMemo(() => {
    const s = selected()
    if (!s) return undefined
    const messages = sync.data.message[s.id] ?? []
    const lastAssistant = [...messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === "assistant")
    const parts = lastAssistant ? (sync.data.part[lastAssistant.id] ?? []) : []
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("")
    return { session: s, lastAssistant, text, job: bgJobs()[s.id] }
  })

  function gutterFor(s: Session): JSX.Element {
    const job = bgJobs()[s.id]
    if (job) {
      if (job.status === "running") return <Spinner />
      if (job.status === "error") return <text fg={theme.error}>✗</text>
      if (job.status === "cancelled") return <text fg={theme.textMuted}>⊘</text>
      return <text fg={theme.success}>✓</text>
    }
    const status = statusOf(s)
    if (status === "running" || status === "compacting") return <Spinner />
    if (status === "retry") return <text fg={theme.warning}>↻</text>
    const errored = (sync.data.message[s.id] ?? []).some((m) => m.role === "assistant" && m.error)
    if (errored) return <text fg={theme.error}>✗</text>
    return <text fg={theme.success}>✓</text>
  }

  function modelLabel(s: Session): string {
    if (!s.model) return "—"
    return `${s.model.providerID}/${s.model.id}`
  }

  function cwdLabel(s: Session): string {
    const dir = s.path ? s.directory.replace(new RegExp(`${s.path}$`), "").replace(/\/$/, "") : s.directory
    return path.basename(dir) || dir
  }

  function durationLabel(s: Session): string {
    const status = statusOf(s)
    const end = isRunning(status) ? now() : s.time.updated
    const secs = Math.max(0, Math.floor((end - s.time.created) / 1000))
    return formatDuration(secs)
  }

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" backgroundColor={theme.background}>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={0} paddingTop={0} height={1}>
        <text fg={theme.accent}>
          Agents{" "}
          <span style={{ fg: theme.textMuted }}>
            {rows().length} session{rows().length === 1 ? "" : "s"} · {runningCount()} running
          </span>
        </text>
      </box>
      <box flexShrink={0} height={1} paddingLeft={2} paddingRight={2}>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>↑↓</span> move{"  "}
          <span style={{ fg: theme.text }}>⏎</span> resume{"  "}
          <span style={{ fg: theme.text }}>i</span> interrupt{"  "}
          <span style={{ fg: theme.text }}>d</span> delete{"  "}
          <span style={{ fg: theme.text }}>n</span> new{"  "}
          <span style={{ fg: theme.text }}>q</span> leave
        </text>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          flexGrow={1}
          minHeight={0}
          flexDirection="column"
        >
          <Show
            when={rows().length > 0}
            fallback={<box paddingLeft={2} paddingTop={1}><text fg={theme.textMuted}>No agents yet. Type below to dispatch one.</text></box>}
          >
            <For each={rows()}>
              {(row) => {
                const s = row.session
                const isSelected = createMemo(() => selectedID() === s.id)
                const titleColor = () => (row.depth === 1 ? theme.textMuted : isSelected() ? theme.selectedListItemText : theme.text)
                return (
                  <box
                    height={1}
                    flexShrink={0}
                    paddingLeft={1 + row.depth * 2}
                    paddingRight={1}
                    backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                    onMouseDown={() => {
                      setSelectedID(s.id)
                      blurPrompt()
                    }}
                    onMouseUp={() => {
                      if (renderer.getSelection()?.getSelectedText()) return
                      setSelectedID(s.id)
                    }}
                  >
                    <box width={2} flexShrink={0}>{gutterFor(s)}</box>
                    <text fg={titleColor()} flexGrow={1} truncate>
                      {row.depth === 1 ? "↳ " : ""}{Locale.truncate(s.title || "Untitled", 44)}
                    </text>
                    <text fg={theme.textMuted} flexShrink={0} paddingLeft={2}>
                      {Locale.truncate(modelLabel(s), 26)}
                    </text>
                    <text fg={theme.textMuted} flexShrink={0} paddingLeft={2}>
                      {Locale.truncate(cwdLabel(s), 16)}
                    </text>
                    <text fg={theme.textMuted} flexShrink={0} paddingLeft={2}>
                      {durationLabel(s)}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </scrollbox>
      </box>
      <Show when={detail()}>
        {(d) => (
          <box
            flexShrink={0}
            height={Math.max(4, Math.floor(dimensions().height * 0.18))}
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={0}
            paddingBottom={0}
            border={["top"]}
            borderColor={theme.border}
          >
            <box height={1} flexShrink={0}>
              <text fg={theme.textMuted}>
                {modelLabel(d().session)} · {d().session.agent ?? "default"} · {cwdLabel(d().session)} ·{" "}
                {durationLabel(d().session)}
                <Show when={d().job}>
                  {(job) => <span style={{ fg: theme.accent }}> · bg: {job().status}</span>}
                </Show>
              </text>
            </box>
            <box flexGrow={1} minHeight={0}>
              <text fg={theme.text}>
                {(() => {
                  const dval = d()
                  if (dval.job?.error) return Locale.truncate(dval.job.error, 400)
                  if (dval.job?.output) return Locale.truncate(dval.job.output, 400)
                  if (dval.text) return Locale.truncate(dval.text, 400)
                  const last = dval.lastAssistant
                  if (!last) return "(no messages yet)"
                  if (last.error) return errorMessage(last.error)
                  return "(working…)"
                })()}
              </text>
            </box>
          </box>
        )}
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={0} paddingTop={0} onMouseDown={() => promptRef()?.focus()}>
        <Prompt
          ref={(r) => {
            setPromptRef(r)
            promptRefCtx.set(r)
          }}
          autoFocus={false}
          onCreated={onCreated}
          placeholders={placeholder}
        />
      </box>
    </box>
  )
}
