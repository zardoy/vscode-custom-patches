import { FileJsonPatch } from './configurationType'

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
    { search, insertText, insertOffset = 0, removeRange, removeRangeAfter, patchOptional, insertMode = 'after' }: FileJsonPatch,
    findInSource?: (needles: string[]) => { name: string; offset: number },
) => {
    if (!search.length) throw new Error('Patch must have at least one search string.')
    let lastSourceNeedleIndex = -1
    const sourceNeedles = [] as string[]
    const regularNeedles = [] as string[]
    for (const [i, item] of (Array.isArray(search) ? search : [search]).entries()) {
        if (!findInSource || !item.startsWith('{{') || !item.endsWith('}}')) {
            regularNeedles.push(item)
            continue
        }

        if (lastSourceNeedleIndex !== i - 1) throw new Error('Source needle must not be followed by regular needle.')
        lastSourceNeedleIndex = i
        sourceNeedles.push(item.slice(2, -2))
    }

    const lastSearch = Array.isArray(search) ? search.at(-1)! : search
    const lastSourceNeedle = findInSource!(sourceNeedles)
    let curIndex = sourceNeedles.length ? lastSourceNeedle.offset : -1
    let lastNeedleLength = regularNeedles.at(-1)?.length ?? lastSourceNeedle.name.length
    for (const s of regularNeedles) {
        const newIndexStart = curIndex + 1
        curIndex = newIndexStart + text.indexOf(s, newIndexStart)
    }

    if (curIndex === -1) {
        if (patchOptional) return
        else throw new Error(`Failed to find patch string ${JSON.stringify(search)} in file ${fileName}`)
    }

    if (removeRange) {
        text = text.slice(0, curIndex + removeRange[0]) + text.slice(curIndex + removeRange[1])
    }
    if (removeRangeAfter) {
        text = text.slice(0, curIndex + lastNeedleLength + removeRangeAfter[0]) + text.slice(curIndex + lastNeedleLength + removeRangeAfter[1])
    }

    if (insertText) {
        if (findInSource) {
            insertText.replace(/{{(.*?)}}/g, (_, needle) => {
                const { name } = findInSource!([...sourceNeedles, needle])
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
    }

    return text
}
