//@ts-check
const { defineConfig } = require('@zardoy/vscode-utils/build/defineConfig.cjs')
const { patchPackageJson } = require('@zardoy/vscode-utils/build/patchPackageJson.cjs')
const fs = require('fs')

fs.mkdirSync('./out', { recursive: true })
fs.copyFileSync('./node_modules/source-map/lib/mappings.wasm', './out/mappings.wasm')

patchPackageJson({})

module.exports = defineConfig({})
