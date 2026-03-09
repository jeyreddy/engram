const path = require("path")
const os = require("os")
const fs = require("fs")

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "engram", "engram-workspace", "engram.db")

async function main() {
  const SQL = await require("./node_modules/sql.js")()
  const buf = fs.readFileSync(dbPath)
  const db = new SQL.Database(buf)
  db.run("INSERT OR REPLACE INTO workspace_config(key,value) VALUES(?,?)", ["claude_api_key", process.argv[2]])
  fs.writeFileSync(dbPath, db.export())
  console.log("API key saved")
}
main().catch(console.error)
