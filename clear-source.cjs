const path = require("path")
const os = require("os")
const fs = require("fs")

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "engram", "engram-workspace", "engram.db")

async function main() {
  const initSqlJs = require("./node_modules/sql.js")
  const SQL = await initSqlJs()
  const buf = fs.readFileSync(dbPath)
  const db = new SQL.Database(buf)
  db.run("UPDATE workspace_config SET value = ? WHERE key = ?", ["[]", "source_paths"])
  const data = db.export()
  fs.writeFileSync(dbPath, data)
  console.log("Source paths cleared successfully")
  
  const check = db.exec("SELECT value FROM workspace_config WHERE key = ?", ["source_paths"])
  console.log("New value:", check[0]?.values[0][0])
}

main().catch(console.error)
