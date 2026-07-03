import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import path from "path"
import { useTuiPaths } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { DialogMoveSession, type MoveSessionSelection } from "../dialog-move-session"
import { DialogWorkspaceFileChanges } from "../dialog-workspace-file-changes"
import { useHomeSessionDestination } from "../../routes/home/session-destination"
import { useProject } from "../../context/project"

function moveReminderText(directory: string) {
  return `<system-reminder>The user has changed the current working directory to "${directory}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

export function usePromptMove(input: { projectID: () => string | undefined; sessionID: () => string | undefined }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const homeDestination = useHomeSessionDestination()
  const project = useProject()
  const paths = useTuiPaths()
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [progress, setProgress] = createSignal<string>()

  async function create(name: string) {
    const projectID = input.projectID()
    if (!projectID) return
    setCreating(true)
    setProgress("Creating copy")
    try {
      const result = await sdk.api.projectCopy.create({
        projectID,
        location: { directory: project.instance.directory() || paths.cwd },
        strategy: "git_worktree",
        directory: path.join(paths.worktree, projectID.slice(0, 6)),
        name,
      })
      const directory = result.directory
      if (!directory) throw new Error("No project copy directory returned")

      // Call a location-based route to make sure it's bootstrapped before moving on.
      await sdk.api.location.get({ location: { directory } })

      setProgress("Creating session")
      return directory
    } catch (err) {
      homeDestination?.clear()
      setProgress(undefined)
      setCreating(false)
      toast.show({ title: "Creating workspace failed", message: errorMessage(err), variant: "error" })
      return
    }
  }

  async function open() {
    if (!input.projectID()) {
      await project.sync().catch((error) => {
        toast.show({ title: "Loading project failed", message: errorMessage(error), variant: "error" })
      })
    }
    const projectID = input.projectID()
    if (!projectID) {
      toast.show({ message: "Project is still loading", variant: "error" })
      return
    }
    const sessionID = input.sessionID()
    const session = sessionID ? sync.session.get(sessionID) : undefined
    dialog.replace(() => (
      <DialogMoveSession
        projectID={projectID}
        current={
          homeDestination?.destination() ??
          (session
            ? {
                type: "directory",
                directory: session.directory,
                subdirectory: !!session.path,
              }
            : {
                type: "directory",
                directory: project.instance.directory(),
                subdirectory: project.instance.directory() !== project.instance.path().worktree,
              })
        }
        onCurrentChange={(selection) => homeDestination?.setDestination(selection)}
        onSelect={(selection) => {
          const sessionID = input.sessionID()
          if (!sessionID) {
            homeDestination?.setDestination(selection)
            dialog.clear()
            return
          }
          void moveExistingSession(sessionID, selection)
        }}
      />
    ))
  }

  async function moveExistingSession(sessionID: string, selection: MoveSessionSelection) {
    const session = sync.session.get(sessionID)
    const status = await sdk.client.vcs.status({ directory: session?.directory }).catch(() => undefined)
    const choice = status?.data?.length ? await DialogWorkspaceFileChanges.show(dialog, status.data) : "no"
    if (!choice) return
    dialog.clear()
    const directory = selection.type === "new" ? await create(selection.name) : selection.directory
    if (!directory) {
      setProgress(undefined)
      dialog.clear()
      return
    }
    setProgress("Moving session")
    try {
      await sdk.api.session.move({ sessionID, destination: { directory }, moveChanges: choice === "yes" })
      await sdk.api.session.synthetic({ sessionID, text: moveReminderText(directory) }).catch(() => undefined)
      dialog.clear()
    } catch (error) {
      toast.error(error)
      dialog.clear()
    } finally {
      setProgress(undefined)
      setCreating(false)
    }
  }

  const pending = createMemo(() => Boolean(homeDestination?.destination()))
  const pendingNew = createMemo(() => homeDestination?.destination()?.type === "new")

  async function getDirectory() {
    const value = homeDestination?.destination()
    if (!value) return
    if (value.type === "directory") {
      return value.directory
    }
    return await create(value.name)
  }

  function startSubmit() {
    if (progress()) setProgress("Submitting prompt")
  }

  function finishSubmit() {
    homeDestination?.clear()
    setProgress(undefined)
    setCreating(false)
  }

  createEffect(() => {
    if (!creating()) {
      setCreatingDots(3)
      return
    }
    const timer = setInterval(() => setCreatingDots((dots) => (dots % 3) + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return {
    creating,
    creatingDots,
    finishSubmit,
    getDirectory,
    open,
    pending,
    pendingNew,
    progress,
    startSubmit,
  }
}
