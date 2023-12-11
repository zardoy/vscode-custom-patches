import { it, expect } from 'vitest'
import { applyUserPatchToText } from './textUtils'

const worldUniverseText = 'Hello world, testing world, ok?'

it('World -> universe', () => {
    expect(
        applyUserPatchToText('', worldUniverseText, {
            search: 'world',
            insertText: 'universe',
            insertMode: 'replace',
        }),
    ).toMatchInlineSnapshot(`"Hello universe, testing world, ok?"`)
})

it('World -> universe (multiple)', () => {
    expect(
        applyUserPatchToText('', worldUniverseText, {
            search: 'world',
            insertText: 'universe',
            insertMode: 'replace',
            searchMode: 'multiple',
        }),
    ).toMatchInlineSnapshot(`"Hello universe, testing universe, ok?"`)
})

it('World -> universe (multiple, removeRange)', () => {
    expect(
        applyUserPatchToText('', worldUniverseText, {
            search: 'world',
            insertText: 'universe',
            insertMode: 'replace',
            searchMode: 'multiple',
            removeRange: [0, 1],
        }),
    ).toMatchInlineSnapshot(`"Hello universe testing universe ok?"`)
})

it('Error when not found', () => {
    const text = 'Hello world, testing world, ok?'
    expect(() =>
        applyUserPatchToText('', text, {
            search: ['world', 'universe'],
            insertText: 'universe',
        }),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: Failed to find patch string "universe" from search query ["world","universe"] in file ]`)
})

it('Multiple search queries', () => {
    expect(
        applyUserPatchToText('', worldUniverseText, {
            search: ['world', 'world'],
            insertText: 'universe',
            insertMode: 'replace',
            searchMode: 'multiple',
        }),
    ).toMatchInlineSnapshot(`"Hello world, testing universe, ok?"`)
})
