import * as vscode from 'vscode'

import got from 'got'
import { extensionCtx, getExtensionSetting, registerExtensionCommand, showQuickPick } from 'vscode-framework'
import stripJsonComments from 'strip-json-comments'
import { JsonPatchDescription } from './configurationType'
import isOnline from 'is-online'
import { friendlyNotification } from '@zardoy/vscode-utils/build/ui'
import { Utils } from 'vscode-uri'
import crypto from 'crypto'
import { fsExists } from '@zardoy/vscode-utils/build/fs'
import { watchExtensionSettings } from '@zardoy/vscode-utils/build/settings'
import _ from 'lodash'

type DownloadedPatchesStore = {
    [url: string]: JsonPatchDescription
}
const updateRemotePatches = async (force = false) => {
    const toDownload = getExtensionSetting('remotePatches')
    if (!toDownload.length) return
    if (!force) {
        const updatePeriod = getExtensionSetting('updatePeriod')
        if (updatePeriod === 'never') return
        const lastUpdate = extensionCtx.globalState.get('last-update', 0)
        const ONE_DAY = 60 * 60 * 1000
        if (updatePeriod === 'daily' && Date.now() - lastUpdate < 24 * ONE_DAY) return
        if (updatePeriod === 'weekly' && Date.now() - lastUpdate < 7 * 24 * ONE_DAY) return
        if (updatePeriod === 'monthly' && Date.now() - lastUpdate < 30 * 24 * ONE_DAY) return
    }

    // note: it doesn't work
    if (!isOnline()) {
        await friendlyNotification('You need an internet connection to download patches', 'no-internet', 'warn')
        return
    }
    // todo also sync hashes of downloaded patches to ensure there is no desync between machines
    const downloadedPatches = {} as DownloadedPatchesStore
    const failed = [] as string[]
    for (const remoteUrl of toDownload) {
        try {
            const { body } = await got(remoteUrl)
            downloadedPatches[remoteUrl] = JSON.parse(stripJsonComments(body))
        } catch (err) {
            failed.push(err.message)
            console.error(err)
        }
    }
    if (failed.length) {
        const action = await friendlyNotification(
            `Failed to download ${failed.length} patches, see output for more info`,
            'download-fail',
            'error',
            10_000,
            'Show output',
        )
        if (action === 'Show output') {
            console.show(true)
        }
    }
    await extensionCtx.globalState.update('last-update', Date.now())
    await extensionCtx.globalState.update('downloaded-patches', downloadedPatches)
}

class PatchSyntaxError extends Error {
    override name = 'PatchSyntaxError'
}

const devExtPathMap = {}

type ExtInterface = Pick<vscode.Extension<any>, 'extensionUri' | 'packageJSON' | 'isActive'>
const getDevExt = (id: string): ExtInterface | undefined => {
    const path = devExtPathMap[id]
    if (!path) return
    const uri = vscode.Uri.file(path)
    return {
        extensionUri: uri,
        packageJSON: require(Utils.joinPath(uri, 'package.json').fsPath),
        isActive: false,
    }
}

