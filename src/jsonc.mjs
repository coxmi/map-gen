import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// a regex cannot tell a comment from a // inside a string, so walk the text and
// only look for comment markers outside quotes
function stripComments(text) {
    let out = ''
    let quoted = false

    for (let i = 0; i < text.length; i++) {
        const char = text[i]

        if (quoted) {
            out += char
            if (char === '\\') out += text[++i] ?? ''
            else if (char === '"') quoted = false
            continue
        }
        if (char === '"') {
            quoted = true
            out += char
            continue
        }
        if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++
            out += '\n'
            continue
        }
        if (char === '/' && text[i + 1] === '*') {
            i += 2
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
            i++
            continue
        }
        out += char
    }

    return out
}

export function parseJsonc(text) {
    return JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'))
}

export async function readConfig(file) {
    try {
        return parseJsonc(await fs.readFile(path.resolve(file), 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
        // echo the path as it was typed, a resolved one is harder to match up.
        // point at the example by its real path, which survives being installed
        const example = fileURLToPath(new URL('maps.example.jsonc', import.meta.url))
        throw new Error(`no config at ${file}, copy ${example} to get started`)
    }
}
