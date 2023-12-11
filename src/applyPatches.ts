/* eslint-disable sonarjs/no-duplicate-string */
import * as vscode from 'vscode'

import crypto from 'crypto'
import got from 'got'
import { extensionCtx, getExtensionSetting, registerExtensionCommand, showQuickPick } from 'vscode-framework'
import stripJsonComments from 'strip-json-comments'
import isOnline from 'is-online'
import { friendlyNotification } from '@zardoy/vscode-utils/build/ui'
import { Utils } from 'vscode-uri'
import { fsExists } from '@zardoy/vscode-utils/build/fs'
import { watchExtensionSettings } from '@zardoy/vscode-utils/build/settings'
import _ from 'lodash'
import getPatches, { type DownloadedPatchesStore } from './getPatches'
import { doPatch } from './builtinCorePatch'
import { applyUserPatchToText } from './textUtils'
import { type JsonPatchDescription } from './configurationType'

const updateRemotePatches = async () => {
    const allRemotePatches = getExtensionSetting('remotePatches')
    if (allRemotePatches.length === 0) return
    const downloadedPatchesState = extensionCtx.globalState.get('downloaded-patches', {})
    const notDownloadedPatches = allRemotePatches.filter(url => !downloadedPatchesState[url])
    if (notDownloadedPatches.length === 0) {
        const updatePeriod = getExtensionSetting('updatePeriod')
        if (updatePeriod === 'never') return
        const lastUpdate = extensionCtx.globalState.get('last-update', 0)
        const ONE_DAY = 60 * 60 * 1000
        if (updatePeriod === 'daily' && Date.now() - lastUpdate < 24 * ONE_DAY) return
        if (updatePeriod === 'weekly' && Date.now() - lastUpdate < 7 * 24 * ONE_DAY) return
        if (updatePeriod === 'monthly' && Date.now() - lastUpdate < 30 * 24 * ONE_DAY) return
    }

    if (!(await isOnline())) {
        await friendlyNotification('You need an internet connection to download patches', 'no-internet', 'warn')
        return
    }

    // todo also sync hashes of downloaded patches to ensure there is no desync between machines
    const downloadedPatches = {} as DownloadedPatchesStore
    const failed = [] as string[]
    for (const remoteUrl of allRemotePatches) {
        try {
            const { body } = await got(remoteUrl)
            downloadedPatches[remoteUrl] = JSON.parse(stripJsonComments(body))
        } catch (err) {
            failed.push(err.message)
            console.error(err)
        }
    }

    if (failed.length > 0) {
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
    constructor(message: string) {
        super(message)
        this.name = 'PatchSyntaxError'
    }

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
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        packageJSON: require(Utils.joinPath(uri, 'package.json').fsPath),
        isActive: false,
    }
}

