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

type FileJsonPatch = {
    search: string | string[]
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
    removeRange?: [startOffset: number, endOffset: number]
    /** @default false */
    patchOptional?: boolean
    // enableIf: string
}

export type JsonPatchDescription = {
    target: {
        extension: string
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
