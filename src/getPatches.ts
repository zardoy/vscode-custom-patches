import { extensionCtx, getExtensionSetting } from 'vscode-framework'
import { JsonPatchDescription } from './configurationType'

export type DownloadedPatchesStore = {
    [url: string]: JsonPatchDescription
}

export default (type: 'local' | 'remote', target: 'extensions' | 'core') => {
    const patchPacketsDesc =
        type === 'local' ? getExtensionSetting('localPatches') : extensionCtx.globalState.get<DownloadedPatchesStore>('downloaded-patches', {})

    const patchPackets = Array.isArray(patchPacketsDesc) ? patchPacketsDesc : Object.values(patchPacketsDesc)

    return patchPackets.filter(patch => {
        if (target === 'extensions') return 'extension' in patch.target
        else return 'workbenchJs' in patch.target && patch.target.workbenchJs
    })
}