const appliedPatchesPackageJsonKey = 'customPatches-appliedPatches'
// eslint-disable-next-line complexity
const applyPatches = async (type: 'local' | 'remote') => {
    const silentPatchErrors = getExtensionSetting('silentPatchErrors')
    const { fs } = vscode.workspace

    const patchPackets = getPatches(type, 'extensions')

    let needsExtensionHostRestart = false
    let appliedPatches = 0
    const patchPacketsByExt = {} as Record<string, JsonPatchDescription[]>
    for (const packetPatch of patchPackets) {
        if (!('extension' in packetPatch.target) || !packetPatch.target?.extension) throw new PatchSyntaxError('Patch must target with extension!')
        const extensions = packetPatch.target.extension
        for (const extension of Array.isArray(extensions) ? extensions : [extensions]) {
            patchPacketsByExt[extension] ??= []
            patchPacketsByExt[extension]!.push(packetPatch)
        }
    }

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
        for (const packetPatch of packetPatches) {
            const patchHash = `${type}-${crypto.createHash('md5').update(JSON.stringify(packetPatch)).digest('hex')}`
            const checkSkipPatch = packageJson => {
                if (packageJson[appliedPatchesPackageJsonKey]?.[patchHash]) {
                    console.log(`Skipping patch ${patchHash} for ${extId} because it was already applied.`)
                    return true
                }

                return false
            }

            if (checkSkipPatch(ext.packageJSON)) {
                continue
            }

            // double check that patch is not already applied, it will be happening until next window reload, so it should't be a performance issue
            const actualPackageJson = JSON.parse(await fs.readFile(Utils.joinPath(ext.extensionUri, 'package.json')).then(buf => buf.toString()))
            if (checkSkipPatch(actualPackageJson)) {
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
                    } catch {
                        fileContents = undefined
                    }

                    if (fileContents === undefined) {
                        if (fileCanBeMissing) continue
                        else throw new Error(`Required file to patch ${file} is missing`)
                    }

                    if (patches.length === 0) continue

                    const backupFile = targetFileUri.with({
                        path: `${targetFileUri.path}.backup`,
                    })

                    if (!(await fsExists(backupFile))) {
                        await fs.writeFile(backupFile, new TextEncoder().encode(fileContents))
                    }

                    for (const patch of patches) {
                        fileContents = applyUserPatchToText(file, fileContents, patch) ?? fileContents
                    }

                    patchedFiles.push(file)
                    await fs.writeFile(targetFileUri, new TextEncoder().encode(fileContents))
                }

                addPatchHashes[patchHash] = patchedFiles
                console.log(`Applied patch i=${i}: ${patchHash} for ${extId}`)
                appliedPatches++

                if (ext.isActive) needsExtensionHostRestart = true
            } catch (err) {
                console.error(`Failed to apply patch i=${i}: ${patchHash} for ${extId}`)
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
        await extensionCtx.globalState.update('patched-extensions', [...patchedExtensions, extId])
    }

    if (appliedPatches) {
        if (needsExtensionHostRestart) {
            // todo save output to globalState before restarting
            if (getExtensionSetting('restartExtHost') === 'manual') {
                const choice = await vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches.`, 'Restart extension host')
                if (choice === 'Restart extension host') {
                    void vscode.commands.executeCommand('workbench.action.restartExtensionHost')
                }
            } else {
                void vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches. Restarting extension host...`)
                void vscode.commands.executeCommand('workbench.action.restartExtensionHost')
            }
        } else {
            void vscode.window.showInformationMessage(`Applied ${appliedPatches} extension patches.`)
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
            await updateRemotePatches()
        }

        await applyPatches(key === 'localPatches' ? 'local' : 'remote')
    })

    registerExtensionCommand('unpatchExtensions', () => {
        const quickPick = vscode.window.createQuickPick()
        const extensions = _.uniq(extensionCtx.globalState.get('patched-extensions', [] as string[]))
        quickPick.items = extensions.map(extId => {
            const ext = vscode.extensions.getExtension(extId)
            return {
                label: `${extId}${ext ? '' : ' (disabled)'}`,
            }
        })
        // {
        //     label: 'Unpatch all',
        // }

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
            await extensionCtx.globalState.update(
                'patched-extensions',
                patchedExtensions.filter(id => id !== extId),
            )
            const packageJsonUri = Utils.joinPath(ext.extensionUri, 'package.json')
            const json = await vscode.workspace.fs.readFile(packageJsonUri).then(buf => JSON.parse(buf.toString()))
            const paths = _.uniq(Object.values(json[appliedPatchesPackageJsonKey]).flat()) as string[]
            for (const path of paths) {
                console.log('restoring backup', path)
                await vscode.workspace.fs.rename(Utils.joinPath(ext.extensionUri, `${path}.backup`), Utils.joinPath(ext.extensionUri, path), {
                    overwrite: true,
                })
            }

            json[appliedPatchesPackageJsonKey] = {}
            // write back json
            await vscode.workspace.fs.writeFile(packageJsonUri, new TextEncoder().encode(JSON.stringify(json, undefined, 4)))
            quickPick.hide()
        })
        quickPick.show()
    })

    registerExtensionCommand('applyWorkbenchJsPatches', async () => {
        const patchPackets = [...getPatches('local', 'core'), ...getPatches('remote', 'core')]

        try {
            await doPatch(patchPackets.flatMap(patchPacket => patchPacket.patches))
        } catch (err) {
            console.error(err)
            void vscode.window.showErrorMessage(err.message)
        }
    })

    registerExtensionCommand('inspectWorkbenchJsPatchLocation', async () => {
        const userInput = await vscode.window.showInputBox({
            title: 'Inspect generated location. Format: source-file-relative-path source-needle1 source-needle2 ...',
            placeHolder: 'src/vs/platform/quickinput/browser/quickInput.ts _sortByLabel',
        })
        if (!userInput) return

        await doPatch([], userInput.split(' '))
    })
}
