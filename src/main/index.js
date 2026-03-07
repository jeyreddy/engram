import { app, BrowserWindow } from "electron"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let mainWindow

function createWindow() {
  console.log("Creating window...")
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: "#020810",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    title: "ENGRAM"
  })
  mainWindow.loadURL("http://localhost:5173")
  mainWindow.webContents.openDevTools()
  console.log("Window created and loading URL")
}

app.whenReady().then(async () => {
  console.log("App ready - creating window first")
  createWindow()

  try {
    console.log("Loading modules...")
    const { initDB } = await import("../db/schema.js")
    const { getConfig, setConfig } = await import("../db/workspace.js")
    const { initVectorStore } = await import("../ai/vectorstore.js")
    const { initRepo } = await import("../git/engine.js")
    const { registerIPCHandlers } = await import("./ipc.js")
    const { startMCPServer } = await import("../mcp/server.js")
    const { runRulesForAll } = await import("../rules/engine.js")

    const workspacePath = path.join(app.getPath("userData"), "engram-workspace")
    const dbPath = path.join(workspacePath, "engram.db")
    const indexPath = path.join(workspacePath, "vectorindex")

    console.log("Workspace path:", workspacePath)

    const db = await initDB(dbPath)
    console.log("DB ready")

    if (!getConfig(db, "workspace_initialised") && process.env.ENGRAM_ENGINEER_NAME) {
      const envMap = {
        engineer_name:  process.env.ENGRAM_ENGINEER_NAME,
        engineer_email: process.env.ENGRAM_ENGINEER_EMAIL,
        plant_name:     process.env.ENGRAM_PLANT_NAME,
        area:           process.env.ENGRAM_AREA,
        api_key:        process.env.ENGRAM_API_KEY,
      }
      for (const [key, val] of Object.entries(envMap)) {
        if (val) setConfig(db, key, val)
      }
      setConfig(db, "workspace_initialised", "1")
      console.log("Workspace auto-configured from environment variables")
    }
    const store = await initVectorStore(indexPath)
    console.log("Vector store ready")
    await initRepo(workspacePath, db)
    console.log("Git repo ready")
    registerIPCHandlers(db, store, workspacePath)
    console.log("IPC handlers registered")
    startMCPServer(db, store)
    setImmediate(() => runRulesForAll(db).catch(() => {}))
    console.log("Bootstrap complete")
  } catch (err) {
    console.error("Bootstrap error:", err.message)
    console.error(err.stack)
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
