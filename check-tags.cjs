const path = require("path")
const os = require("os")
const fs = require("fs")

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "engram", "engram-workspace", "engram.db")

async function main() {
  const SQL = await require("./node_modules/sql.js")()
  const buf = fs.readFileSync(dbPath)
  const db = new SQL.Database(buf)
  
  // Show documents table columns
  const cols = db.exec("PRAGMA table_info(documents)")
  console.log("DOCUMENTS COLUMNS:")
  cols[0]?.values.forEach(r => console.log(" ", r[1]))
  
  // Show all documents
  const docs = db.exec("SELECT * FROM documents LIMIT 5")
  console.log("\nDOCUMENTS SAMPLE:")
  if (docs[0]) {
    console.log("cols:", docs[0].columns)
    docs[0].values.forEach(r => console.log(" ", r))
  }
  
  // Show extracted_values columns
  const evcols = db.exec("PRAGMA table_info(extracted_values)")
  console.log("\nEXTRACTED_VALUES COLUMNS:")
  evcols[0]?.values.forEach(r => console.log(" ", r[1]))
  
  // Show field names
  const fields = db.exec(`
    SELECT DISTINCT field_name, COUNT(*) as cnt
    FROM extracted_values 
    GROUP BY field_name
    ORDER BY cnt DESC
    LIMIT 30
  `)
  console.log("\nFIELD NAMES:")
  fields[0]?.values.forEach(r => console.log(" ", r[1], "x", r[0]))
}
main().catch(console.error)
