import * as vscode from 'vscode'

import { SourceMapConsumer, RawSourceMap } from 'source-map'
import got from 'got'
import { JsonPatchDescription } from './configurationType'
import { fsExists } from '@zardoy/vscode-utils/build/fs'
import { applyUserPatchToText, getLineCharacterPosition } from './textUtils'

const injectMarkers = ['/*cvpS*/', '/*cvpE*/'] as const

let fetchedMapContent: RawSourceMap

export const doPatch = async (allPatches: JsonPatchDescription['patches'], inspectInstead?: string[]) => {
    if (!allPatches.length && !inspectInstead) return

    function getSourceMap(fileSource: string) {
        const sourceIndex = fetchedMapContent.sources.findIndex(source => source.endsWith(fileSource))
        if (sourceIndex === -1) throw new Error('Source file not found')

        const originalContent = fetchedMapContent.sourcesContent![sourceIndex]
        return { originalContent, sourceIndex }
    }

    const getGeneratedOffset = (fileSource: string, offsetOrNeedles: number | string[]) => {
        const { originalContent, sourceIndex } = getSourceMap(fileSource)

        const pos = getLineCharacterPosition(
            typeof offsetOrNeedles === 'number' ? offsetOrNeedles : findOffset(originalContent!, offsetOrNeedles),
            originalContent!,
        )

        let result: number | undefined
        // probably not that effective
        c.eachMapping(e => {
            if (e.source !== fetchedMapContent.sources[sourceIndex]) return
            if (e.originalLine !== pos[0] + 1) return
            if (e.originalLine === pos[0] + 1 && e.originalColumn === pos[1]) {
                result = positionToOffset(text, e.generatedLine - 1, e.generatedColumn)
            }
        })
        if (result === undefined) throw new Error(`Couldn't find generated position in ${fileSource} for ${offsetOrNeedles}`)
        return result
    }

    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), 'out/vs/workbench/workbench.desktop.main.js')

    const fileBackupUri = fileUri.with({
        path: fileUri.path + '.backup',
    })

    if (!(await fsExists(fileBackupUri))) {
        await vscode.workspace.fs.copy(fileUri, fileBackupUri)
    }

    let text = await vscode.workspace.fs.readFile(fileBackupUri).then(String)

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading source map for workbench.js patching',
        },
        async () => {
            fetchedMapContent ??= JSON.parse(await getSourceMapsFromText(text)) as RawSourceMap
        },
    )

    const c = await new SourceMapConsumer(fetchedMapContent)

    if (inspectInstead) {
        const offset = getGeneratedOffset(inspectInstead[0]!, inspectInstead.slice(1))
        const document = await vscode.workspace.openTextDocument(fileUri)
        const pos = document.positionAt(offset)
        await vscode.window.showTextDocument(document, { selection: new vscode.Selection(pos, pos) })
        return
    }

    for (const patch of allPatches) {
        const { patches, file } = patch
        for (const [i, patch] of patches.entries()) {
            text =
                applyUserPatchToText(file || i.toString(), text, patch, needles => {
                    const offset = getGeneratedOffset(file, needles)
                    const name = text.slice(offset).match(/^[a-zA-Z0-9_$]+/)?.[0]
                    if (!name) throw new Error('Generated offset not a valid identifier')
                    return { name, offset }
                }) ?? text
        }
    }

    // write text
    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(text))

    if (vscode.extensions.getExtension('lehni.vscode-fix-checksums')) {
        await vscode.commands.executeCommand('fixChecksums.apply')
    }
}

const findOffset = (text: string, needles: string[]) => {
    let prevOffset = -1
    for (const p of needles) {
        prevOffset = text.indexOf(p, prevOffset)
        if (prevOffset === -1) throw new Error(`Cannot find ${p} in source`)
    }

    return prevOffset
}

function positionToOffset(text: string, line: number, character: number): number | undefined {
    let lineIndex = 0
    let charIndex = 0

    for (let i = 0; i < text.length; i++) {
        // check if we've reached the desired line and character position
        if (lineIndex === line && charIndex === character) {
            return i
        }

        // increment our line/character index as we iterate over the text
        if (text[i] === '\n' || text[i] === '\r\n') {
            lineIndex++
            charIndex = 0
        } else {
            charIndex++
        }
    }

    // return the length of the text if the position is not found
    return undefined
}

async function getSourceMapsFromText(text: string) {
    const smNeedle = '//# sourceMappingURL='
    const sourcemapUrl = text.slice(text.lastIndexOf(smNeedle) + smNeedle.length).slice()
    // todo write to fs (cache) for subseq offline patching
    const { body } = await got(sourcemapUrl, {})
    return body
}