const appliedPatchesPackageJsonKey = 'customPatches-appliedPatches'
const applyPatches = async (type: 'local' | 'remote') => {
    const silentPatchErrors = getExtensionSetting('silentPatchErrors')
    const patchPackets = type === 'local' ? getExtensionSetting('localPatches') : extensionCtx.globalState.get<DownloadedPatchesStore>('downloaded-patches', {})
    const { fs } = vscode.workspace

    let needsExtensionHostRestart = false
    let appliedPatches = 0
    const patchPacketsByExt = _.groupBy(Array.isArray(patchPackets) ? patchPackets : Object.values(patchPackets), ({ target }) => {
        if (!target?.extension) throw new PatchSyntaxError('Patch must target with extension!')
        return target.extension
    })
    let i = -1
    for (const [extId, packetPatches] of Object.entries(patchPacketsByExt)) {
        i++
        // extension is disabled
        const ext: ExtInterface | undefined = vscode.extensions.getExtension(extId) ?? getDevExt(extId)
        if (!ext) {
            console.log(`Skipping patch for ${extId} because it is disabled/not installed.`)
            continue
        }
        const addPatchHashes = {} as Record<string, string[]>
        if (ext.isActive) needsExtensionHostRestart = true
        for (const packetPatch of packetPatches) {
            const patchHash = `${type}-${crypto.createHash('md5').update(JSON.stringify(packetPatch)).digest('hex')}`
            if (ext.packageJSON[appliedPatchesPackageJsonKey]?.[patchHash]) {
                console.log(`Skipping patch ${patchHash} for ${extId} because it was already applied.`)
                continue
            }
            try {
                const patchedFiles = [] as string[]
                for (const { file, patches, fileCanBeMissing } of packetPatch.patches) {
                    let fileContents: string | undefined
                    const targetFileUri = Utils.joinPath(ext.extensionUri, file)
                    try {
                        // todo patch in parallel
                        fileContents = String(await fs.readFile(targetFileUri))
                    } catch (err) {
                        fileContents = undefined
                    }
                    if (fileContents === undefined) {
                        if (fileCanBeMissing) continue
                        else throw new Error(`Required file to patch ${file} is missing`)
                    }

                    for (const { search, insertText, insertOffset = 0, removeRange, patchOptional, insertMode = 'after' } of patches) {
                        if (!search.length) throw new Error('Patch must have at least one search string.')
                        let curIndex = -1
                        const lastSearch = Array.isArray(search) ? search.at(-1)! : search
                        for (const s of Array.isArray(search) ? search : [search]) {
                            const newIndexStart = curIndex + 1
                            curIndex = newIndexStart + fileContents.indexOf(s, newIndexStart)
                        }

                        if (curIndex === -1) {
                            if (patchOptional) continue
                            else throw new Error(`Failed to find patch string ${JSON.stringify(search)} in file ${file}`)
                        }

                        // we're going to change content below, so write backup first
                        // #region write backup file
                        const backupFile = targetFileUri.with({
                            path: `${targetFileUri.path}.backup`,
                        })
                        // todo better resolve conflicts
                        if (!(await fsExists(backupFile))) {
                            await fs.writeFile(backupFile, new TextEncoder().encode(fileContents))
                        }
                        patchedFiles.push(file)
                        // #endregion

                        if (removeRange) {
                            fileContents = fileContents.slice(0, curIndex + removeRange[0]) + fileContents.slice(curIndex + removeRange[1])
                        }

                        if (insertText) {
                            const lastSearchLength = lastSearch.length
                            let beforeIndex = curIndex + insertOffset
                            if (insertMode === 'after') {
                                beforeIndex += lastSearchLength
                            }

                            let afterIndex = beforeIndex
                            if (insertMode === 'replace') {
                                afterIndex += lastSearchLength
                            }

                            fileContents = fileContents.slice(0, beforeIndex) + insertText + fileContents.slice(afterIndex)
                        }
                    }

                    await fs.writeFile(targetFileUri, new TextEncoder().encode(fileContents))
                }

                addPatchHashes[patchHash] = patchedFiles
                console.log(`Applied patch i=${i}: ${patchHash} for ${extId}`)
                appliedPatches++
            } catch (err) {
                console.error(err)
                if (!silentPatchErrors) {
                    void vscode.window.showErrorMessage(`Failed to apply ${type} patch i=${i} for ${extId}: ${err.message}`)
                }
            }
        }
        const packageJsonUri = Utils.joinPath(ext.extensionUri, 'package.json')
        await fs.writeFile(
            packageJsonUri,
            await fs.readFile(packageJsonUri).then(buf => {
                const json = JSON.parse(buf.toString())
                // json[appliedPatchesPackageJsonKey] = [...(json[appliedPatchesPackageJsonKey] ?? {}), ...addPatchHashes]
                json[appliedPatchesPackageJsonKey] ??= {}
                Object.assign(json[appliedPatchesPackageJsonKey], addPatchHashes)
                return new TextEncoder().encode(JSON.stringify(json, undefined, 4))
            }),
        )
        const patchedExtensions = extensionCtx.globalState.get<string[]>('patched-extensions', [])
        extensionCtx.globalState.update('patched-extensions', [...patchedExtensions, extId])
    }

    if (appliedPatches) {
        if (needsExtensionHostRestart) {
            // todo save output to globalState before restarting
            if (getExtensionSetting('restartExtHost') === 'manual') {
                const choice = await vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches.`, 'Restart extension host')
                if (choice === 'Restart extension host') {
                    vscode.commands.executeCommand('workbench.action.restartExtensionHost')
                }
            } else {
                vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches. Restarting extension host...`)
                vscode.commands.executeCommand('workbench.action.restartExtensionHost')
            }
        } else {
            vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches.`)
        }
    }
}

export default async () => {
    await updateRemotePatches()
    console.time('apply-patches-startup')
    await applyPatches('remote')
    await applyPatches('local')
    console.timeEnd('apply-patches-startup')

    watchExtensionSettings(['localPatches', 'remotePatches'], async key => {
        if (key === 'remotePatches') {
            await updateRemotePatches(true)
        }
        await applyPatches(key === 'localPatches' ? 'local' : 'remote')
    })

    registerExtensionCommand('unpatchExtensions', () => {
        const quickPick = vscode.window.createQuickPick()
        const extensions = _.uniq(extensionCtx.globalState.get('patched-extensions', []))
        quickPick.items = [
            ...extensions.map(extId => {
                const ext = vscode.extensions.getExtension(extId)
                return {
                    label: `${extId}${ext ? '' : ' (disabled)'}`,
                }
            }),
            // {
            //     label: 'Unpatch all',
            // }
        ]
        quickPick.onDidHide(quickPick.dispose)
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0]
            if (!selected) return
            // if (selected.label === 'Unpatch all') {
            //     extensionCtx.globalState.update('patched-extensions', [])
            //     return
            // }
            const [extId] = selected.label.split(' ')
            const ext = vscode.extensions.getExtension(extId!) ?? getDevExt(extId!)
            if (!ext) return
            const patchedExtensions = extensionCtx.globalState.get<string[]>('patched-extensions', [])
            extensionCtx.globalState.update(
                'patched-extensions',
                patchedExtensions.filter(id => id !== extId),
            )
            const packageJsonUri = Utils.joinPath(ext.extensionUri, 'package.json')
            const json = await vscode.workspace.fs.readFile(packageJsonUri).then(buf => JSON.parse(buf.toString()))
            const paths = _.uniq(Object.values(json[appliedPatchesPackageJsonKey]).flat()) as string[]
            for (const path of paths) {
                console.log('restoring backup', path)
                vscode.workspace.fs.rename(Utils.joinPath(ext.extensionUri, path + '.backup'), Utils.joinPath(ext.extensionUri, path), { overwrite: true })
            }
            json[appliedPatchesPackageJsonKey] = {}
            // write back json
            await vscode.workspace.fs.writeFile(packageJsonUri, new TextEncoder().encode(JSON.stringify(json, undefined, 4)))
            quickPick.hide()
        })
        quickPick.show()
    })
}
