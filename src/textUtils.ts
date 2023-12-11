import type { FileJsonPatch } from './configurationType'

export function getLineCharacterPosition(offset: number, text: string): [number, number] {
    let lineNumber = 0
    let characterNumber = 0

    for (let i = 0; i < offset; i++) {
        if (text[i] === '\n') {
            lineNumber++
            characterNumber = 0
        } else {
            characterNumber++
        }
    }

    return [lineNumber, characterNumber]
}

export const applyUserPatchToText = (
    fileName: string,
    text: string,
    { search, searchMode, insertText, insertOffset = 0, removeRange, removeRangeAfter, patchOptional, insertMode = 'after' }: FileJsonPatch,
    findInSource?: (needles: string[]) => { name: string; offset: number },
) => {
    if (search.length === 0) throw new Error('Patch must have at least one search string.')
    let lastSourceNeedleIndex = -1
    const sourcemapNeedles = [] as string[]
    const regularNeedles = [] as string[]
    for (const [i, item] of (Array.isArray(search) ? search : [search]).entries()) {
        if (!findInSource || !item.startsWith('{{') || !item.endsWith('}}')) {
            regularNeedles.push(item)
            continue
        }

        if (lastSourceNeedleIndex !== i - 1) throw new Error('Sourcemap needle must not be followed by a regular needle.')
        lastSourceNeedleIndex = i
        sourcemapNeedles.push(item.slice(2, -2))
    }

    const lastSourceNeedle = sourcemapNeedles.length > 0 ? findInSource!(sourcemapNeedles) : undefined
    const foundIndexes = [] as number[]

    const findNextIndex = (isFirst: boolean) => {
        let curIndex = isFirst ? lastSourceNeedle?.offset ?? -1 : foundIndexes.at(-1)!
        let curSearchQuery: string
        for (const s of regularNeedles) {
            const newIndexStart = curIndex + 1
            curIndex = text.indexOf(s, newIndexStart)
            curSearchQuery = s
            if (curIndex === -1) break
        }

        if (curIndex === -1) {
            if (!isFirst || patchOptional) return false
            throw new Error(`Failed to find patch string "${curSearchQuery!}" from search query ${JSON.stringify(search)} in file ${fileName}`)
        }

        foundIndexes.push(curIndex)
        return true
    }

    findNextIndex(true)
    let continueWhile = true
    if (searchMode === 'multiple') {
        while (continueWhile) {
            continueWhile = findNextIndex(false)
        }
    }

    const lastNeedleLength = regularNeedles.at(-1)?.length ?? lastSourceNeedle!.name.length
    for (const [i, curIndex] of foundIndexes.entries()) {
        const patchLaterIndexes = (offset: number) => {
            for (let j = i + 1; j < foundIndexes.length; j++) {
                foundIndexes[j] += offset
            }
        }

        if (removeRange) {
            text = text.slice(0, curIndex + removeRange[0]) + text.slice(curIndex + removeRange[1])
            patchLaterIndexes(-removeRange[1] + removeRange[0])
        }

        if (removeRangeAfter) {
            text = text.slice(0, curIndex + lastNeedleLength + removeRangeAfter[0]) + text.slice(curIndex + lastNeedleLength + removeRangeAfter[1])
            patchLaterIndexes(-removeRangeAfter[1] + removeRangeAfter[0])
        }

        if (insertText) {
            if (findInSource) {
                insertText.replaceAll(/{{(.*?)}}/g, (_, needle) => {
                    const { name } = findInSource([...sourcemapNeedles, needle])
                    return name
                })
            }

            let beforeIndex = curIndex + insertOffset
            if (insertMode === 'after') {
                beforeIndex += lastNeedleLength
            }

            let afterIndex = beforeIndex
            if (insertMode === 'replace') {
                afterIndex += lastNeedleLength
            }

            text = text.slice(0, beforeIndex) + insertText + text.slice(afterIndex)
            patchLaterIndexes(insertText.length - (afterIndex - beforeIndex))
        }
    }

    return text
}
