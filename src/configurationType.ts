export type Configuration = {
    remotePatches: string[]
    /**
     * @default weekly
     */
    updatePeriod: 'daily' | 'weekly' | 'monthly' | 'never'
    localPatches: JsonPatchDescription[]
    /**
     * @default false
     */
    silentPatchErrors: boolean
    /**
     * @default auto
     */
    restartExtHost: 'auto' | 'manual'
}

export type FileJsonPatch = {
    /** Can be regex if searchMode is regex and the part start with `/` e.g. `/require\(['"]vscode['"]\)/` (note that json require double backward slashes). It does support flags e.g. g for multiple */
    search: string | string[]
    /**
     * @default single
     */
    searchMode?: 'single' | 'multiple' | 'regex'
    /**
     * Applied after removeRange is applied
     */
    insertText?: string
    /**
     * @default after
     */
    insertMode?: 'before' | 'after' | 'replace'
    /**
     * @default 0
     */
    insertOffset?: number
    /**
     * Remove range [start, end] that applied before insertText
     * Ranges are computed from the start of the last search string offset
     */
    removeRange?: [startOffset: number, endOffset: number]
    /**
     * The same as removeRange but ranges are computed from the end of the last search string offset
     */
    removeRangeAfter?: [startOffset: number, endOffset: number]
    /** @default false */
    patchOptional?: boolean
    // enableIf: string
}

export type JsonPatchDescription = {
    target:
        | {
              extension: string | string[]
          }
        | {
              workbenchJs: true
          }
    // settings: {
    //     [key: string]: {
    //         /** @default false */
    //         default?: boolean
    //     }
    // }
    patches: Array<{
        file: string
        /** @default false */
        fileCanBeMissing?: boolean
        patches: FileJsonPatch[]
    }>
}
