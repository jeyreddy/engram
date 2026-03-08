const path = require('path')
const os   = require('os')
const fs   = require('fs')

const dbPath = path.join(
  os.homedir(), 'AppData', 'Roaming',
  'engram', 'engram-workspace', 'engram.db'
)

async function main() {
  const initSqlJs = require('./node_modules/sql.js')
  const SQL = await initSqlJs()
  const buf = fs.readFileSync(dbPath)
  const db  = new SQL.Database(buf)
  const res = db.exec(
    'SELECT key, value FROM workspace_config ORDER BY key'
  )
  if (res.length === 0) {
    console.log('No config found')
    return
  }
  const rows = res[0].values
  for (const row of rows) {
    console.log(row[0], '=', row[1])
  }
}
main().catch(console.error)
