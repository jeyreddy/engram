const { app } = require("electron")

async function start() {
  const { default: main } = await import("./index.js")
}

start().catch(console.error)
